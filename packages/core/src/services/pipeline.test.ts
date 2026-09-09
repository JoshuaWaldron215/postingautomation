import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createHarness, type Harness } from "../test/harness";
import { approveCampaign, createCampaign, DEMO_TEMPLATE, previewCampaign } from "./campaigns";
import { beginSubmitting, claimJobs, expireStaleLeases, heartbeatJob, promoteDueJobs, reportResult, retryJob, markJobPublished, detectMissedSchedule } from "./jobs";
import { updateAsset } from "./content";
import { updateAccount, pauseAccounts, resumeAccounts, pauseCreator, startLoginHandoff, endLoginHandoff } from "./accounts";
import { setGlobalPause } from "./org";
import { listNotifications } from "./notifications";
import { analyticsJobs, notifications, postingJobs, verifiedPosts, accounts, workers } from "../db/schema";
import { AppError } from "../lib/errors";
import { hours, minutes } from "../lib/clock";
import { reportAnalytics, claimAnalytics, promoteDueAnalytics, maintainAnalytics } from "./analytics";
import { tickOrg } from "./scheduler";
import { closeDb } from "../db";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ slug: "pipeline", accountCount: 3, assetCount: 3, tagsByIndex: {} });
});
afterAll(async () => {
  await closeDb();
});

async function makeCampaign(accountIdx: number[], opts: { start?: string; end?: string; assets?: string[] } = {}) {
  await h.resetAccounts(accountIdx);
  const ctx = await h.operatorCtx();
  const start = opts.start ?? "2026-03-07";
  const c = await createCampaign(ctx, { name: `c-${Math.random().toString(36).slice(2, 6)}`, creatorId: null, startDate: start, endDate: opts.end ?? start, template: DEMO_TEMPLATE, accountIds: accountIdx.map((i) => h.accounts[i]!.id), assetIds: opts.assets ?? h.assetIds });
  return c;
}

describe("approval and publishing pipeline", () => {
  it("previews a plan with day-one spacing and content coverage", async () => {
    const ctx = await h.operatorCtx();
    const p = await previewCampaign(ctx, { startDate: "2026-03-07", endDate: "2026-03-07", template: DEMO_TEMPLATE, accountIds: [h.accounts[0]!.id], assetIds: h.assetIds });
    expect(p.slots).toHaveLength(3);
    expect(p.slots.every((s) => s.assetId)).toBe(true);
    expect(p.conflicts).toHaveLength(0);
  });

  it("viewers cannot create or approve campaigns; operators can", async () => {
    const v = await h.viewerCtx();
    await expect(createCampaign(v, { name: "x", startDate: "2026-03-07", endDate: "2026-03-07", template: DEMO_TEMPLATE, accountIds: [h.accounts[0]!.id], assetIds: h.assetIds })).rejects.toMatchObject({ code: "forbidden" });
    const c = await makeCampaign([0]);
    await expect(approveCampaign(v, c.id)).rejects.toMatchObject({ code: "forbidden" });
    const r = await approveCampaign(await h.operatorCtx(), c.id);
    expect(r.approvedJobs).toBe(3);
    const jobs = await h.db.select().from(postingJobs).where(eq(postingJobs.campaignId, c.id));
    expect(jobs.every((j) => j.approvalId === r.approvalId && j.approvalSnapshot?.caption.startsWith("Caption for"))).toBe(true);
    expect(jobs.map((j) => j.state).sort()).toEqual(["QUEUED", "QUEUED", "QUEUED"]);
  });

  it("holds slots without content and never recycles", async () => {
    const c = await makeCampaign([1], { assets: [h.assetIds[0]!] });
    const r = await approveCampaign(await h.operatorCtx(), c.id);
    expect(r.approvedJobs).toBe(1);
    expect(r.heldJobs).toBe(2);
    const held = await h.db.select().from(postingJobs).where(and(eq(postingJobs.campaignId, c.id), eq(postingJobs.state, "HELD")));
    expect(held).toHaveLength(2);
    expect(held.every((j) => j.assetId === null && j.errorCategory === "content_missing")).toBe(true);
    const ns = await listNotifications(await h.operatorCtx(), { kind: "content_shortage" });
    expect(ns.length).toBeGreaterThan(0);
  });

  it("publishes end to end: claim → identity gate → SUBMITTING → verified post → analytics job + notification, with min spacing", async () => {
    const c = await makeCampaign([0]);
    const opCtx = await h.operatorCtx();
    await approveCampaign(opCtx, c.id);
    h.clock.set(new Date("2026-03-07T15:00:30Z")); // day-one first slot is 10:00 NY = 15:00Z
    await h.resetAccounts([1, 2]);
    const executed = await h.runWorker(2);
    expect(executed).toBeGreaterThanOrEqual(1);
    const jobs = await h.db.select().from(postingJobs).where(eq(postingJobs.campaignId, c.id)).orderBy(postingJobs.sequence);
    expect(jobs[0]!.state).toBe("VERIFIED_PUBLISHED");
    expect(jobs[0]!.postUrl).toMatch(/instagram\.com\/reel\//);
    const vp = await h.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.jobId, jobs[0]!.id) });
    expect(vp).toBeTruthy();
    const aj = await h.db.query.analyticsJobs.findFirst({ where: eq(analyticsJobs.verifiedPostId, vp!.id) });
    expect(aj!.dueAt.getTime()).toBe(vp!.publishedAt.getTime() + hours(10));
    const n = await h.db.query.notifications.findFirst({ where: and(eq(notifications.orgId, h.orgId), eq(notifications.eventId, `post_verified:${jobs[0]!.id}`)) });
    expect(n).toBeTruthy();
    // Second day-one job must not publish within the minimum gap even though its planned time is 5 min later.
    expect(jobs[1]!.notBefore!.getTime()).toBe(vp!.publishedAt.getTime() + minutes(5));
    const acc = await h.db.query.accounts.findFirst({ where: eq(accounts.id, h.accounts[0]!.id) });
    expect(acc!.lockJobId).toBeNull();
    expect(acc!.lastVerifiedPostAt!.getTime()).toBe(vp!.publishedAt.getTime());
  });

  it("rejects stale fences and duplicate claims across concurrent workers", async () => {
    const c = await makeCampaign([2], { start: "2026-03-10" });
    await approveCampaign(await h.operatorCtx(), c.id);
    h.clock.set(new Date("2026-03-10T15:01:00Z"));
    await h.resetAccounts([0, 1]);
    const sys = await h.systemCtx();
    await promoteDueJobs(sys);
    const w = await h.workerCtx();
    const [a, b] = await Promise.all([claimJobs(w, { workerId: h.worker.id, max: 5 }), claimJobs(w, { workerId: h.worker.id, max: 5 })]);
    // The account-level lock means at most one job on the same account is claimed across both concurrent claims.
    expect(a.jobs.length + b.jobs.length).toBe(1);
    const job = (a.jobs[0] ?? b.jobs[0])!;
    await expect(heartbeatJob(w, job.jobId, job.fence + 1)).rejects.toMatchObject({ code: "stale_fence" });
    await expect(beginSubmitting(w, job.jobId, job.fence - 1, { observedHandle: job.account.handle, observedIgUserId: job.account.verifiedIgUserId, sessionReady: true })).rejects.toMatchObject({ code: "stale_fence" });
    // A different worker cannot report on this lease.
    const other = await h.ctxFor({ type: "worker", id: "00000000-0000-0000-0000-000000000000", name: "other" });
    await expect(reportResult(other, job.jobId, job.fence, { outcome: "failed", category: "network", message: "x" })).rejects.toMatchObject({ code: "forbidden" });
    // Finish it properly.
    const gate = await beginSubmitting(w, job.jobId, job.fence, { observedHandle: job.account.handle, observedIgUserId: job.account.verifiedIgUserId, sessionReady: true });
    expect(gate.ok).toBe(true);
    await reportResult(w, job.jobId, job.fence, { outcome: "verified", postUrl: "https://www.instagram.com/reel/x/", externalId: "x", publishedAt: h.clock.now().toISOString(), publishedAtSource: "worker_observed" });
  });

  it("blocks on identity mismatch and login problems before Share, and stops the account", async () => {
    const c = await makeCampaign([1], { start: "2026-03-11" });
    await approveCampaign(await h.operatorCtx(), c.id);
    h.clock.set(new Date("2026-03-11T10:01:00Z")); // London 10:00
    await promoteDueJobs(await h.systemCtx());
    const w = await h.workerCtx();
    await h.resetAccounts([0, 2]);
    const { jobs } = await claimJobs(w, { workerId: h.worker.id, max: 1 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.account.id).toBe(h.accounts[1]!.id);
    const gate = await beginSubmitting(w, jobs[0]!.jobId, jobs[0]!.fence, { observedHandle: "someone.else", observedIgUserId: "ig-999", sessionReady: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.category).toBe("account_mismatch");
    const acc = await h.db.query.accounts.findFirst({ where: eq(accounts.id, h.accounts[1]!.id) });
    expect(acc!.state).toBe("needs_review");
    // No further claims for a needs_review account.
    const again = await claimJobs(w, { workerId: h.worker.id, max: 5 });
    expect(again.jobs.filter((j) => j.account.id === h.accounts[1]!.id)).toHaveLength(0);
    // Operator retries after review: the job goes READY, then a login problem blocks it and flags needs_login.
    const op = await h.operatorCtx();
    const blocked = await h.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.campaignId, c.id), eq(postingJobs.state, "BLOCKED")) });
    await retryJob(op, blocked!.id);
    const { jobs: j2 } = await claimJobs(w, { workerId: h.worker.id, max: 1 });
    expect(j2).toHaveLength(1);
    const gate2 = await beginSubmitting(w, j2[0]!.jobId, j2[0]!.fence, { observedHandle: null, observedIgUserId: null, sessionReady: false });
    expect(gate2.ok).toBe(false);
    const acc2 = await h.db.query.accounts.findFirst({ where: eq(accounts.id, h.accounts[1]!.id) });
    expect(acc2!.state).toBe("needs_login");
    const ns = await listNotifications(op, { kind: "login_required", accountId: acc2!.id });
    expect(ns.length).toBeGreaterThan(0);
    // Login handoff resolves it: control passes to a human (no claims), then back, and blocked jobs retry.
    await startLoginHandoff(op, acc2!.id, 30);
    const none = await claimJobs(w, { workerId: h.worker.id, max: 5 });
    expect(none.jobs.filter((j) => j.account.id === acc2!.id)).toHaveLength(0);
    await endLoginHandoff(op, acc2!.id, { loggedIn: true });
    const acc3 = await h.db.query.accounts.findFirst({ where: eq(accounts.id, h.accounts[1]!.id) });
    expect(acc3!.state).toBe("ready");
    expect(acc3!.sessionControl).toBe("worker");
    const ready = await h.db.select().from(postingJobs).where(and(eq(postingJobs.campaignId, c.id), eq(postingJobs.state, "READY")));
    expect(ready.length).toBeGreaterThanOrEqual(1);
  });

  it("marks SUBMITTING leases that expire as unclear, never auto-retries, and lets an operator confirm the live post", async () => {
    const c = await makeCampaign([2], { start: "2026-03-12" });
    await approveCampaign(await h.operatorCtx(), c.id);
    h.clock.set(new Date("2026-03-12T15:01:00Z"));
    await h.resetAccounts([0, 1]);
    await promoteDueJobs(await h.systemCtx());
    const w = await h.workerCtx();
    const { jobs } = await claimJobs(w, { workerId: h.worker.id, max: 1 });
    const job = jobs[0]!;
    // Simulate a crash between PREPARING and SUBMITTING: lease expires → back to READY (safe).
    h.clock.advance(minutes(6));
    let r = await expireStaleLeases(await h.systemCtx());
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    // The requeued job waits a short backoff (not_before) before it is claimable again.
    const requeued = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.id, job.jobId) });
    expect(requeued!.state).toBe("READY");
    expect(requeued!.notBefore!.getTime()).toBeGreaterThan(h.clock.now().getTime());
    // Park the later day-one slots so the re-claim picks this job, persist SUBMITTING, then crash: must become UNKNOWN_OUTCOME.
    await h.db.update(postingJobs).set({ state: "HELD" }).where(and(eq(postingJobs.campaignId, c.id), sql`${postingJobs.id} <> ${job.jobId}`));
    h.clock.advance(minutes(3));
    const { jobs: j2 } = await claimJobs(w, { workerId: h.worker.id, max: 1 });
    expect(j2[0]!.jobId).toBe(job.jobId);
    expect(j2[0]!.fence).toBe(job.fence + 1);
    const gate = await beginSubmitting(w, j2[0]!.jobId, j2[0]!.fence, { observedHandle: "acct2", observedIgUserId: "ig-2", sessionReady: true });
    expect(gate.ok).toBe(true);
    h.clock.advance(minutes(16));
    r = await expireStaleLeases(await h.systemCtx());
    expect(r.unknown).toBeGreaterThanOrEqual(1);
    const stale = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.id, job.jobId) });
    expect(stale!.state).toBe("UNKNOWN_OUTCOME");
    // Late result from the dead worker with the old fence is rejected.
    await expect(reportResult(w, job.jobId, j2[0]!.fence, { outcome: "verified", postUrl: null, externalId: null, publishedAt: h.clock.now().toISOString(), publishedAtSource: "worker_observed" })).rejects.toMatchObject({ code: "conflict" });
    // Not claimable again automatically.
    const none = await claimJobs(w, { workerId: h.worker.id, max: 5 });
    expect(none.jobs.find((x) => x.jobId === job.jobId)).toBeUndefined();
    const op = await h.operatorCtx();
    await expect(retryJob(op, job.jobId)).rejects.toMatchObject({ code: "validation" });
    await expect(markJobPublished(op, job.jobId, { postUrl: "https://example.com/x" })).rejects.toMatchObject({ code: "validation" });
    await markJobPublished(op, job.jobId, { postUrl: "https://www.instagram.com/reel/abc/" });
    const done = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.id, job.jobId) });
    expect(done!.state).toBe("VERIFIED_PUBLISHED");
    expect(done!.publishedAtSource).toBe("estimated");
    const vp = await h.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.jobId, job.jobId) });
    const aj = await h.db.query.analyticsJobs.findFirst({ where: eq(analyticsJobs.verifiedPostId, vp!.id) });
    expect(aj).toBeTruthy();
  });

  it("invalidates approval when an approved caption or account binding changes", async () => {
    const c = await makeCampaign([0], { start: "2026-03-20", assets: [h.assetIds[2]!] });
    const op = await h.operatorCtx();
    await approveCampaign(op, c.id);
    const { invalidatedJobs } = await updateAsset(op, h.assetIds[2]!, { caption: "Changed after approval" });
    expect(invalidatedJobs).toBeGreaterThanOrEqual(1);
    const jobs = await h.db.select().from(postingJobs).where(and(eq(postingJobs.campaignId, c.id), eq(postingJobs.assetId, h.assetIds[2]!)));
    expect(jobs.every((j) => j.state === "BLOCKED" && j.errorCategory === "approval_changed")).toBe(true);
    const camp = await h.db.query.campaigns.findFirst({ where: (t, { eq }) => eq(t.id, c.id) });
    expect(camp!.status).toBe("needs_reapproval");
    await expect(retryJob(op, jobs[0]!.id)).rejects.toMatchObject({ code: "conflict" });
    // Re-approval binds the new caption.
    const r = await approveCampaign(op, c.id);
    expect(r.approvedJobs).toBe(jobs.length);
    const after = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.id, jobs[0]!.id) });
    expect(after!.approvalSnapshot!.caption).toBe("Changed after approval");
    // Timezone change on the account invalidates again.
    const { invalidatedJobs: inv2 } = await updateAccount(op, h.accounts[0]!.id, { timezone: "America/Chicago" });
    expect(inv2).toBeGreaterThanOrEqual(1);
    await updateAccount(op, h.accounts[0]!.id, { timezone: "America/New_York" });
  });

  it("global, creator and account pauses stop claims and are rechecked right before Share", async () => {
    const c = await makeCampaign([2], { start: "2026-03-25" });
    const op = await h.operatorCtx();
    const owner = await h.ownerCtx();
    await approveCampaign(op, c.id);
    h.clock.set(new Date("2026-03-25T14:01:00Z"));
    await h.resetAccounts([0, 1]);
    await promoteDueJobs(await h.systemCtx());
    await expect(setGlobalPause(op, true)).rejects.toMatchObject({ code: "forbidden" });
    await setGlobalPause(owner, true, "test");
    let w = await h.workerCtx();
    expect((await claimJobs(w, { workerId: h.worker.id, max: 5 })).jobs).toHaveLength(0);
    await setGlobalPause(owner, false);
    await pauseCreator(op, h.creatorB.id);
    w = await h.workerCtx();
    expect((await claimJobs(w, { workerId: h.worker.id, max: 5 })).jobs).toHaveLength(0);
    const { resumeCreator } = await import("./accounts");
    await resumeCreator(op, h.creatorB.id);
    // Claim, then pause the account before the worker reaches Share: the gate refuses and returns the job to READY.
    const { jobs } = await claimJobs(w, { workerId: h.worker.id, max: 1 });
    expect(jobs).toHaveLength(1);
    await pauseAccounts(op, [h.accounts[2]!.id], "hold");
    const gate = await beginSubmitting(w, jobs[0]!.jobId, jobs[0]!.fence, { observedHandle: "acct2", observedIgUserId: "ig-2", sessionReady: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.category).toBe("paused");
    const j = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.id, jobs[0]!.jobId) });
    expect(j!.state).toBe("READY");
    await resumeAccounts(op, [h.accounts[2]!.id]);
  });

  it("raises a missed-schedule notification once and completes analytics with lateness tracking", async () => {
    const c = await makeCampaign([0], { start: "2026-04-01", assets: [h.assetIds[0]!] });
    const op = await h.operatorCtx();
    await approveCampaign(op, c.id);
    h.clock.set(new Date("2026-04-01T16:30:00Z")); // 90 min after the 10:00 EDT slot
    const sys = await h.systemCtx();
    await promoteDueJobs(sys);
    expect(await detectMissedSchedule(sys)).toBeGreaterThanOrEqual(1);
    expect(await detectMissedSchedule(sys)).toBe(0); // deduplicated
    await h.resetAccounts([1, 2]);
    await h.runWorker(2);
    const vp = await h.db.query.verifiedPosts.findFirst({ where: and(eq(verifiedPosts.campaignId, c.id)) });
    expect(vp).toBeTruthy();
    const aj = (await h.db.query.analyticsJobs.findFirst({ where: eq(analyticsJobs.verifiedPostId, vp!.id) }))!;
    // Before due: nothing to claim.
    h.clock.set(new Date(aj.dueAt.getTime() - minutes(30)));
    expect(await promoteDueAnalytics(sys)).toBe(0);
    // Two hours late: overdue notification, then the observation is recorded as late with the real post age.
    h.clock.set(new Date(aj.dueAt.getTime() + hours(2)));
    const m = await maintainAnalytics(sys);
    expect(m.overdueNotified).toBe(1);
    await h.runWorker(1);
    const obs = await h.db.query.analyticsObservations.findFirst({ where: (t, { eq }) => eq(t.analyticsJobId, aj.id) });
    expect(obs).toBeTruthy();
    expect(obs!.isLate).toBe(true);
    expect(obs!.postAgeMinutes).toBeGreaterThanOrEqual(12 * 60);
    expect(obs!.latenessMinutes).toBeGreaterThanOrEqual(120);
    expect(obs!.threshold!.metric).toBe("plays");
    const n = await h.db.query.notifications.findFirst({ where: and(eq(notifications.orgId, h.orgId), eq(notifications.eventId, `analytics_complete:${aj.id}`)) });
    expect(n!.title).toMatch(/late/);
    // The overdue notification was auto-resolved by completion.
    const missed = await h.db.query.notifications.findFirst({ where: and(eq(notifications.orgId, h.orgId), eq(notifications.eventId, `missed_analytics:${aj.id}`)) });
    expect(missed!.resolvedAt).toBeTruthy();
  });

  it("records missing metrics as unknown, not zero, and evaluates the threshold as unknown", async () => {
    const w = await h.workerCtx();
    const c = await makeCampaign([2], { start: "2026-04-05", assets: [h.assetIds[1]!] });
    await approveCampaign(await h.operatorCtx(), c.id);
    h.clock.set(new Date("2026-04-05T14:01:00Z"));
    await h.resetAccounts([0, 1]);
    await h.runWorker(3);
    const vp = (await h.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.campaignId, c.id) }))!;
    const aj = (await h.db.query.analyticsJobs.findFirst({ where: eq(analyticsJobs.verifiedPostId, vp.id) }))!;
    h.clock.set(new Date(aj.dueAt.getTime() + minutes(5)));
    await promoteDueAnalytics(w);
    const { jobs } = await claimAnalytics(w, { workerId: h.worker.id, max: 1 });
    expect(jobs).toHaveLength(1);
    await reportAnalytics(w, jobs[0]!.analyticsJobId, jobs[0]!.fence, { outcome: "observed", observedAt: h.clock.now().toISOString(), metrics: [{ name: "likes", value: 12, source: "test" }, { name: "plays", value: null, source: "test", note: "not shown" }], source: "test", postFound: true });
    const obs = (await h.db.query.analyticsObservations.findFirst({ where: (t, { eq }) => eq(t.analyticsJobId, aj.id) }))!;
    expect(obs.isLate).toBe(false);
    expect(obs.metrics.find((m) => m.name === "plays")!.value).toBeNull();
    expect(obs.threshold!.result).toBe("unknown");
  });

  it("the scheduler tick is idempotent and marks a silent worker offline once", async () => {
    const sys = await h.systemCtx();
    await h.db.update(workers).set({ lastHeartbeatAt: new Date(h.clock.now().getTime() - hours(1)) }).where(eq(workers.id, h.worker.id));
    const r1 = await tickOrg(sys, { deliver: false });
    expect(r1.offlineWorkers).toBe(1);
    const r2 = await tickOrg(sys, { deliver: false });
    expect(r2.offlineWorkers).toBe(0);
    const ns = await listNotifications(sys, { kind: "worker_offline" });
    expect(ns).toHaveLength(1);
    // Reconnect.
    await h.runWorker(0);
    const wk = await h.db.query.workers.findFirst({ where: eq(workers.id, h.worker.id) });
    expect(wk!.status).toBe("online");
  });

  it("demo mode refuses live adapters and duplicate idempotency keys are rejected", async () => {
    const tok = (await import("../lib/crypto")).issueWorkerToken();
    const [live] = await h.db.insert(workers).values({ orgId: h.orgId, name: "mac", kind: "hermes_mac", tokenPrefix: tok.prefix, tokenHash: tok.hash, status: "online", lastHeartbeatAt: h.clock.now() }).returning();
    const lctx = await h.ctxFor({ type: "worker", id: live!.id, name: "mac" });
    const r = await claimJobs(lctx, { workerId: live!.id, max: 1 });
    expect(r.jobs).toHaveLength(0);
    expect(r.reason).toMatch(/Demo mode/);
    const existing = await h.db.query.postingJobs.findFirst({ where: eq(postingJobs.orgId, h.orgId) });
    await expect(h.db.insert(postingJobs).values({ orgId: h.orgId, campaignId: existing!.campaignId, accountId: existing!.accountId, sequence: 99, plannedAt: new Date(), plannedTimezone: "UTC", idempotencyKey: existing!.idempotencyKey })).rejects.toThrow();
    expect(AppError).toBeTruthy();
  });
});
