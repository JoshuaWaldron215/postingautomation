import { type SQL, and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { accounts, analyticsJobs, auditEvents, creators, notifications, postingJobs, users, verifiedPosts, workers, type Account, type Creator, type PostingPolicy } from "../db/schema";
import { AppError, conflict, notFound, validation } from "../lib/errors";
import { ACCOUNT_STATE_LABEL } from "../lib/states";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { invalidateApprovalsForAccount } from "./campaigns";
import { assertCreatorAccess, creatorScopeOf, requireRole, withTx, type Ctx } from "./context";
import { isValidTimezone } from "./scheduling";
import { emitNotification, resolveNotificationsFor } from "./notifications";

export type AccountRow = Account & {
  creatorName: string;
  creatorColor: string;
  creatorPausedAt: Date | null;
  workerName: string | null;
  workerStatus: string | null;
  nextScheduledAt: Date | null;
  approvedRemaining: number;
  heldForContent: number;
  openExceptions: number;
  unresolvedNotifications: number;
  /** Derived, plain-language explanation of the current state. */
  stateExplanation: string;
  needsAttention: boolean;
  effectiveState: Account["state"];
};

export type AccountFilter = {
  q?: string;
  creatorId?: string;
  states?: Account["state"][];
  needsAttention?: boolean;
  workerId?: string;
  pinnedIds?: string[];
  onlyPinned?: boolean;
  sort?: "handle" | "creator" | "state" | "next";
  limit?: number;
};

function explain(a: Account, extra: { creatorPausedAt: Date | null; workerName: string | null; workerStatus: string | null; heldForContent: number; approvedRemaining: number; globalPause: boolean }): { state: Account["state"]; explanation: string; needsAttention: boolean } {
  if (extra.globalPause) return { state: "paused", explanation: "All posting is paused for the organization.", needsAttention: false };
  if (extra.creatorPausedAt) return { state: "paused", explanation: "The creator is paused, so this account does not post.", needsAttention: false };
  if (a.pausedAt) return { state: "paused", explanation: a.pausedReason ? `Paused: ${a.pausedReason}` : "Paused by an operator.", needsAttention: false };
  if (a.sessionControl === "human_handoff") return { state: "needs_review", explanation: "A person has taken over the browser session; automatic posting waits until they hand it back.", needsAttention: true };
  if (!a.workerId) return { state: "unassigned", explanation: "No worker is assigned, so nothing can post here yet.", needsAttention: extra.approvedRemaining > 0 };
  if (extra.workerStatus === "offline" || a.state === "offline") return { state: "offline", explanation: `Worker “${extra.workerName ?? "unknown"}” is offline. Scheduled posts are held, not lost.`, needsAttention: true };
  if (extra.workerStatus === "never_connected") return { state: "offline", explanation: `Worker “${extra.workerName}” has never connected.`, needsAttention: extra.approvedRemaining > 0 };
  if (a.state === "needs_login") return { state: "needs_login", explanation: a.stateReason ?? "The browser session is logged out. Complete the login handoff to resume.", needsAttention: true };
  if (a.state === "needs_review") return { state: "needs_review", explanation: a.stateReason ?? "An exception needs a decision.", needsAttention: true };
  if (a.state === "posting") return { state: "posting", explanation: a.stateReason ?? "Publishing a post right now.", needsAttention: false };
  if (extra.heldForContent > 0) return { state: "ready", explanation: `Ready, but ${extra.heldForContent} upcoming slot${extra.heldForContent === 1 ? "" : "s"} have no content.`, needsAttention: true };
  if (a.sessionReadiness === "needs_login") return { state: "needs_login", explanation: "Last session check found the account logged out.", needsAttention: true };
  return { state: "ready", explanation: a.sessionReadiness === "ready" ? "Logged in and ready to post." : "Ready. Session readiness has not been checked yet; the worker verifies identity before every post.", needsAttention: false };
}

export async function listAccounts(ctx: Ctx, f: AccountFilter = {}): Promise<AccountRow[]> {
  const where: SQL[] = [eq(accounts.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`${accounts.creatorId} = ANY(${uuidArray(scope)})`);
  if (f.creatorId) where.push(eq(accounts.creatorId, f.creatorId));
  if (f.workerId) where.push(eq(accounts.workerId, f.workerId));
  if (f.q) {
    const q = f.q.replace(/^@/, "");
    where.push(or(ilike(accounts.handle, `%${q}%`), ilike(accounts.displayName, `%${q}%`), ilike(creators.name, `%${q}%`))!);
  }
  if (f.onlyPinned) where.push(f.pinnedIds?.length ? inArray(accounts.id, f.pinnedIds) : sql`false`);
  const rows = await ctx.db
    .select({
      a: accounts,
      creatorName: creators.name,
      creatorColor: creators.color,
      creatorPausedAt: creators.pausedAt,
      workerName: workers.name,
      workerStatus: workers.status,
      nextScheduledAt: sql<Date | null>`(select min(j.planned_at) from ${postingJobs} j where j.account_id = ${accounts.id} and j.state in ('QUEUED','READY'))`,
      approvedRemaining: sql<number>`(select count(*)::int from ${postingJobs} j where j.account_id = ${accounts.id} and j.approval_id is not null and j.state in ('QUEUED','READY','HELD'))`,
      heldForContent: sql<number>`(select count(*)::int from ${postingJobs} j where j.account_id = ${accounts.id} and j.state = 'HELD' and j.error_category = 'content_missing')`,
      openExceptions: sql<number>`(select count(*)::int from ${postingJobs} j where j.account_id = ${accounts.id} and j.state in ('BLOCKED','FAILED','UNKNOWN_OUTCOME'))`,
      unresolvedNotifications: sql<number>`(select count(*)::int from ${notifications} n where n.account_id = ${accounts.id} and n.resolved_at is null and n.severity <> 'info')`,
    })
    .from(accounts)
    .innerJoin(creators, eq(creators.id, accounts.creatorId))
    .leftJoin(workers, eq(workers.id, accounts.workerId))
    .where(and(...where))
    .orderBy(f.sort === "creator" ? asc(creators.name) : asc(accounts.handle), asc(accounts.handle))
    .limit(Math.min(f.limit ?? 1000, 5000));
  const globalPause = ctx.settings.globalPause.active;
  let out: AccountRow[] = rows.map((r) => {
    const e = explain(r.a, { creatorPausedAt: r.creatorPausedAt, workerName: r.workerName, workerStatus: r.workerStatus, heldForContent: r.heldForContent, approvedRemaining: r.approvedRemaining, globalPause });
    const needsAttention = e.needsAttention || r.openExceptions > 0;
    return {
      ...r.a,
      creatorName: r.creatorName,
      creatorColor: r.creatorColor,
      creatorPausedAt: r.creatorPausedAt,
      workerName: r.workerName,
      workerStatus: r.workerStatus,
      nextScheduledAt: r.nextScheduledAt ? new Date(r.nextScheduledAt) : null,
      approvedRemaining: r.approvedRemaining,
      heldForContent: r.heldForContent,
      openExceptions: r.openExceptions,
      unresolvedNotifications: r.unresolvedNotifications,
      stateExplanation: r.openExceptions > 0 && e.state === "ready" ? `${r.openExceptions} post${r.openExceptions === 1 ? "" : "s"} need a decision.` : e.explanation,
      needsAttention,
      effectiveState: r.openExceptions > 0 && e.state === "ready" ? "needs_review" : e.state,
    };
  });
  if (f.states?.length) out = out.filter((a) => f.states!.includes(a.effectiveState));
  if (f.needsAttention) out = out.filter((a) => a.needsAttention);
  if (f.sort === "state") out.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || a.handle.localeCompare(b.handle));
  if (f.sort === "next") out.sort((a, b) => (a.nextScheduledAt?.getTime() ?? Infinity) - (b.nextScheduledAt?.getTime() ?? Infinity));
  return out;
}

export async function getAccount(ctx: Ctx, id: string): Promise<AccountRow> {
  const rows = await listAccounts(ctx, { limit: 5000 });
  const row = rows.find((a) => a.id === id);
  if (!row) throw notFound("Account");
  return row;
}

export async function accountActivity(ctx: Ctx, id: string, limit = 60) {
  return ctx.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.accountId, id))).orderBy(desc(auditEvents.at)).limit(limit);
}

export async function accountJobs(ctx: Ctx, id: string) {
  return ctx.db.select().from(postingJobs).where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.accountId, id))).orderBy(desc(postingJobs.plannedAt)).limit(200);
}

export async function accountAnalyticsSummary(ctx: Ctx, id: string) {
  const rows = await ctx.db.select({ state: analyticsJobs.state, n: sql<number>`count(*)::int` }).from(analyticsJobs).where(and(eq(analyticsJobs.orgId, ctx.orgId), eq(analyticsJobs.accountId, id))).groupBy(analyticsJobs.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

// ---------- mutations ----------
export async function pauseAccounts(ctx: Ctx, ids: string[], reason?: string): Promise<number> {
  requireRole(ctx, "operator", "pause accounts");
  let n = 0;
  for (const id of ids) {
    const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
    if (!a) continue;
    assertCreatorAccess(ctx, a.creatorId);
    if (a.pausedAt) continue;
    await ctx.db.update(accounts).set({ pausedAt: ctx.clock.now(), pausedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null, pausedReason: reason ?? null, state: "paused", stateReason: reason ?? "Paused by an operator", stateSince: ctx.clock.now() }).where(eq(accounts.id, id));
    const inflight = a.state === "posting";
    await recordAudit(ctx, { eventType: "account.paused", message: `Paused @${a.handle}${reason ? `: ${reason}` : ""}. No new posts will start${inflight ? "; the post already in progress will finish" : ""}.`, accountId: id, creatorId: a.creatorId, isHumanIntervention: true });
    n++;
  }
  return n;
}

export async function resumeAccounts(ctx: Ctx, ids: string[]): Promise<number> {
  requireRole(ctx, "operator", "resume accounts");
  let n = 0;
  for (const id of ids) {
    const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
    if (!a || !a.pausedAt) continue;
    assertCreatorAccess(ctx, a.creatorId);
    await ctx.db.update(accounts).set({ pausedAt: null, pausedByUserId: null, pausedReason: null, state: a.sessionReadiness === "needs_login" ? "needs_login" : "ready", stateReason: "Resumed", stateSince: ctx.clock.now() }).where(eq(accounts.id, id));
    await recordAudit(ctx, { eventType: "account.resumed", message: `Resumed @${a.handle}. Overdue posts will publish in order, keeping the minimum spacing.`, accountId: id, creatorId: a.creatorId, isHumanIntervention: true });
    n++;
  }
  return n;
}

export async function updateAccount(ctx: Ctx, id: string, patch: { displayName?: string; creatorId?: string; timezone?: string; postingPolicy?: PostingPolicy; workerId?: string | null; executionRoute?: Account["executionRoute"]; browserProfileKey?: string | null; tags?: string[] }): Promise<{ account: Account; invalidatedJobs: number }> {
  requireRole(ctx, "operator", "edit accounts");
  const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
  if (!a) throw notFound("Account");
  assertCreatorAccess(ctx, a.creatorId);
  if (patch.creatorId) assertCreatorAccess(ctx, patch.creatorId);
  if (patch.timezone && !isValidTimezone(patch.timezone)) throw validation("Unknown timezone. Use an IANA name like America/New_York.");
  if (patch.workerId) {
    const w = await ctx.db.query.workers.findFirst({ where: and(eq(workers.id, patch.workerId), eq(workers.orgId, ctx.orgId)) });
    if (!w) throw validation("Worker not found.");
    if (w.status === "revoked") throw validation("That worker was revoked.");
  }
  if (patch.executionRoute && ["pixel", "official_api"].includes(patch.executionRoute)) throw validation("That route is a future adapter and is not available yet.");
  const bindingChanged = (patch.timezone && patch.timezone !== a.timezone) || (patch.creatorId && patch.creatorId !== a.creatorId);
  const values: Partial<typeof accounts.$inferInsert> = {};
  if (patch.displayName !== undefined) values.displayName = patch.displayName.trim();
  if (patch.creatorId !== undefined) values.creatorId = patch.creatorId;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.postingPolicy !== undefined) values.postingPolicy = patch.postingPolicy;
  if (patch.workerId !== undefined) {
    values.workerId = patch.workerId;
    values.state = patch.workerId ? (a.state === "unassigned" || a.state === "offline" ? "ready" : a.state) : "unassigned";
    values.stateSince = ctx.clock.now();
    if (patch.workerId && !a.browserProfileKey && patch.browserProfileKey === undefined) values.browserProfileKey = `profile-${a.handle}`;
  }
  if (patch.executionRoute !== undefined) values.executionRoute = patch.executionRoute;
  if (patch.browserProfileKey !== undefined) values.browserProfileKey = patch.browserProfileKey;
  if (patch.tags !== undefined) values.tags = patch.tags;
  return withTx(ctx, async (tx) => {
    const [row] = await tx.db.update(accounts).set(values).where(eq(accounts.id, id)).returning();
    let invalidatedJobs = 0;
    if (bindingChanged) invalidatedJobs = await invalidateApprovalsForAccount(tx, id, patch.timezone && patch.timezone !== a.timezone ? "timezone changed" : "creator changed");
    await recordAudit(tx, { eventType: "account.updated", message: `Updated ${Object.keys(values).join(", ")} on @${a.handle}${invalidatedJobs ? `; ${invalidatedJobs} approved jobs need re-approval` : ""}.`, accountId: id, creatorId: row!.creatorId, isHumanIntervention: true, metadata: { patch } });
    return { account: row!, invalidatedJobs };
  });
}

export async function createAccount(ctx: Ctx, input: { handle: string; displayName: string; creatorId: string; timezone: string; executionRoute?: Account["executionRoute"]; workerId?: string | null; postingPolicy?: PostingPolicy }): Promise<Account> {
  requireRole(ctx, "operator", "add accounts");
  assertCreatorAccess(ctx, input.creatorId);
  const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) throw validation("Handles may contain letters, numbers, periods and underscores (max 30).");
  if (!isValidTimezone(input.timezone)) throw validation("Unknown timezone.");
  const existing = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.orgId, ctx.orgId), eq(accounts.handle, handle)) });
  if (existing) throw conflict(`@${handle} already exists.`);
  const [row] = await ctx.db
    .insert(accounts)
    .values({ orgId: ctx.orgId, creatorId: input.creatorId, handle, displayName: input.displayName.trim() || handle, timezone: input.timezone, executionRoute: input.executionRoute ?? "browser_hermes", workerId: input.workerId ?? null, browserProfileKey: `profile-${handle}`, state: input.workerId ? "ready" : "unassigned", stateReason: input.workerId ? "Added" : "No worker assigned yet", postingPolicy: input.postingPolicy ?? { ongoingTimes: ["11:00", "18:00"], dayOne: { count: 3, spacingMinutes: 5 } } })
    .returning();
  await recordAudit(ctx, { eventType: "account.created", message: `Added @${handle}.`, accountId: row!.id, creatorId: input.creatorId, isHumanIntervention: true });
  return row!;
}

/**
 * Operator-assisted login handoff. The operator takes control of the account's browser session
 * on the execution host; while control is "human_handoff" the worker will not claim jobs for it.
 * Passwords are never collected here; the login happens in the browser on the Mac.
 */
export async function startLoginHandoff(ctx: Ctx, id: string, minutes = 30): Promise<Account> {
  requireRole(ctx, "operator", "start a login handoff");
  const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
  if (!a) throw notFound("Account");
  assertCreatorAccess(ctx, a.creatorId);
  if (a.lockJobId && a.lockExpiresAt && a.lockExpiresAt > ctx.clock.now()) throw conflict("A post is being published on this account right now. Wait for it to finish before taking over the session.");
  if (a.sessionControl === "human_handoff" && a.handoffExpiresAt && a.handoffExpiresAt > ctx.clock.now()) throw conflict("Someone already has this session.");
  const now = ctx.clock.now();
  const [row] = await ctx.db.update(accounts).set({ sessionControl: "human_handoff", handoffByUserId: ctx.actor.type === "user" ? ctx.actor.id : null, handoffStartedAt: now, handoffExpiresAt: new Date(now.getTime() + minutes * 60000) }).where(eq(accounts.id, id)).returning();
  await recordAudit(ctx, { eventType: "account.handoff_started", message: `${ctx.actor.name} took control of the browser session for @${a.handle} for up to ${minutes} minutes. Automatic posting waits.`, accountId: id, creatorId: a.creatorId, isHumanIntervention: true });
  return row!;
}

export async function endLoginHandoff(ctx: Ctx, id: string, outcome: { loggedIn: boolean; notes?: string }): Promise<Account> {
  requireRole(ctx, "operator", "end a login handoff");
  const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
  if (!a) throw notFound("Account");
  assertCreatorAccess(ctx, a.creatorId);
  const now = ctx.clock.now();
  const [row] = await ctx.db
    .update(accounts)
    .set({ sessionControl: "worker", handoffByUserId: null, handoffStartedAt: null, handoffExpiresAt: null, sessionReadiness: outcome.loggedIn ? "ready" : "needs_login", sessionCheckedAt: now, state: outcome.loggedIn ? (a.pausedAt ? "paused" : "ready") : "needs_login", stateReason: outcome.loggedIn ? "Login handoff completed; the worker re-verifies identity before posting" : outcome.notes ?? "Login was not completed", stateSince: now })
    .where(eq(accounts.id, id))
    .returning();
  await recordAudit(ctx, { eventType: "account.handoff_ended", message: outcome.loggedIn ? `${ctx.actor.name} handed the session for @${a.handle} back to the worker after logging in.` : `${ctx.actor.name} ended the session handoff for @${a.handle} without completing login${outcome.notes ? `: ${outcome.notes}` : ""}.`, accountId: id, creatorId: a.creatorId, isHumanIntervention: true });
  if (outcome.loggedIn) {
    await resolveNotificationsFor(ctx, { accountId: id, kinds: ["login_required"] });
    await ctx.db.update(postingJobs).set({ state: "READY", stateReason: "Login completed; retrying", errorCategory: null, updatedAt: now }).where(and(eq(postingJobs.accountId, id), eq(postingJobs.state, "BLOCKED"), inArray(postingJobs.errorCategory, ["login_required", "login_challenge"]), sql`${postingJobs.approvalId} IS NOT NULL`));
    await ctx.db.update(analyticsJobs).set({ state: "READY", nextAttemptAt: null }).where(and(eq(analyticsJobs.accountId, id), eq(analyticsJobs.state, "BLOCKED")));
  }
  return row!;
}

/** Scheduler: expired handoffs return control to the worker (session readiness unknown until checked). */
export async function expireHandoffs(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const rows = await ctx.db.update(accounts).set({ sessionControl: "worker", handoffByUserId: null, handoffStartedAt: null, handoffExpiresAt: null, sessionReadiness: "unknown" }).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.sessionControl, "human_handoff"), lt(accounts.handoffExpiresAt, now))).returning({ id: accounts.id, handle: accounts.handle, creatorId: accounts.creatorId });
  for (const r of rows) await recordAudit(ctx, { eventType: "account.handoff_expired", message: `The session handoff for @${r.handle} expired and control returned to the worker.`, accountId: r.id, creatorId: r.creatorId });
  return rows.length;
}

/** Worker reports what it observed about a session (readiness + identity) outside of a job. */
export async function reportSession(ctx: Ctx, accountId: string, obs: { readiness: Account["sessionReadiness"]; observedHandle?: string | null; observedIgUserId?: string | null }): Promise<void> {
  const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, accountId), eq(accounts.orgId, ctx.orgId)) });
  if (!a) throw notFound("Account");
  if (ctx.actor.type === "worker" && a.workerId !== ctx.actor.id) throw new AppError("forbidden", "This account is not assigned to this worker.");
  const now = ctx.clock.now();
  const values: Partial<typeof accounts.$inferInsert> = { sessionReadiness: obs.readiness, sessionCheckedAt: now };
  let mismatch = false;
  if (obs.readiness === "ready" && obs.observedHandle && obs.observedHandle.replace(/^@/, "").toLowerCase() !== a.handle.toLowerCase()) mismatch = true;
  if (obs.readiness === "ready" && a.verifiedIgUserId && obs.observedIgUserId && obs.observedIgUserId !== a.verifiedIgUserId) mismatch = true;
  if (mismatch) {
    values.state = "needs_review";
    values.stateReason = `Browser profile is logged in as @${obs.observedHandle ?? "unknown"}, not @${a.handle}`;
    values.stateSince = now;
  } else if (obs.readiness === "needs_login" && !a.pausedAt) {
    values.state = "needs_login";
    values.stateReason = "Session check found the account logged out";
    values.stateSince = now;
  } else if (obs.readiness === "ready" && a.state === "needs_login") {
    values.state = a.pausedAt ? "paused" : "ready";
    values.stateReason = "Session check found the account logged in";
    values.stateSince = now;
    if (!a.verifiedIgUserId && obs.observedIgUserId) values.verifiedIgUserId = obs.observedIgUserId;
  }
  await ctx.db.update(accounts).set(values).where(eq(accounts.id, accountId));
  if (obs.readiness === "needs_login" && a.state !== "needs_login") {
    await recordAudit(ctx, { eventType: "account.session_needs_login", message: `Session check: @${a.handle} is logged out.`, accountId, creatorId: a.creatorId, errorCategory: "login_required" });
    await emitNotification(ctx, { eventId: `login_required:session:${accountId}:${now.toDateString()}`, kind: "login_required", severity: "critical", title: `@${a.handle} needs a login`, body: "A session check found the browser profile logged out. Start a login handoff from the account panel.", accountId, creatorId: a.creatorId, data: { url: `/accounts?account=${accountId}` } });
  }
  if (mismatch) await recordAudit(ctx, { eventType: "account.identity_mismatch", message: values.stateReason!, accountId, creatorId: a.creatorId, errorCategory: "account_mismatch" });
}

/** Operator resolves a needs_review state after checking things manually. */
export async function clearReview(ctx: Ctx, id: string, note: string): Promise<void> {
  requireRole(ctx, "operator", "resolve account reviews");
  const a = await ctx.db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.orgId, ctx.orgId)) });
  if (!a) throw notFound("Account");
  assertCreatorAccess(ctx, a.creatorId);
  const open = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(postingJobs).where(and(eq(postingJobs.accountId, id), eq(postingJobs.state, "UNKNOWN_OUTCOME")));
  if ((open[0]?.n ?? 0) > 0) throw conflict("Resolve the unclear post first (confirm it is live, or confirm it is not and retry).");
  await ctx.db.update(accounts).set({ state: a.pausedAt ? "paused" : "ready", stateReason: `Reviewed by ${ctx.actor.name}: ${note}`, stateSince: ctx.clock.now() }).where(eq(accounts.id, id));
  await recordAudit(ctx, { eventType: "account.review_cleared", message: `${ctx.actor.name} marked @${a.handle} as reviewed: ${note}`, accountId: id, creatorId: a.creatorId, isHumanIntervention: true });
}

// ---------- creators ----------
export async function listCreators(ctx: Ctx): Promise<Array<Creator & { accountCount: number; readyAssets: number }>> {
  const where: SQL[] = [eq(creators.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(inArray(creators.id, scope));
  const rows = await ctx.db
    .select({ c: creators, accountCount: sql<number>`(select count(*)::int from ${accounts} a where a.creator_id = ${creators.id})`, readyAssets: sql<number>`(select count(*)::int from assets a where a.creator_id = ${creators.id} and a.status = 'ready' and a.deleted_at is null)` })
    .from(creators)
    .where(and(...where))
    .orderBy(asc(creators.name));
  return rows.map((r) => ({ ...r.c, accountCount: r.accountCount, readyAssets: r.readyAssets }));
}

export async function createCreator(ctx: Ctx, input: { name: string; color?: string; notes?: string }): Promise<Creator> {
  requireRole(ctx, "operator", "add creators");
  const name = input.name.trim();
  if (!name) throw validation("Creator name is required.");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const existing = await ctx.db.query.creators.findFirst({ where: and(eq(creators.orgId, ctx.orgId), eq(creators.slug, slug)) });
  if (existing) throw conflict("A creator with that name already exists.");
  const [row] = await ctx.db.insert(creators).values({ orgId: ctx.orgId, name, slug, color: input.color ?? "#7c5cff", notes: input.notes ?? null }).returning();
  await recordAudit(ctx, { eventType: "creator.created", message: `Added creator ${name}.`, creatorId: row!.id, isHumanIntervention: true });
  return row!;
}

export async function pauseCreator(ctx: Ctx, id: string, reason?: string): Promise<void> {
  requireRole(ctx, "operator", "pause creators");
  assertCreatorAccess(ctx, id);
  const [c] = await ctx.db.update(creators).set({ pausedAt: ctx.clock.now(), pausedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null, pausedReason: reason ?? null }).where(and(eq(creators.id, id), eq(creators.orgId, ctx.orgId), isNull(creators.pausedAt))).returning();
  if (!c) throw conflict("Creator is already paused or not found.");
  await recordAudit(ctx, { eventType: "creator.paused", message: `Paused creator ${c.name}${reason ? `: ${reason}` : ""}. None of their accounts will start new posts.`, creatorId: id, isHumanIntervention: true });
}

export async function resumeCreator(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "operator", "resume creators");
  assertCreatorAccess(ctx, id);
  const [c] = await ctx.db.update(creators).set({ pausedAt: null, pausedByUserId: null, pausedReason: null }).where(and(eq(creators.id, id), eq(creators.orgId, ctx.orgId))).returning();
  if (!c) throw notFound("Creator");
  await recordAudit(ctx, { eventType: "creator.resumed", message: `Resumed creator ${c.name}.`, creatorId: id, isHumanIntervention: true });
}

export async function togglePin(ctx: Ctx, accountId: string): Promise<string[]> {
  if (ctx.actor.type !== "user") throw new AppError("forbidden", "Only users can pin accounts.");
  const u = await ctx.db.query.users.findFirst({ where: eq(users.id, ctx.actor.id) });
  const current = u?.preferences.pinnedAccountIds ?? [];
  const next = current.includes(accountId) ? current.filter((x) => x !== accountId) : [...current, accountId];
  await ctx.db.update(users).set({ preferences: { pinnedAccountIds: next } }).where(eq(users.id, ctx.actor.id));
  return next;
}

export { ACCOUNT_STATE_LABEL };
