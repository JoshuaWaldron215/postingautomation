/**
 * Durable publishing pipeline.
 *
 * QUEUED → READY → PREPARING → SUBMITTING → VERIFIED_PUBLISHED
 * Exceptions: BLOCKED, FAILED, UNKNOWN_OUTCOME (plus HELD for content shortage, CANCELLED).
 *
 * Guarantees implemented here:
 *  - Atomic claiming with `FOR UPDATE SKIP LOCKED`, a per-account execution lock and a lease.
 *  - Fencing: every claim increments `lease_fence`; progress/result calls carrying a stale fence are rejected.
 *  - SUBMITTING is persisted (and pauses/approval rechecked) *before* the worker is allowed to click Share.
 *  - A verified result writes the verified post, the analytics job and the notification in one transaction.
 *  - SUBMITTING jobs whose lease expires become UNKNOWN_OUTCOME and are never retried automatically.
 *
 * Limit: an idempotency key makes *our* records exactly-once. It cannot make an external browser
 * click exactly-once; that is why timeouts reconcile instead of retrying (see docs/architecture.md).
 */
import { type SQL, and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  accounts,
  analyticsJobs,
  approvals,
  assets,
  campaigns,
  creators,
  jobAttempts,
  postingJobs,
  verifiedPosts,
  workers,
  type ErrorCategory,
  type JobState,
  type PostingJob,
} from "../db/schema";
import { minutes } from "../lib/clock";
import { AppError, conflict, notFound, validation } from "../lib/errors";
import { canTransition, ERROR_CATEGORY_LABEL, JOB_STATE_LABEL } from "../lib/states";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { assertCreatorAccess, creatorScopeOf, requireRole, withTx, type Ctx } from "./context";
import { mediaToken } from "./media";
import { emitNotification, resolveNotificationsFor } from "./notifications";

export const LEASE_MS = minutes(5);
export const SUBMIT_LEASE_MS = minutes(15);
const RETRY_BACKOFF_MS = [minutes(2), minutes(10), minutes(30)];
const RETRYABLE: ErrorCategory[] = ["network", "timeout", "instagram_error", "internal"];

export type ClaimedJob = {
  jobId: string;
  fence: number;
  leaseExpiresAt: string;
  attemptNo: number;
  account: { id: string; handle: string; verifiedIgUserId: string | null; timezone: string; browserProfileKey: string | null; executionRoute: string };
  content: { assetId: string; sha256: string; caption: string; format: "reel"; audience: "public"; mediaUrlPath: string; filename: string; mime: string; durationSeconds: number | null };
  plannedAt: string;
  campaignId: string;
  idempotencyKey: string;
};

async function pauseState(ctx: Ctx, accountId: string): Promise<{ paused: boolean; reason?: string; creatorId: string; campaignPaused?: boolean }> {
  const row = await ctx.db
    .select({ acc: accounts, creatorPausedAt: creators.pausedAt, creatorName: creators.name })
    .from(accounts)
    .innerJoin(creators, eq(creators.id, accounts.creatorId))
    .where(eq(accounts.id, accountId))
    .limit(1);
  const r = row[0];
  if (!r) return { paused: true, reason: "Account not found", creatorId: "" };
  if (ctx.settings.globalPause.active) return { paused: true, reason: "All posting is paused", creatorId: r.acc.creatorId };
  if (r.creatorPausedAt) return { paused: true, reason: `Creator ${r.creatorName} is paused`, creatorId: r.acc.creatorId };
  if (r.acc.state === "paused" || r.acc.pausedAt) return { paused: true, reason: "Account is paused", creatorId: r.acc.creatorId };
  if (r.acc.sessionControl === "human_handoff") return { paused: true, reason: "A person is using this account's browser session", creatorId: r.acc.creatorId };
  return { paused: false, creatorId: r.acc.creatorId };
}

/** Atomically claims up to `max` READY jobs for accounts assigned to this worker. */
export async function claimJobs(ctx: Ctx, params: { workerId: string; max: number }): Promise<{ jobs: ClaimedJob[]; reason?: string }> {
  if (ctx.actor.type !== "worker" || ctx.actor.id !== params.workerId) throw new AppError("forbidden", "Workers may only claim jobs for themselves.");
  const worker = await ctx.db.query.workers.findFirst({ where: and(eq(workers.id, params.workerId), eq(workers.orgId, ctx.orgId)) });
  if (!worker || worker.status === "revoked") throw new AppError("unauthorized", "Worker is revoked.");
  if (ctx.settings.demoMode && worker.kind !== "simulator") return { jobs: [], reason: "Demo mode never authorizes live posting. Turn demo mode off in Settings to use a browser worker." };
  if (ctx.settings.globalPause.active) return { jobs: [], reason: "All posting is paused." };
  const now = ctx.clock.now();
  const inflight = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(postingJobs).where(and(eq(postingJobs.leaseWorkerId, params.workerId), inArray(postingJobs.state, ["PREPARING", "SUBMITTING"]), gt(postingJobs.leaseExpiresAt, now)));
  const capacity = Math.max(0, Math.min(params.max, worker.maxConcurrency - (inflight[0]?.n ?? 0)));
  if (capacity === 0) return { jobs: [], reason: "Worker is at its concurrency limit." };

  const claimed: ClaimedJob[] = [];
  await withTx(ctx, async (tx) => {
    const candidates = await tx.db
      .select({ j: postingJobs })
      .from(postingJobs)
      .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
      .innerJoin(creators, eq(creators.id, accounts.creatorId))
      .innerJoin(campaigns, eq(campaigns.id, postingJobs.campaignId))
      .where(
        and(
          eq(postingJobs.orgId, tx.orgId),
          eq(postingJobs.state, "READY"),
          eq(accounts.workerId, params.workerId),
          eq(accounts.sessionControl, "worker"),
          notInArray(accounts.state, ["needs_review", "needs_login"]),
          isNull(accounts.pausedAt),
          isNull(creators.pausedAt),
          eq(campaigns.status, "approved"),
          sql`${postingJobs.approvalId} IS NOT NULL`,
          or(isNull(postingJobs.notBefore), lte(postingJobs.notBefore, now)),
          or(isNull(accounts.lockJobId), lt(accounts.lockExpiresAt, now)),
        ),
      )
      .orderBy(asc(postingJobs.plannedAt))
      .limit(capacity * 4)
      .for("update", { of: postingJobs, skipLocked: true });
    const seenAccounts = new Set<string>();
    for (const { j } of candidates) {
      if (claimed.length >= capacity) break;
      if (seenAccounts.has(j.accountId)) continue;
      const [locked] = await tx.db
        .update(accounts)
        .set({ lockJobId: j.id, lockWorkerId: params.workerId, lockExpiresAt: new Date(now.getTime() + LEASE_MS), state: "posting", stateReason: "Publishing a scheduled post", stateSince: now })
        .where(and(eq(accounts.id, j.accountId), or(isNull(accounts.lockJobId), lt(accounts.lockExpiresAt, now))))
        .returning();
      if (!locked) continue;
      seenAccounts.add(j.accountId);
      const fence = j.leaseFence + 1;
      const attemptNo = j.attemptCount + 1;
      const [updated] = await tx.db
        .update(postingJobs)
        .set({ state: "PREPARING", leaseWorkerId: params.workerId, leaseFence: fence, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), claimedAt: now, attemptCount: attemptNo, stateReason: null, updatedAt: now })
        .where(and(eq(postingJobs.id, j.id), eq(postingJobs.state, "READY")))
        .returning();
      if (!updated) continue;
      await tx.db.insert(jobAttempts).values({ orgId: tx.orgId, jobId: j.id, attemptNo, workerId: params.workerId, fence, startedAt: now, evidence: { adapter: worker.kind } });
      const asset = j.assetId ? await tx.db.query.assets.findFirst({ where: eq(assets.id, j.assetId) }) : null;
      const snap = j.approvalSnapshot!;
      await recordAudit(tx, { eventType: "job.claimed", message: `Worker claimed the post for @${locked.handle} (attempt ${attemptNo}).`, jobId: j.id, accountId: j.accountId, campaignId: j.campaignId, approvalId: j.approvalId, attemptNo, fromState: "READY", toState: "PREPARING", creatorId: locked.creatorId });
      claimed.push({
        jobId: j.id,
        fence,
        leaseExpiresAt: updated.leaseExpiresAt!.toISOString(),
        attemptNo,
        account: { id: locked.id, handle: locked.handle, verifiedIgUserId: locked.verifiedIgUserId, timezone: locked.timezone, browserProfileKey: locked.browserProfileKey, executionRoute: locked.executionRoute },
        content: {
          assetId: snap.assetId,
          sha256: snap.sha256,
          caption: snap.caption,
          format: "reel",
          audience: "public",
          mediaUrlPath: `/api/worker/v1/media/${mediaToken(tx.orgId, "asset", asset?.storageKey ?? "", 3600)}`,
          filename: asset?.originalFilename ?? "video.mp4",
          mime: asset?.mime ?? "video/mp4",
          durationSeconds: asset?.durationSeconds ?? null,
        },
        plannedAt: j.plannedAt.toISOString(),
        campaignId: j.campaignId,
        idempotencyKey: j.idempotencyKey,
      });
    }
  });
  return { jobs: claimed };
}

async function loadLeasedJob(ctx: Ctx, jobId: string, fence: number): Promise<PostingJob> {
  const job = await ctx.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.id, jobId), eq(postingJobs.orgId, ctx.orgId)) });
  if (!job) throw notFound("Job");
  if (ctx.actor.type === "worker" && job.leaseWorkerId !== ctx.actor.id) throw new AppError("forbidden", "This job is leased to a different worker.");
  if (job.leaseFence !== fence) throw new AppError("stale_fence", "This lease is stale: the job was reassigned. Stop working on it.", { currentFence: job.leaseFence });
  return job;
}

export async function heartbeatJob(ctx: Ctx, jobId: string, fence: number): Promise<{ leaseExpiresAt: string; shouldAbort: boolean; reason?: string }> {
  const job = await loadLeasedJob(ctx, jobId, fence);
  if (!["PREPARING", "SUBMITTING"].includes(job.state)) return { leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? "", shouldAbort: true, reason: `Job is now ${JOB_STATE_LABEL[job.state]}` };
  const ms = job.state === "SUBMITTING" ? SUBMIT_LEASE_MS : LEASE_MS;
  const exp = new Date(ctx.clock.now().getTime() + ms);
  await ctx.db.update(postingJobs).set({ leaseExpiresAt: exp, updatedAt: ctx.clock.now() }).where(eq(postingJobs.id, jobId));
  await ctx.db.update(accounts).set({ lockExpiresAt: exp }).where(and(eq(accounts.id, job.accountId), eq(accounts.lockJobId, jobId)));
  if (job.state === "PREPARING") {
    const p = await pauseState(ctx, job.accountId);
    if (p.paused) return { leaseExpiresAt: exp.toISOString(), shouldAbort: true, reason: p.reason };
  }
  return { leaseExpiresAt: exp.toISOString(), shouldAbort: false };
}

/**
 * The gate before Share. Verifies identity, pauses and approval, then persists SUBMITTING.
 * Returns ok=false (with the job blocked) when the worker must NOT publish.
 */
export async function beginSubmitting(
  ctx: Ctx,
  jobId: string,
  fence: number,
  identity: { observedHandle: string | null; observedIgUserId: string | null; sessionReady: boolean },
): Promise<{ ok: true; leaseExpiresAt: string } | { ok: false; reason: string; category: ErrorCategory }> {
  return withTx(ctx, async (tx) => {
    const job = await loadLeasedJob(tx, jobId, fence);
    if (job.state !== "PREPARING") return { ok: false, reason: `Job is ${JOB_STATE_LABEL[job.state]}, not preparing.`, category: "internal" };
    const account = (await tx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
    const fail = async (category: ErrorCategory, reason: string, accountState?: { state: typeof account.state; reason: string }) => {
      await transition(tx, job, "BLOCKED", { reason, category, attemptOutcome: "blocked" });
      if (accountState) await tx.db.update(accounts).set({ state: accountState.state, stateReason: accountState.reason, stateSince: tx.clock.now() }).where(eq(accounts.id, account.id));
      await releaseLock(tx, account.id, job.id);
      await notifyException(tx, job, category, reason);
      return { ok: false as const, reason, category };
    };
    if (!identity.sessionReady) {
      await tx.db.update(accounts).set({ sessionReadiness: "needs_login", sessionCheckedAt: tx.clock.now() }).where(eq(accounts.id, account.id));
      return fail("login_required", "The browser session is not logged in to Instagram.", { state: "needs_login", reason: "The browser session is not logged in" });
    }
    const observed = identity.observedHandle?.replace(/^@/, "").toLowerCase() ?? null;
    if (!observed) return fail("account_mismatch", "The worker could not read which account is logged in.", { state: "needs_review", reason: "Could not verify the logged-in account" });
    if (observed !== account.handle.toLowerCase()) return fail("account_mismatch", `The browser is logged in as @${observed}, not @${account.handle}. Nothing was posted.`, { state: "needs_review", reason: `Browser was logged in as @${observed}` });
    if (account.verifiedIgUserId && identity.observedIgUserId && account.verifiedIgUserId !== identity.observedIgUserId) {
      return fail("account_mismatch", `The logged-in Instagram user id (${identity.observedIgUserId}) does not match the verified id for @${account.handle}. Nothing was posted.`, { state: "needs_review", reason: "Instagram user id changed" });
    }
    if (!account.verifiedIgUserId && identity.observedIgUserId) {
      await tx.db.update(accounts).set({ verifiedIgUserId: identity.observedIgUserId }).where(eq(accounts.id, account.id));
      await recordAudit(tx, { eventType: "account.identity_verified", message: `Verified @${account.handle} as Instagram user ${identity.observedIgUserId} (first successful identity check).`, accountId: account.id, creatorId: account.creatorId, jobId: job.id });
    }
    const p = await pauseState(tx, job.accountId);
    if (p.paused) {
      await transition(tx, job, "READY", { reason: `Not submitted: ${p.reason}`, attemptOutcome: "blocked" });
      await releaseLock(tx, account.id, job.id);
      return { ok: false, reason: p.reason ?? "Paused", category: "paused" };
    }
    const campaign = (await tx.db.query.campaigns.findFirst({ where: eq(campaigns.id, job.campaignId) }))!;
    const approval = job.approvalId ? await tx.db.query.approvals.findFirst({ where: eq(approvals.id, job.approvalId) }) : null;
    if (!approval || approval.revokedAt || campaign.status !== "approved") return fail("authorization_revoked", "The campaign approval is no longer valid.");
    const asset = job.assetId ? await tx.db.query.assets.findFirst({ where: eq(assets.id, job.assetId) }) : null;
    const snap = job.approvalSnapshot;
    if (!asset || asset.deletedAt || !snap) return fail("content_missing", "The approved video is no longer available.");
    if (asset.sha256 !== snap.sha256 || asset.caption !== snap.caption || asset.version !== snap.assetVersion || account.timezone !== snap.timezone || account.handle !== snap.handle) {
      return fail("approval_changed", "The approved content or account settings changed after approval. Re-approve the campaign.");
    }
    const now = tx.clock.now();
    const exp = new Date(now.getTime() + SUBMIT_LEASE_MS);
    await tx.db.update(postingJobs).set({ state: "SUBMITTING", submittingAt: now, leaseExpiresAt: exp, updatedAt: now, stateReason: null }).where(eq(postingJobs.id, job.id));
    await tx.db.update(accounts).set({ lockExpiresAt: exp, sessionReadiness: "ready", sessionCheckedAt: now }).where(eq(accounts.id, account.id));
    await tx.db.update(jobAttempts).set({ stateReached: "SUBMITTING" }).where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.fence, fence)));
    await recordAudit(tx, { eventType: "job.submitting", message: `Identity verified (@${account.handle}); approval and pauses rechecked. Submitting to Instagram.`, jobId: job.id, accountId: account.id, campaignId: job.campaignId, approvalId: job.approvalId, attemptNo: job.attemptCount, fromState: "PREPARING", toState: "SUBMITTING", creatorId: account.creatorId });
    return { ok: true, leaseExpiresAt: exp.toISOString() };
  });
}

export type JobResult =
  | { outcome: "verified"; postUrl: string | null; externalId: string | null; publishedAt: string; publishedAtSource: "worker_observed" | "instagram_reported"; evidenceKey?: string | null; notes?: string }
  | { outcome: "failed"; category: ErrorCategory; message: string; evidenceKey?: string | null }
  | { outcome: "blocked"; category: ErrorCategory; message: string; evidenceKey?: string | null }
  | { outcome: "unknown"; message: string; evidenceKey?: string | null };

export async function reportResult(ctx: Ctx, jobId: string, fence: number, result: JobResult): Promise<{ state: JobState }> {
  return withTx(ctx, async (tx) => {
    const job = await loadLeasedJob(tx, jobId, fence);
    if (!["PREPARING", "SUBMITTING"].includes(job.state)) throw conflict(`Job is already ${JOB_STATE_LABEL[job.state]}.`);
    const account = (await tx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
    const now = tx.clock.now();
    switch (result.outcome) {
      case "verified": {
        if (job.state !== "SUBMITTING") throw conflict("A verified result requires the job to have been SUBMITTING.");
        const publishedAt = new Date(result.publishedAt);
        if (Number.isNaN(publishedAt.getTime())) throw validation("publishedAt must be a valid timestamp.");
        await markVerified(tx, job, account, { publishedAt, publishedAtSource: result.publishedAtSource, postUrl: result.postUrl, externalId: result.externalId, evidenceKey: result.evidenceKey ?? null, workerId: tx.actor.type === "worker" ? tx.actor.id : null });
        return { state: "VERIFIED_PUBLISHED" };
      }
      case "failed": {
        const retryable = RETRYABLE.includes(result.category) && job.attemptCount < job.maxAttempts && job.state === "PREPARING";
        if (retryable) {
          const backoff = RETRY_BACKOFF_MS[Math.min(job.attemptCount - 1, RETRY_BACKOFF_MS.length - 1)]!;
          await transition(tx, job, "READY", { reason: `${ERROR_CATEGORY_LABEL[result.category] ?? result.category}; retrying in ${Math.round(backoff / 60000)} min (attempt ${job.attemptCount} of ${job.maxAttempts})`, category: result.category, message: result.message, attemptOutcome: "failed", evidenceKey: result.evidenceKey ?? null, notBefore: new Date(now.getTime() + backoff) });
        } else {
          await transition(tx, job, "FAILED", { reason: job.state === "SUBMITTING" ? `${result.message} (reported after submission started; check Instagram before retrying)` : result.message, category: result.category, message: result.message, attemptOutcome: "failed", evidenceKey: result.evidenceKey ?? null });
          await notifyException(tx, job, result.category, result.message);
        }
        await releaseLock(tx, account.id, job.id);
        return { state: retryable ? "READY" : "FAILED" };
      }
      case "blocked": {
        await transition(tx, job, "BLOCKED", { reason: result.message, category: result.category, message: result.message, attemptOutcome: "blocked", evidenceKey: result.evidenceKey ?? null });
        if (result.category === "login_required" || result.category === "login_challenge") {
          await tx.db.update(accounts).set({ state: "needs_login", stateReason: ERROR_CATEGORY_LABEL[result.category], stateSince: now, sessionReadiness: "needs_login", sessionCheckedAt: now }).where(eq(accounts.id, account.id));
        } else if (result.category === "account_mismatch") {
          await tx.db.update(accounts).set({ state: "needs_review", stateReason: result.message, stateSince: now }).where(eq(accounts.id, account.id));
        }
        await releaseLock(tx, account.id, job.id);
        await notifyException(tx, job, result.category, result.message);
        return { state: "BLOCKED" };
      }
      case "unknown": {
        await transition(tx, job, "UNKNOWN_OUTCOME", { reason: result.message, category: "unclear_publication", message: result.message, attemptOutcome: "unknown", evidenceKey: result.evidenceKey ?? null });
        await tx.db.update(accounts).set({ state: "needs_review", stateReason: "A post may or may not have gone live; check Instagram", stateSince: now }).where(eq(accounts.id, account.id));
        await releaseLock(tx, account.id, job.id);
        await notifyException(tx, job, "unclear_publication", result.message);
        return { state: "UNKNOWN_OUTCOME" };
      }
    }
  });
}

/** Worker reconciliation after an unknown outcome: it looked at the profile and either found the post or not. */
export async function reconcileJob(ctx: Ctx, jobId: string, finding: { found: true; postUrl: string | null; externalId: string | null; publishedAt: string; publishedAtSource: "worker_observed" | "instagram_reported" | "estimated"; evidenceKey?: string | null } | { found: false; evidenceKey?: string | null; notes?: string }): Promise<{ state: JobState }> {
  return withTx(ctx, async (tx) => {
    const job = await tx.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.id, jobId), eq(postingJobs.orgId, tx.orgId)) });
    if (!job) throw notFound("Job");
    if (job.state !== "UNKNOWN_OUTCOME") throw conflict("Only unclear results can be reconciled.");
    const account = (await tx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
    if (finding.found) {
      await markVerified(tx, job, account, { publishedAt: new Date(finding.publishedAt), publishedAtSource: finding.publishedAtSource, postUrl: finding.postUrl, externalId: finding.externalId, evidenceKey: finding.evidenceKey ?? null, workerId: tx.actor.type === "worker" ? tx.actor.id : null, reconciled: true });
      return { state: "VERIFIED_PUBLISHED" };
    }
    await transition(tx, job, "FAILED", { reason: `Checked Instagram: no post found${finding.notes ? ` (${finding.notes})` : ""}. Safe to retry.`, category: "unclear_publication", attemptOutcome: "failed", evidenceKey: finding.evidenceKey ?? null, skipAttemptUpdate: true });
    await tx.db.update(accounts).set({ state: "ready", stateReason: "Reconciled: no post was made", stateSince: tx.clock.now() }).where(and(eq(accounts.id, account.id), eq(accounts.state, "needs_review")));
    return { state: "FAILED" };
  });
}

async function markVerified(
  tx: Ctx,
  job: PostingJob,
  account: typeof accounts.$inferSelect,
  v: { publishedAt: Date; publishedAtSource: "worker_observed" | "instagram_reported" | "estimated"; postUrl: string | null; externalId: string | null; evidenceKey: string | null; workerId: string | null; reconciled?: boolean },
) {
  const now = tx.clock.now();
  await transition(tx, job, "VERIFIED_PUBLISHED", { reason: v.reconciled ? "Confirmed live after reconciliation" : "Confirmed live on Instagram", attemptOutcome: "verified", evidenceKey: v.evidenceKey, extra: { publishedAt: v.publishedAt, publishedAtSource: v.publishedAtSource, postUrl: v.postUrl, postExternalId: v.externalId } });
  const [vp] = await tx.db
    .insert(verifiedPosts)
    .values({ orgId: tx.orgId, jobId: job.id, accountId: account.id, assetId: job.assetId, campaignId: job.campaignId, publishedAt: v.publishedAt, publishedAtSource: v.publishedAtSource, postUrl: v.postUrl, externalId: v.externalId, caption: job.approvalSnapshot?.caption ?? "", verifiedByWorkerId: v.workerId, executionRoute: account.executionRoute, evidenceKey: v.evidenceKey })
    .onConflictDoNothing({ target: verifiedPosts.jobId })
    .returning();
  const verified = vp ?? (await tx.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.jobId, job.id) }))!;
  // Follow-ups are created in the same transaction so a crash cannot lose them.
  const dueAt = new Date(v.publishedAt.getTime() + tx.settings.analytics.delayHours * 3_600_000);
  await tx.db.insert(analyticsJobs).values({ orgId: tx.orgId, verifiedPostId: verified.id, accountId: account.id, dueAt, state: "SCHEDULED" }).onConflictDoNothing({ target: analyticsJobs.verifiedPostId });
  const gapMs = (account.postingPolicy.minGapMinutes ?? tx.settings.minGapMinutes) * 60_000;
  await tx.db
    .update(postingJobs)
    .set({ notBefore: new Date(v.publishedAt.getTime() + gapMs), stateReason: sql`case when ${postingJobs.plannedAt} < ${new Date(v.publishedAt.getTime() + gapMs).toISOString()}::timestamptz then 'Delayed to keep the minimum spacing after the previous post' else ${postingJobs.stateReason} end`, updatedAt: now })
    .where(and(eq(postingJobs.accountId, account.id), inArray(postingJobs.state, ["QUEUED", "READY"]), or(isNull(postingJobs.notBefore), lt(postingJobs.notBefore, new Date(v.publishedAt.getTime() + gapMs)))));
  await tx.db.update(accounts).set({ lastVerifiedPostAt: v.publishedAt, state: "ready", stateReason: "Last post verified live", stateSince: now, lockJobId: null, lockWorkerId: null, lockExpiresAt: null }).where(eq(accounts.id, account.id));
  await emitNotification(tx, {
    eventId: `post_verified:${job.id}`,
    kind: "post_verified",
    severity: "info",
    title: `Post verified live on @${account.handle}`,
    body: `${v.postUrl ?? "Post URL not captured"} · published ${v.publishedAt.toISOString()} (${v.publishedAtSource.replace("_", " ")}). Analytics due in ${tx.settings.analytics.delayHours}h.`,
    accountId: account.id,
    creatorId: account.creatorId,
    campaignId: job.campaignId,
    jobId: job.id,
    data: { url: `/results?job=${job.id}`, postUrl: v.postUrl },
  });
  await resolveNotificationsFor(tx, { jobId: job.id, kinds: ["unknown_outcome", "job_failed", "login_required", "missed_schedule"] });
}

async function transition(
  tx: Ctx,
  job: PostingJob,
  to: JobState,
  opts: { reason?: string | null; category?: ErrorCategory | null; message?: string | null; attemptOutcome?: "verified" | "failed" | "blocked" | "unknown" | "lost"; evidenceKey?: string | null; notBefore?: Date | null; extra?: Partial<typeof postingJobs.$inferInsert>; skipAttemptUpdate?: boolean },
) {
  if (!canTransition(job.state, to)) throw conflict(`Cannot move a job from ${job.state} to ${to}.`);
  const now = tx.clock.now();
  await tx.db
    .update(postingJobs)
    .set({ state: to, stateReason: opts.reason ?? null, errorCategory: opts.category ?? null, errorMessage: opts.message ?? null, notBefore: opts.notBefore ?? job.notBefore, updatedAt: now, ...(to === "VERIFIED_PUBLISHED" || ["FAILED", "BLOCKED", "UNKNOWN_OUTCOME", "READY", "QUEUED"].includes(to) ? { leaseExpiresAt: null } : {}), ...(opts.extra ?? {}) })
    .where(eq(postingJobs.id, job.id));
  if (opts.attemptOutcome && !opts.skipAttemptUpdate) {
    await tx.db
      .update(jobAttempts)
      .set({ endedAt: now, outcome: opts.attemptOutcome, stateReached: to, errorCategory: opts.category ?? null, errorMessage: opts.message ?? null, evidence: opts.evidenceKey ? { screenshotKey: opts.evidenceKey } : undefined })
      .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.fence, job.leaseFence)));
  }
  await recordAudit(tx, {
    eventType: `job.${to.toLowerCase()}`,
    message: `${JOB_STATE_LABEL[job.state]} → ${JOB_STATE_LABEL[to]}${opts.reason ? `: ${opts.reason}` : ""}`,
    jobId: job.id,
    accountId: job.accountId,
    campaignId: job.campaignId,
    approvalId: job.approvalId,
    attemptNo: job.attemptCount,
    fromState: job.state,
    toState: to,
    errorCategory: opts.category ?? null,
    evidence: opts.evidenceKey ? { screenshotKey: opts.evidenceKey } : null,
  });
}

async function releaseLock(tx: Ctx, accountId: string, jobId: string) {
  await tx.db
    .update(accounts)
    .set({ lockJobId: null, lockWorkerId: null, lockExpiresAt: null, state: sql`case when ${accounts.state} = 'posting' then 'ready'::account_state else ${accounts.state} end`, stateReason: sql`case when ${accounts.state} = 'posting' then 'Idle' else ${accounts.stateReason} end` })
    .where(and(eq(accounts.id, accountId), eq(accounts.lockJobId, jobId)));
}

async function notifyException(tx: Ctx, job: PostingJob, category: ErrorCategory, message: string) {
  const account = (await tx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
  const kind = category === "login_required" || category === "login_challenge" ? "login_required" : category === "unclear_publication" ? "unknown_outcome" : "job_failed";
  await emitNotification(tx, {
    eventId: `${kind}:${job.id}:${job.attemptCount}`,
    kind,
    severity: kind === "unknown_outcome" || kind === "login_required" ? "critical" : "warning",
    title: kind === "login_required" ? `@${account.handle} needs a login` : kind === "unknown_outcome" ? `Unclear result on @${account.handle}` : `Post failed on @${account.handle}`,
    body: `${ERROR_CATEGORY_LABEL[category] ?? category}: ${message}`,
    accountId: account.id,
    creatorId: account.creatorId,
    campaignId: job.campaignId,
    jobId: job.id,
    data: { url: `/accounts?account=${account.id}&job=${job.id}`, category },
  });
}

// ---------- scheduler maintenance ----------
export async function promoteDueJobs(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .update(postingJobs)
    .set({ state: "READY", updatedAt: now })
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.state, "QUEUED"), sql`${postingJobs.approvalId} IS NOT NULL`, lte(postingJobs.plannedAt, now)))
    .returning({ id: postingJobs.id });
  return rows.length;
}

/** Expired PREPARING leases go back to READY (nothing was sent). Expired SUBMITTING leases become UNKNOWN_OUTCOME. */
export async function expireStaleLeases(ctx: Ctx): Promise<{ requeued: number; unknown: number }> {
  const now = ctx.clock.now();
  let requeued = 0;
  let unknown = 0;
  const stale = await ctx.db.select().from(postingJobs).where(and(eq(postingJobs.orgId, ctx.orgId), inArray(postingJobs.state, ["PREPARING", "SUBMITTING"]), lt(postingJobs.leaseExpiresAt, now)));
  for (const job of stale) {
    const account = (await ctx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
    await withTx(ctx, async (tx) => {
      if (job.state === "PREPARING") {
        const retry = job.attemptCount < job.maxAttempts;
        await transition(tx, job, retry ? "READY" : "FAILED", { reason: retry ? "Worker stopped responding before submitting; will retry" : "Worker stopped responding repeatedly", category: "worker_lost", attemptOutcome: "lost", notBefore: new Date(now.getTime() + minutes(2)) });
        if (!retry) await notifyException(tx, job, "worker_lost", "The worker stopped responding before the post was submitted.");
        requeued++;
      } else {
        await transition(tx, job, "UNKNOWN_OUTCOME", { reason: "Worker stopped responding after submission started. The post may or may not be live; check Instagram before retrying.", category: "unclear_publication", attemptOutcome: "lost" });
        await tx.db.update(accounts).set({ state: "needs_review", stateReason: "A post may or may not have gone live; check Instagram", stateSince: now }).where(eq(accounts.id, account.id));
        await notifyException(tx, job, "unclear_publication", "The worker stopped responding after submission started.");
        unknown++;
      }
      await releaseLock(tx, account.id, job.id);
    });
  }
  await ctx.db.update(accounts).set({ lockJobId: null, lockWorkerId: null, lockExpiresAt: null }).where(and(eq(accounts.orgId, ctx.orgId), lt(accounts.lockExpiresAt, now)));
  return { requeued, unknown };
}

/** Notifies once per job when a READY post is more than an hour late and still unclaimed. */
export async function detectMissedSchedule(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - minutes(60));
  const late = await ctx.db
    .select({ j: postingJobs, handle: accounts.handle, creatorId: accounts.creatorId, workerId: accounts.workerId, accState: accounts.state })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.state, "READY"), lt(postingJobs.plannedAt, cutoff)));
  let n = 0;
  for (const { j, handle, creatorId, workerId, accState } of late) {
    const why = !workerId ? "no worker is assigned to the account" : accState === "offline" ? "the worker is offline" : accState === "paused" ? "the account is paused" : accState === "needs_login" ? "the account needs a login" : "no worker has picked it up";
    const { created } = await emitNotification(ctx, { eventId: `missed_schedule:${j.id}`, kind: "missed_schedule", severity: "warning", title: `Post on @${handle} is running late`, body: `Planned for ${j.plannedAt.toISOString()} but ${why}. It will post when possible; nothing has been skipped.`, accountId: j.accountId, creatorId, campaignId: j.campaignId, jobId: j.id, data: { url: `/schedule?job=${j.id}` } });
    if (created) n++;
  }
  return n;
}

/** Content shortage: approved campaigns with held slots and no ready, unused content. */
export async function detectContentShortage(ctx: Ctx): Promise<number> {
  const held = await ctx.db
    .select({ campaignId: postingJobs.campaignId, accountId: postingJobs.accountId, n: sql<number>`count(*)::int`, name: campaigns.name, creatorId: campaigns.creatorId, handle: accounts.handle })
    .from(postingJobs)
    .innerJoin(campaigns, eq(campaigns.id, postingJobs.campaignId))
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.state, "HELD"), eq(postingJobs.errorCategory, "content_missing"), inArray(campaigns.status, ["approved", "paused", "needs_reapproval"])))
    .groupBy(postingJobs.campaignId, postingJobs.accountId, campaigns.name, campaigns.creatorId, accounts.handle);
  let n = 0;
  for (const h of held) {
    const { created } = await emitNotification(ctx, { eventId: `content_shortage:${h.campaignId}:${h.accountId}`, kind: "content_shortage", severity: "warning", title: `@${h.handle} is out of approved content`, body: `${h.n} upcoming slot${h.n === 1 ? "" : "s"} in “${h.name}” have no video. Upload and assign more content; nothing will be recycled automatically.`, accountId: h.accountId, creatorId: h.creatorId, campaignId: h.campaignId, data: { url: `/content?creator=${h.creatorId ?? ""}` } });
    if (created) n++;
  }
  return n;
}

// ---------- human resolution ----------
async function loadJobForUser(ctx: Ctx, jobId: string) {
  const job = await ctx.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.id, jobId), eq(postingJobs.orgId, ctx.orgId)) });
  if (!job) throw notFound("Job");
  const account = (await ctx.db.query.accounts.findFirst({ where: eq(accounts.id, job.accountId) }))!;
  assertCreatorAccess(ctx, account.creatorId);
  return { job, account };
}

export async function retryJob(ctx: Ctx, jobId: string, opts: { confirmedNoPost?: boolean } = {}): Promise<void> {
  requireRole(ctx, "operator", "retry posts");
  const { job, account } = await loadJobForUser(ctx, jobId);
  if (!["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"].includes(job.state)) throw conflict(`Only failed, blocked or unclear posts can be retried (this one is ${JOB_STATE_LABEL[job.state]}).`);
  if (job.state === "UNKNOWN_OUTCOME" && !opts.confirmedNoPost) throw validation("Confirm that you checked Instagram and the post is not live before retrying an unclear result.");
  if (job.errorCategory === "approval_changed" || job.errorCategory === "authorization_revoked") throw conflict("Re-approve the campaign instead of retrying this post.");
  if (!job.approvalId) throw conflict("This post has not been approved yet.");
  await withTx(ctx, async (tx) => {
    await transition(tx, job, "READY", { reason: `Retry requested by ${tx.actor.name}${job.state === "UNKNOWN_OUTCOME" ? " (confirmed no post exists on Instagram)" : ""}`, skipAttemptUpdate: true, extra: { maxAttempts: Math.max(job.maxAttempts, job.attemptCount + 1) } });
    await tx.db.update(accounts).set({ state: "ready", stateReason: "Retry requested", stateSince: tx.clock.now() }).where(and(eq(accounts.id, account.id), inArray(accounts.state, ["needs_review"])));
    await resolveNotificationsFor(tx, { jobId, kinds: ["unknown_outcome", "job_failed", "missed_schedule"] });
  });
}

export async function cancelJob(ctx: Ctx, jobId: string, reason?: string): Promise<void> {
  requireRole(ctx, "operator", "cancel posts");
  const { job, account } = await loadJobForUser(ctx, jobId);
  if (!canTransition(job.state, "CANCELLED")) throw conflict(`A ${JOB_STATE_LABEL[job.state]} post cannot be cancelled.`);
  await withTx(ctx, async (tx) => {
    await transition(tx, job, "CANCELLED", { reason: reason ?? `Cancelled by ${tx.actor.name}`, skipAttemptUpdate: true });
    await resolveNotificationsFor(tx, { jobId });
    await tx.db.update(accounts).set({ state: "ready", stateReason: "Exception resolved", stateSince: tx.clock.now() }).where(and(eq(accounts.id, account.id), eq(accounts.state, "needs_review")));
  });
}

/** Operator confirms on Instagram that an unclear post is live. */
export async function markJobPublished(ctx: Ctx, jobId: string, input: { postUrl: string; publishedAt?: string }): Promise<void> {
  requireRole(ctx, "operator", "confirm posts");
  const { job, account } = await loadJobForUser(ctx, jobId);
  if (job.state !== "UNKNOWN_OUTCOME") throw conflict("Only unclear results can be confirmed manually.");
  let url: URL;
  try {
    url = new URL(input.postUrl);
  } catch {
    throw validation("Enter the full Instagram post URL.");
  }
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) throw validation("The URL must be on instagram.com.");
  await withTx(ctx, async (tx) => {
    await markVerified(tx, job, account, { publishedAt: input.publishedAt ? new Date(input.publishedAt) : job.submittingAt ?? tx.clock.now(), publishedAtSource: input.publishedAt ? "instagram_reported" : "estimated", postUrl: url.toString(), externalId: null, evidenceKey: null, workerId: null, reconciled: true });
    await recordAudit(tx, { eventType: "job.confirmed_by_operator", message: `${tx.actor.name} confirmed the post is live on Instagram${input.publishedAt ? "" : " (publication time estimated from submission time)"}.`, jobId, accountId: account.id, campaignId: job.campaignId, isHumanIntervention: true, creatorId: account.creatorId });
  });
}

export async function holdJob(ctx: Ctx, jobId: string, reason: string): Promise<void> {
  requireRole(ctx, "operator", "hold posts");
  const { job } = await loadJobForUser(ctx, jobId);
  if (!canTransition(job.state, "HELD")) throw conflict(`A ${JOB_STATE_LABEL[job.state]} post cannot be put on hold.`);
  await transition(ctx, job, "HELD", { reason: reason || `Held by ${ctx.actor.name}`, skipAttemptUpdate: true });
}

export async function releaseJob(ctx: Ctx, jobId: string): Promise<void> {
  requireRole(ctx, "operator", "release posts");
  const { job } = await loadJobForUser(ctx, jobId);
  if (job.state !== "HELD") throw conflict("This post is not on hold.");
  if (!job.assetId) throw validation("Assign a video before releasing this slot.");
  if (!job.approvalId) throw validation("This slot needs campaign approval before it can post.");
  await transition(ctx, job, job.plannedAt <= ctx.clock.now() ? "READY" : "QUEUED", { reason: `Released by ${ctx.actor.name}`, skipAttemptUpdate: true });
}

// ---------- queries ----------
export type JobFilter = { accountId?: string; creatorId?: string; campaignId?: string; states?: JobState[]; from?: Date; to?: Date; limit?: number };
export type JobRow = PostingJob & { handle: string; displayName: string; avatarColor: string; creatorId: string; creatorName: string; campaignName: string; assetName: string | null; thumbnailKey: string | null; workerName: string | null };

export async function listJobs(ctx: Ctx, f: JobFilter = {}): Promise<JobRow[]> {
  const where: SQL[] = [eq(postingJobs.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`${accounts.creatorId} = ANY(${uuidArray(scope)})`);
  if (f.accountId) where.push(eq(postingJobs.accountId, f.accountId));
  if (f.creatorId) where.push(eq(accounts.creatorId, f.creatorId));
  if (f.campaignId) where.push(eq(postingJobs.campaignId, f.campaignId));
  if (f.states?.length) where.push(inArray(postingJobs.state, f.states));
  if (f.from) where.push(gte(postingJobs.plannedAt, f.from));
  if (f.to) where.push(lt(postingJobs.plannedAt, f.to));
  const rows = await ctx.db
    .select({ j: postingJobs, handle: accounts.handle, displayName: accounts.displayName, avatarColor: accounts.avatarColor, creatorId: accounts.creatorId, creatorName: creators.name, campaignName: campaigns.name, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey, workerName: workers.name })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .innerJoin(creators, eq(creators.id, accounts.creatorId))
    .innerJoin(campaigns, eq(campaigns.id, postingJobs.campaignId))
    .leftJoin(assets, eq(assets.id, postingJobs.assetId))
    .leftJoin(workers, eq(workers.id, postingJobs.leaseWorkerId))
    .where(and(...where))
    .orderBy(asc(postingJobs.plannedAt))
    .limit(Math.min(f.limit ?? 500, 5000));
  return rows.map((r) => ({ ...r.j, handle: r.handle, displayName: r.displayName, avatarColor: r.avatarColor, creatorId: r.creatorId, creatorName: r.creatorName, campaignName: r.campaignName, assetName: r.assetName, thumbnailKey: r.thumbnailKey, workerName: r.workerName }));
}

export async function getJobDetail(ctx: Ctx, jobId: string) {
  const { job, account } = await loadJobForUser(ctx, jobId);
  const [row] = await listJobs(ctx, { accountId: account.id, campaignId: job.campaignId, limit: 5000 }).then((rs) => rs.filter((r) => r.id === jobId));
  const attempts = await ctx.db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId)).orderBy(desc(jobAttempts.attemptNo));
  const verified = await ctx.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.jobId, jobId) });
  const analytics = verified ? await ctx.db.query.analyticsJobs.findFirst({ where: eq(analyticsJobs.verifiedPostId, verified.id) }) : null;
  return { job: row!, attempts, verified: verified ?? null, analytics: analytics ?? null };
}
