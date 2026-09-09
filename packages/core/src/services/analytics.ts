/**
 * Ten-hour analytics. One durable analytics job per verified post:
 *   due_at = actual_published_at + delayHours
 * Observation records the *actual* observation time and post age; a late check is stored as late,
 * never presented as an on-time observation. Missing metrics are unknown (null), never zero.
 */
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { accounts, analyticsJobs, analyticsObservations, assets, creators, postingJobs, verifiedPosts, workers, type AnalyticsJob, type ErrorCategory, type MetricObservation, type ThresholdResult } from "../db/schema";
import { minutes } from "../lib/clock";
import { AppError, conflict, notFound } from "../lib/errors";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { familySiblings } from "./content";
import { creatorScopeOf, requireRole, withTx, type Ctx } from "./context";
import { emitNotification, resolveNotificationsFor } from "./notifications";

const ANALYTICS_LEASE_MS = minutes(10);
const ANALYTICS_BACKOFF_MS = [minutes(15), minutes(30), minutes(60), minutes(120)];

export type ClaimedAnalyticsJob = {
  analyticsJobId: string;
  fence: number;
  leaseExpiresAt: string;
  dueAt: string;
  account: { id: string; handle: string; verifiedIgUserId: string | null; browserProfileKey: string | null; executionRoute: string };
  post: { verifiedPostId: string; postUrl: string | null; externalId: string | null; publishedAt: string; publishedAtSource: string; caption: string };
  targetAgeMinutes: number;
};

export async function promoteDueAnalytics(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const rows = await ctx.db.update(analyticsJobs).set({ state: "READY" }).where(and(eq(analyticsJobs.orgId, ctx.orgId), eq(analyticsJobs.state, "SCHEDULED"), lte(analyticsJobs.dueAt, now))).returning({ id: analyticsJobs.id });
  return rows.length;
}

export async function claimAnalytics(ctx: Ctx, params: { workerId: string; max: number }): Promise<{ jobs: ClaimedAnalyticsJob[]; reason?: string }> {
  if (ctx.actor.type !== "worker" || ctx.actor.id !== params.workerId) throw new AppError("forbidden", "Workers may only claim for themselves.");
  const worker = await ctx.db.query.workers.findFirst({ where: and(eq(workers.id, params.workerId), eq(workers.orgId, ctx.orgId)) });
  if (!worker || worker.status === "revoked") throw new AppError("unauthorized", "Worker is revoked.");
  if (ctx.settings.demoMode && worker.kind !== "simulator") return { jobs: [], reason: "Demo mode never authorizes live browser sessions." };
  const now = ctx.clock.now();
  const out: ClaimedAnalyticsJob[] = [];
  await withTx(ctx, async (tx) => {
    const candidates = await tx.db
      .select({ a: analyticsJobs, acc: accounts, post: verifiedPosts })
      .from(analyticsJobs)
      .innerJoin(accounts, eq(accounts.id, analyticsJobs.accountId))
      .innerJoin(verifiedPosts, eq(verifiedPosts.id, analyticsJobs.verifiedPostId))
      .where(
        and(
          eq(analyticsJobs.orgId, tx.orgId),
          eq(analyticsJobs.state, "READY"),
          eq(accounts.workerId, params.workerId),
          eq(accounts.sessionControl, "worker"),
          notInArray(accounts.state, ["needs_login"]),
          or(isNull(analyticsJobs.nextAttemptAt), lte(analyticsJobs.nextAttemptAt, now)),
          or(isNull(accounts.lockJobId), lt(accounts.lockExpiresAt, now)),
        ),
      )
      .orderBy(asc(analyticsJobs.dueAt))
      .limit(params.max * 3)
      .for("update", { of: analyticsJobs, skipLocked: true });
    const seen = new Set<string>();
    for (const { a, acc, post } of candidates) {
      if (out.length >= params.max) break;
      if (seen.has(acc.id)) continue;
      const [locked] = await tx.db
        .update(accounts)
        .set({ lockJobId: a.id, lockWorkerId: params.workerId, lockExpiresAt: new Date(now.getTime() + ANALYTICS_LEASE_MS) })
        .where(and(eq(accounts.id, acc.id), or(isNull(accounts.lockJobId), lt(accounts.lockExpiresAt, now))))
        .returning();
      if (!locked) continue;
      seen.add(acc.id);
      const fence = a.leaseFence + 1;
      await tx.db.update(analyticsJobs).set({ state: "RUNNING", leaseWorkerId: params.workerId, leaseFence: fence, leaseExpiresAt: new Date(now.getTime() + ANALYTICS_LEASE_MS), attemptCount: a.attemptCount + 1 }).where(eq(analyticsJobs.id, a.id));
      await recordAudit(tx, { eventType: "analytics.claimed", message: `Worker started the ${tx.settings.analytics.delayHours}h analytics check for @${acc.handle} (attempt ${a.attemptCount + 1}).`, analyticsJobId: a.id, accountId: acc.id, jobId: post.jobId, attemptNo: a.attemptCount + 1, creatorId: acc.creatorId });
      out.push({
        analyticsJobId: a.id,
        fence,
        leaseExpiresAt: new Date(now.getTime() + ANALYTICS_LEASE_MS).toISOString(),
        dueAt: a.dueAt.toISOString(),
        account: { id: acc.id, handle: acc.handle, verifiedIgUserId: acc.verifiedIgUserId, browserProfileKey: acc.browserProfileKey, executionRoute: acc.executionRoute },
        post: { verifiedPostId: post.id, postUrl: post.postUrl, externalId: post.externalId, publishedAt: post.publishedAt.toISOString(), publishedAtSource: post.publishedAtSource, caption: post.caption },
        targetAgeMinutes: tx.settings.analytics.delayHours * 60,
      });
    }
  });
  return { jobs: out };
}

export function evaluateThreshold(metrics: MetricObservation[], t: Ctx["settings"]["analytics"]["threshold"]): ThresholdResult {
  const m = metrics.find((x) => x.name === t.metric);
  const observed = m?.value ?? null;
  const result = observed == null ? "unknown" : t.comparator === "gt" ? (observed > t.value ? "met" : "not_met") : observed >= t.value ? "met" : "not_met";
  return { metric: t.metric, comparator: t.comparator, threshold: t.value, observed, result };
}

export type AnalyticsResult =
  | { outcome: "observed"; observedAt: string; metrics: MetricObservation[]; source: string; evidenceKey?: string | null; postFound: true }
  | { outcome: "post_not_found"; observedAt: string; evidenceKey?: string | null }
  | { outcome: "failed"; category: ErrorCategory; message: string; evidenceKey?: string | null };

export async function reportAnalytics(ctx: Ctx, analyticsJobId: string, fence: number, result: AnalyticsResult): Promise<{ state: AnalyticsJob["state"] }> {
  return withTx(ctx, async (tx) => {
    const a = await tx.db.query.analyticsJobs.findFirst({ where: and(eq(analyticsJobs.id, analyticsJobId), eq(analyticsJobs.orgId, tx.orgId)) });
    if (!a) throw notFound("Analytics job");
    if (tx.actor.type === "worker" && a.leaseWorkerId !== tx.actor.id) throw new AppError("forbidden", "Leased to a different worker.");
    if (a.leaseFence !== fence) throw new AppError("stale_fence", "Stale analytics lease.");
    if (a.state !== "RUNNING") throw conflict("Analytics job is not running.");
    const post = (await tx.db.query.verifiedPosts.findFirst({ where: eq(verifiedPosts.id, a.verifiedPostId) }))!;
    const account = (await tx.db.query.accounts.findFirst({ where: eq(accounts.id, a.accountId) }))!;
    const now = tx.clock.now();
    const release = () => tx.db.update(accounts).set({ lockJobId: null, lockWorkerId: null, lockExpiresAt: null }).where(and(eq(accounts.id, account.id), eq(accounts.lockJobId, a.id)));

    if (result.outcome === "observed" || result.outcome === "post_not_found") {
      const observedAt = new Date(result.observedAt);
      const postAgeMinutes = Math.round((observedAt.getTime() - post.publishedAt.getTime()) / 60000);
      const targetAgeMinutes = tx.settings.analytics.delayHours * 60;
      const latenessMinutes = Math.max(0, Math.round((observedAt.getTime() - a.dueAt.getTime()) / 60000));
      const isLate = latenessMinutes > tx.settings.analytics.lateAfterMinutes;
      const metrics = result.outcome === "observed" ? result.metrics : [];
      const threshold = evaluateThreshold(metrics, tx.settings.analytics.threshold);
      const siblings = post.assetId ? await familySiblings(tx, post.assetId) : [];
      const recommendations = threshold.result === "met" ? siblings.slice(0, 5).map((s) => ({ assetId: s.id, reason: `Same content family as a post that reached ${threshold.observed} ${threshold.metric}` })) : [];
      await tx.db.insert(analyticsObservations).values({
        orgId: tx.orgId,
        analyticsJobId: a.id,
        verifiedPostId: post.id,
        accountId: account.id,
        observedAt,
        postAgeMinutes,
        targetAgeMinutes,
        latenessMinutes,
        isLate,
        metrics,
        source: result.outcome === "observed" ? result.source : "post_not_found",
        executionRoute: account.executionRoute,
        evidenceKey: result.evidenceKey ?? null,
        threshold,
        recommendations,
      });
      await tx.db.update(analyticsJobs).set({ state: "COMPLETE", completedAt: now, leaseExpiresAt: null }).where(eq(analyticsJobs.id, a.id));
      await release();
      const ageLabel = `${Math.floor(postAgeMinutes / 60)}h ${postAgeMinutes % 60}m`;
      const thresholdLabel = `${threshold.metric} ${threshold.comparator === "gt" ? ">" : "≥"} ${threshold.threshold}`;
      const summary = result.outcome === "post_not_found"
        ? "The post could not be found on the profile at check time; metrics are unknown."
        : metrics.map((m) => `${m.name}: ${m.value ?? "unknown"}`).join(", ");
      await recordAudit(tx, { eventType: "analytics.observed", message: `Analytics observed at post age ${ageLabel}${isLate ? ` (late by ${latenessMinutes} min)` : ""}: ${summary}. Threshold ${thresholdLabel}: ${threshold.result.replace("_", " ")}.`, analyticsJobId: a.id, accountId: account.id, jobId: post.jobId, creatorId: account.creatorId, evidence: result.evidenceKey ? { screenshotKey: result.evidenceKey } : null });
      await emitNotification(tx, {
        eventId: `analytics_complete:${a.id}`,
        kind: "analytics_complete",
        severity: "info",
        title: `${tx.settings.analytics.delayHours}h report for @${account.handle}${isLate ? " (late)" : ""}`,
        body: `${summary}. Observed at post age ${ageLabel}. Threshold ${thresholdLabel}: ${threshold.result.replace("_", " ")}${recommendations.length ? `. ${recommendations.length} related video${recommendations.length === 1 ? "" : "s"} suggested` : ""}.`,
        accountId: account.id,
        creatorId: account.creatorId,
        jobId: post.jobId,
        analyticsJobId: a.id,
        data: { url: `/results?job=${post.jobId}`, isLate, threshold },
      });
      await resolveNotificationsFor(tx, { jobId: post.jobId, kinds: ["missed_analytics"] });
      return { state: "COMPLETE" };
    }

    // failed
    const loginProblem = result.category === "login_required" || result.category === "login_challenge";
    const exhausted = a.attemptCount >= a.maxAttempts;
    if (loginProblem) {
      await tx.db.update(analyticsJobs).set({ state: "BLOCKED", lastErrorCategory: result.category, lastErrorMessage: result.message, leaseExpiresAt: null }).where(eq(analyticsJobs.id, a.id));
      await tx.db.update(accounts).set({ state: "needs_login", stateReason: "Login required to read analytics", stateSince: now, sessionReadiness: "needs_login", sessionCheckedAt: now }).where(eq(accounts.id, account.id));
      await emitNotification(tx, { eventId: `login_required:analytics:${a.id}:${a.attemptCount}`, kind: "login_required", severity: "critical", title: `@${account.handle} needs a login (analytics check)`, body: `The ${tx.settings.analytics.delayHours}h analytics check could not run: ${result.message}. Log the account in and resume.`, accountId: account.id, creatorId: account.creatorId, analyticsJobId: a.id, jobId: post.jobId, data: { url: `/accounts?account=${account.id}` } });
    } else if (exhausted) {
      await tx.db.update(analyticsJobs).set({ state: "FAILED", lastErrorCategory: result.category, lastErrorMessage: result.message, leaseExpiresAt: null }).where(eq(analyticsJobs.id, a.id));
      await emitNotification(tx, { eventId: `missed_analytics:${a.id}`, kind: "missed_analytics", severity: "warning", title: `Analytics check failed for @${account.handle}`, body: `Gave up after ${a.attemptCount} attempts: ${result.message}.`, accountId: account.id, creatorId: account.creatorId, analyticsJobId: a.id, jobId: post.jobId, data: { url: `/results?job=${post.jobId}` } });
    } else {
      const backoff = ANALYTICS_BACKOFF_MS[Math.min(a.attemptCount - 1, ANALYTICS_BACKOFF_MS.length - 1)]!;
      await tx.db.update(analyticsJobs).set({ state: "READY", nextAttemptAt: new Date(now.getTime() + backoff), lastErrorCategory: result.category, lastErrorMessage: result.message, leaseExpiresAt: null }).where(eq(analyticsJobs.id, a.id));
    }
    await release();
    await recordAudit(tx, { eventType: "analytics.failed", message: `Analytics attempt ${a.attemptCount} failed: ${result.message}${loginProblem ? " (login required)" : exhausted ? " (no more retries)" : " (will retry)"}.`, analyticsJobId: a.id, accountId: account.id, jobId: post.jobId, attemptNo: a.attemptCount, errorCategory: result.category, creatorId: account.creatorId });
    return { state: loginProblem ? "BLOCKED" : exhausted ? "FAILED" : "READY" };
  });
}

export async function heartbeatAnalytics(ctx: Ctx, analyticsJobId: string, fence: number): Promise<void> {
  const a = await ctx.db.query.analyticsJobs.findFirst({ where: and(eq(analyticsJobs.id, analyticsJobId), eq(analyticsJobs.orgId, ctx.orgId)) });
  if (!a || a.leaseFence !== fence) throw new AppError("stale_fence", "Stale analytics lease.");
  const exp = new Date(ctx.clock.now().getTime() + ANALYTICS_LEASE_MS);
  await ctx.db.update(analyticsJobs).set({ leaseExpiresAt: exp }).where(eq(analyticsJobs.id, analyticsJobId));
  await ctx.db.update(accounts).set({ lockExpiresAt: exp }).where(and(eq(accounts.id, a.accountId), eq(accounts.lockJobId, analyticsJobId)));
}

/** Scheduler: expired RUNNING leases go back to READY; overdue checks raise a missed_analytics notification once. */
export async function maintainAnalytics(ctx: Ctx): Promise<{ requeued: number; overdueNotified: number }> {
  const now = ctx.clock.now();
  const stale = await ctx.db.update(analyticsJobs).set({ state: "READY", leaseExpiresAt: null, lastErrorCategory: "worker_lost", lastErrorMessage: "Worker stopped responding during the analytics check" }).where(and(eq(analyticsJobs.orgId, ctx.orgId), eq(analyticsJobs.state, "RUNNING"), lt(analyticsJobs.leaseExpiresAt, now))).returning({ id: analyticsJobs.id, accountId: analyticsJobs.accountId });
  for (const s of stale) await ctx.db.update(accounts).set({ lockJobId: null, lockWorkerId: null, lockExpiresAt: null }).where(and(eq(accounts.id, s.accountId), eq(accounts.lockJobId, s.id)));
  const overdueCutoff = new Date(now.getTime() - ctx.settings.analytics.lateAfterMinutes * 60000);
  const overdue = await ctx.db
    .select({ a: analyticsJobs, handle: accounts.handle, creatorId: accounts.creatorId, jobId: verifiedPosts.jobId, workerId: accounts.workerId, accState: accounts.state })
    .from(analyticsJobs)
    .innerJoin(accounts, eq(accounts.id, analyticsJobs.accountId))
    .innerJoin(verifiedPosts, eq(verifiedPosts.id, analyticsJobs.verifiedPostId))
    .where(and(eq(analyticsJobs.orgId, ctx.orgId), inArray(analyticsJobs.state, ["READY", "SCHEDULED"]), lt(analyticsJobs.dueAt, overdueCutoff)));
  let overdueNotified = 0;
  for (const o of overdue) {
    const why = !o.workerId ? "no worker is assigned" : o.accState === "offline" ? "the worker is offline" : o.accState === "needs_login" ? "the account needs a login" : o.a.lastErrorMessage ? `last attempt failed: ${o.a.lastErrorMessage}` : "no worker has picked it up";
    const lateMin = Math.round((now.getTime() - o.a.dueAt.getTime()) / 60000);
    const { created } = await emitNotification(ctx, { eventId: `missed_analytics:${o.a.id}`, kind: "missed_analytics", severity: "warning", title: `${ctx.settings.analytics.delayHours}h check overdue for @${o.handle}`, body: `Due ${o.a.dueAt.toISOString()}, now ${lateMin} min late because ${why}. When it runs, the report will be labeled late.`, accountId: o.a.accountId, creatorId: o.creatorId, analyticsJobId: o.a.id, jobId: o.jobId, data: { url: `/results?job=${o.jobId}` } });
    if (created) overdueNotified++;
  }
  return { requeued: stale.length, overdueNotified };
}

export async function retryAnalytics(ctx: Ctx, analyticsJobId: string): Promise<void> {
  requireRole(ctx, "operator", "retry analytics checks");
  const a = await ctx.db.query.analyticsJobs.findFirst({ where: and(eq(analyticsJobs.id, analyticsJobId), eq(analyticsJobs.orgId, ctx.orgId)) });
  if (!a) throw notFound("Analytics job");
  if (!["FAILED", "BLOCKED"].includes(a.state)) throw conflict("Only failed or blocked checks can be retried.");
  await ctx.db.update(analyticsJobs).set({ state: "READY", nextAttemptAt: null, maxAttempts: Math.max(a.maxAttempts, a.attemptCount + 1) }).where(eq(analyticsJobs.id, analyticsJobId));
  await recordAudit(ctx, { eventType: "analytics.retry_requested", message: `${ctx.actor.name} requested another analytics attempt.`, analyticsJobId, accountId: a.accountId, isHumanIntervention: true });
}

// ---------- results queries ----------
export type ResultRow = {
  post: typeof verifiedPosts.$inferSelect;
  handle: string;
  displayName: string;
  avatarColor: string;
  creatorId: string;
  creatorName: string;
  assetName: string | null;
  thumbnailKey: string | null;
  familyId: string | null;
  analytics: AnalyticsJob | null;
  observation: typeof analyticsObservations.$inferSelect | null;
  workerName: string | null;
};

export async function listResults(ctx: Ctx, f: { accountId?: string; creatorId?: string; from?: Date; to?: Date; limit?: number; onlyProblems?: boolean } = {}): Promise<ResultRow[]> {
  const where: SQL[] = [eq(verifiedPosts.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`${accounts.creatorId} = ANY(${uuidArray(scope)})`);
  if (f.accountId) where.push(eq(verifiedPosts.accountId, f.accountId));
  if (f.creatorId) where.push(eq(accounts.creatorId, f.creatorId));
  if (f.from) where.push(gte(verifiedPosts.publishedAt, f.from));
  if (f.to) where.push(lt(verifiedPosts.publishedAt, f.to));
  const rows = await ctx.db
    .select({ post: verifiedPosts, handle: accounts.handle, displayName: accounts.displayName, avatarColor: accounts.avatarColor, creatorId: accounts.creatorId, creatorName: creators.name, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey, familyId: assets.familyId, analytics: analyticsJobs, workerName: workers.name })
    .from(verifiedPosts)
    .innerJoin(accounts, eq(accounts.id, verifiedPosts.accountId))
    .innerJoin(creators, eq(creators.id, accounts.creatorId))
    .leftJoin(assets, eq(assets.id, verifiedPosts.assetId))
    .leftJoin(analyticsJobs, eq(analyticsJobs.verifiedPostId, verifiedPosts.id))
    .leftJoin(workers, eq(workers.id, verifiedPosts.verifiedByWorkerId))
    .where(and(...where))
    .orderBy(desc(verifiedPosts.publishedAt))
    .limit(Math.min(f.limit ?? 300, 2000));
  const ids = rows.map((r) => r.post.id);
  const obs = ids.length ? await ctx.db.select().from(analyticsObservations).where(inArray(analyticsObservations.verifiedPostId, ids)).orderBy(desc(analyticsObservations.observedAt)) : [];
  const obsByPost = new Map<string, typeof obs[number]>();
  for (const o of obs) if (!obsByPost.has(o.verifiedPostId)) obsByPost.set(o.verifiedPostId, o);
  const out = rows.map((r) => ({ ...r, analytics: r.analytics ?? null, observation: obsByPost.get(r.post.id) ?? null }));
  if (f.onlyProblems) return out.filter((r) => !r.analytics || r.analytics.state === "FAILED" || r.analytics.state === "BLOCKED" || r.observation?.isLate || (r.analytics.state !== "COMPLETE" && r.analytics.dueAt < ctx.clock.now()));
  return out;
}

/** Observations for other posts on the same account/creator with a similar post age (±90 min), for comparison. */
export async function similarAgeComparison(ctx: Ctx, verifiedPostId: string): Promise<{ scope: "account" | "creator"; rows: Array<{ verifiedPostId: string; handle: string; postAgeMinutes: number; metrics: MetricObservation[]; publishedAt: Date }> }> {
  const target = await ctx.db.select({ o: analyticsObservations, acc: accounts }).from(analyticsObservations).innerJoin(accounts, eq(accounts.id, analyticsObservations.accountId)).where(and(eq(analyticsObservations.orgId, ctx.orgId), eq(analyticsObservations.verifiedPostId, verifiedPostId))).limit(1);
  const t = target[0];
  if (!t) return { scope: "account", rows: [] };
  const pick = async (scope: "account" | "creator") => {
    const cond = scope === "account" ? eq(analyticsObservations.accountId, t.acc.id) : eq(accounts.creatorId, t.acc.creatorId);
    return ctx.db
      .select({ verifiedPostId: analyticsObservations.verifiedPostId, handle: accounts.handle, postAgeMinutes: analyticsObservations.postAgeMinutes, metrics: analyticsObservations.metrics, publishedAt: verifiedPosts.publishedAt })
      .from(analyticsObservations)
      .innerJoin(accounts, eq(accounts.id, analyticsObservations.accountId))
      .innerJoin(verifiedPosts, eq(verifiedPosts.id, analyticsObservations.verifiedPostId))
      .where(and(eq(analyticsObservations.orgId, ctx.orgId), cond, sql`${analyticsObservations.verifiedPostId} <> ${verifiedPostId}`, sql`abs(${analyticsObservations.postAgeMinutes} - ${t.o.postAgeMinutes}) <= 90`))
      .orderBy(desc(verifiedPosts.publishedAt))
      .limit(8);
  };
  const acc = await pick("account");
  if (acc.length >= 2) return { scope: "account", rows: acc };
  return { scope: "creator", rows: await pick("creator") };
}

export async function accountPostingHistory(ctx: Ctx, accountId: string, limit = 50) {
  return ctx.db
    .select({ post: verifiedPosts, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey, analyticsState: analyticsJobs.state, job: postingJobs })
    .from(verifiedPosts)
    .leftJoin(assets, eq(assets.id, verifiedPosts.assetId))
    .leftJoin(analyticsJobs, eq(analyticsJobs.verifiedPostId, verifiedPosts.id))
    .innerJoin(postingJobs, eq(postingJobs.id, verifiedPosts.jobId))
    .where(and(eq(verifiedPosts.orgId, ctx.orgId), eq(verifiedPosts.accountId, accountId)))
    .orderBy(desc(verifiedPosts.publishedAt))
    .limit(limit);
}
