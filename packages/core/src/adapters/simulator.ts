/**
 * Simulator adapter. Exercises the whole pipeline (claims, leases, identity checks, submission,
 * verification, unknown outcomes, login failures, analytics) without touching Instagram.
 *
 * Scenarios are selected by tags on the account (`sim:needs_login`, `sim:unknown_outcome`,
 * `sim:mismatch`, `sim:fail_network`, `sim:slow`, `sim:no_metrics`) so the seed data can stage
 * every exception the dashboard must handle. Results are labeled "Simulated" everywhere.
 */
import { createHash } from "node:crypto";
import type { ClaimedAnalyticsJob } from "../services/analytics";
import type { ClaimedJob } from "../services/jobs";
import type { AccountRef, AdapterControl, Capabilities, IdentityCheck, MetricsOutcome, PublishOutcome, PublisherAdapter, ReconcileOutcome } from "./types";

export type SimulatorOptions = {
  /** Base delay per step in ms (default 1500). Tests use 0. */
  stepDelayMs?: number;
  /** Account tags by account id (the worker learns them from the claim payload). */
  tagsFor?: (accountId: string, handle: string) => string[];
  now?: () => Date;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seeded(key: string): number {
  const h = createHash("sha256").update(key).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

export class SimulatorAdapter implements PublisherAdapter {
  readonly kind = "simulator" as const;
  readonly executionLabel = "Simulated";
  private opts: Required<Pick<SimulatorOptions, "stepDelayMs" | "now">> & SimulatorOptions;
  /** In-memory record of "published" posts so reconcile/readMetrics behave consistently. */
  private published = new Map<string, { postUrl: string; externalId: string; publishedAt: string }>();

  constructor(opts: SimulatorOptions = {}) {
    this.opts = { stepDelayMs: opts.stepDelayMs ?? 1500, now: opts.now ?? (() => new Date()), tagsFor: opts.tagsFor };
  }

  private tags(account: { id: string; handle: string }): string[] {
    return this.opts.tagsFor?.(account.id, account.handle) ?? [];
  }

  async capabilities(): Promise<Capabilities> {
    return { canVerifyIdentity: true, canPublish: true, canReconcile: true, canReadMetrics: true, live: false, notes: ["Simulated execution only. Nothing is sent to Instagram.", "Scenario tags on accounts drive failures, login prompts and unclear results."] };
  }

  async checkReadiness(account: AccountRef) {
    const t = this.tags(account);
    if (t.includes("sim:needs_login")) return { ready: false, reason: "Simulated: browser profile is logged out" };
    return { ready: true };
  }

  async verifyIdentity(account: AccountRef, ctrl: Pick<AdapterControl, "log" | "storeEvidence">): Promise<IdentityCheck> {
    await sleep(this.opts.stepDelayMs / 3);
    const t = this.tags(account);
    if (t.includes("sim:needs_login")) {
      ctrl.log(`simulated: @${account.handle} profile is logged out`);
      return { sessionReady: false, observedHandle: null, observedIgUserId: null };
    }
    if (t.includes("sim:mismatch")) {
      return { sessionReady: true, observedHandle: `${account.handle}.other`, observedIgUserId: `sim-${seeded(account.handle + "other").toString(36).slice(2, 12)}` };
    }
    return { sessionReady: true, observedHandle: account.handle, observedIgUserId: account.verifiedIgUserId ?? `sim-${createHash("sha1").update(account.handle).digest("hex").slice(0, 10)}` };
  }

  async publish(job: ClaimedJob, ctrl: AdapterControl): Promise<PublishOutcome> {
    const t = this.tags(job.account);
    const steps = t.includes("sim:slow") ? 4 : 2;
    for (let i = 0; i < steps; i++) {
      await sleep(this.opts.stepDelayMs);
      ctrl.log(`simulated: upload/caption step ${i + 1}/${steps} for @${job.account.handle}`);
      if (!(await ctrl.heartbeat())) return { outcome: "failed", category: "internal", message: "Simulated: lease lost during upload (nothing was submitted)" };
    }
    if (t.includes("sim:fail_network")) {
      return { outcome: "failed", category: "network", message: "Simulated network failure while uploading (before Share was clicked)" };
    }
    if (t.includes("sim:unsupported")) {
      return { outcome: "blocked", category: "unsupported_format", message: "Simulated: Instagram rejected the video format" };
    }
    // "Click Share"
    await sleep(this.opts.stepDelayMs);
    if (t.includes("sim:unknown_outcome")) {
      return { outcome: "unknown", message: "Simulated: the page timed out after Share was clicked; the post may or may not be live" };
    }
    const publishedAt = this.opts.now().toISOString();
    const externalId = `sim${createHash("sha1").update(job.idempotencyKey).digest("hex").slice(0, 11)}`;
    const postUrl = `https://www.instagram.com/reel/${externalId}/`;
    this.published.set(job.jobId, { postUrl, externalId, publishedAt });
    const evidenceKey = await ctrl.storeEvidence("verified.txt", Buffer.from(`Simulated verification for ${job.idempotencyKey} at ${publishedAt}\nPost URL: ${postUrl}\n`), "text/plain");
    ctrl.log(`simulated: verified live at ${postUrl}`);
    return { outcome: "verified", postUrl, externalId, publishedAt, publishedAtSource: "worker_observed", evidenceKey };
  }

  async reconcile(job: Pick<ClaimedJob, "jobId" | "account" | "content" | "idempotencyKey">): Promise<ReconcileOutcome> {
    await sleep(this.opts.stepDelayMs / 2);
    // Ambiguous scenario: the simulated profile page cannot be read, so a human must decide.
    if (this.tags(job.account).includes("sim:unknown_outcome")) return { found: "unknown", message: "Simulated: profile grid did not load; cannot tell whether the post exists" };
    const found = this.published.get(job.jobId);
    if (found) return { found: true, ...found, publishedAtSource: "worker_observed" };
    return { found: false, notes: "Simulated: profile grid shows no matching post" };
  }

  async readMetrics(job: ClaimedAnalyticsJob, ctrl: Pick<AdapterControl, "log" | "storeEvidence" | "heartbeat">): Promise<MetricsOutcome> {
    await sleep(this.opts.stepDelayMs / 2);
    const t = this.tags(job.account);
    if (t.includes("sim:needs_login")) return { outcome: "failed", category: "login_required", message: "Simulated: browser profile is logged out" };
    if (t.includes("sim:analytics_fail")) return { outcome: "failed", category: "instagram_error", message: "Simulated: insights page failed to load" };
    const observedAt = this.opts.now().toISOString();
    if (t.includes("sim:post_missing")) return { outcome: "post_not_found", observedAt };
    const seed = seeded(job.post.verifiedPostId);
    const plays = Math.round(200 + seed * 4000 + (t.includes("sim:viral") ? 20000 : 0));
    const likes = Math.round(plays * (0.03 + seed * 0.05));
    const comments = Math.round(likes * 0.08);
    const metrics = [
      { name: "plays", value: plays, source: "simulator:insights.plays" },
      { name: "likes", value: likes, source: "simulator:post.likes" },
      { name: "comments", value: comments, source: "simulator:post.comments" },
      { name: "reach", value: t.includes("sim:no_metrics") ? null : Math.round(plays * 0.7), source: "simulator:insights.reach", note: t.includes("sim:no_metrics") ? "Reach was not available on the insights page" : undefined },
    ];
    const evidenceKey = await ctrl.storeEvidence("insights.txt", Buffer.from(`Simulated insights for ${job.post.postUrl}\n${metrics.map((m) => `${m.name}=${m.value ?? "unknown"}`).join("\n")}\n`), "text/plain");
    ctrl.log(`simulated: read ${metrics.length} metrics for ${job.post.postUrl}`);
    return { outcome: "observed", observedAt, metrics, source: "simulator", evidenceKey };
  }
}
