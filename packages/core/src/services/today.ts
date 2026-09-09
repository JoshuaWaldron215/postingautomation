import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { uuidArray } from "../lib/sqlutil";
import { accounts, analyticsJobs, creators, notifications, postingJobs, verifiedPosts, workers, assets } from "../db/schema";
import { creatorScopeOf, type Ctx } from "./context";
import { listAccounts } from "./accounts";

export type Scope = { kind: "all" } | { kind: "creator"; creatorId: string } | { kind: "account"; accountId: string };

function scopeWhere(scope: Scope, accountCol: typeof postingJobs.accountId | typeof verifiedPosts.accountId | typeof analyticsJobs.accountId): SQL | undefined {
  if (scope.kind === "account") return eq(accountCol, scope.accountId);
  if (scope.kind === "creator") return sql`${accountCol} in (select id from ${accounts} a where a.creator_id = ${scope.creatorId})`;
  return undefined;
}

export async function todayOverview(ctx: Ctx, scope: Scope, displayTz: string) {
  const now = ctx.clock.now();
  const dayStart = startOfDayInTz(now, displayTz);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const creatorScope = creatorScopeOf(ctx);
  const jobScope: SQL[] = [eq(postingJobs.orgId, ctx.orgId)];
  const s1 = scopeWhere(scope, postingJobs.accountId);
  if (s1) jobScope.push(s1);
  if (creatorScope) jobScope.push(sql`${postingJobs.accountId} in (select id from ${accounts} a where a.creator_id = ANY(${uuidArray(creatorScope)}))`);

  const plannedToday = await ctx.db.select({ state: postingJobs.state, n: sql<number>`count(*)::int` }).from(postingJobs).where(and(...jobScope, gte(postingJobs.plannedAt, dayStart), lt(postingJobs.plannedAt, dayEnd))).groupBy(postingJobs.state);
  const verifiedTodayRows = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(verifiedPosts).where(and(eq(verifiedPosts.orgId, ctx.orgId), gte(verifiedPosts.publishedAt, dayStart), lt(verifiedPosts.publishedAt, dayEnd), ...(scopeWhere(scope, verifiedPosts.accountId) ? [scopeWhere(scope, verifiedPosts.accountId)!] : []), ...(creatorScope ? [sql`${verifiedPosts.accountId} in (select id from ${accounts} a where a.creator_id = ANY(${uuidArray(creatorScope)}))`] : [])));
  const counts = Object.fromEntries(plannedToday.map((r) => [r.state, r.n])) as Record<string, number>;
  const plannedCount = plannedToday.reduce((s, r) => s + r.n, 0);

  const inProgress = await jobsWithContext(ctx, and(...jobScope, inArray(postingJobs.state, ["PREPARING", "SUBMITTING"])), asc(postingJobs.plannedAt), 20);
  const upcoming = await jobsWithContext(ctx, and(...jobScope, inArray(postingJobs.state, ["QUEUED", "READY"]), sql`${postingJobs.approvalId} IS NOT NULL`), asc(postingJobs.plannedAt), 12);
  const exceptions = await jobsWithContext(ctx, and(...jobScope, inArray(postingJobs.state, ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"])), desc(postingJobs.updatedAt), 50);
  const held = await jobsWithContext(ctx, and(...jobScope, eq(postingJobs.state, "HELD")), asc(postingJobs.plannedAt), 50);
  const late = upcoming.filter((j) => j.state === "READY" && j.plannedAt.getTime() < now.getTime() - 15 * 60000);

  const allAccounts = await listAccounts(ctx, scope.kind === "creator" ? { creatorId: scope.creatorId } : {});
  const scopedAccounts = scope.kind === "account" ? allAccounts.filter((a) => a.id === scope.accountId) : allAccounts;
  const attention = scopedAccounts.filter((a) => a.needsAttention);
  const shortages = scopedAccounts.filter((a) => a.heldForContent > 0);

  const analyticsWhere: SQL[] = [eq(analyticsJobs.orgId, ctx.orgId)];
  const s3 = scopeWhere(scope, analyticsJobs.accountId);
  if (s3) analyticsWhere.push(s3);
  if (creatorScope) analyticsWhere.push(sql`${analyticsJobs.accountId} in (select id from ${accounts} a where a.creator_id = ANY(${uuidArray(creatorScope)}))`);
  const analyticsProblems = await ctx.db
    .select({ a: analyticsJobs, handle: accounts.handle, avatarColor: accounts.avatarColor, jobId: verifiedPosts.jobId, postUrl: verifiedPosts.postUrl })
    .from(analyticsJobs)
    .innerJoin(accounts, eq(accounts.id, analyticsJobs.accountId))
    .innerJoin(verifiedPosts, eq(verifiedPosts.id, analyticsJobs.verifiedPostId))
    .where(and(...analyticsWhere, sql`(${analyticsJobs.state} in ('FAILED','BLOCKED') or (${analyticsJobs.state} in ('READY','SCHEDULED','RUNNING') and ${analyticsJobs.dueAt} < ${new Date(now.getTime() - ctx.settings.analytics.lateAfterMinutes * 60000).toISOString()}::timestamptz))`))
    .orderBy(asc(analyticsJobs.dueAt))
    .limit(30);
  const analyticsDueSoon = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(analyticsJobs).where(and(...analyticsWhere, inArray(analyticsJobs.state, ["SCHEDULED", "READY"]), gte(analyticsJobs.dueAt, now), lt(analyticsJobs.dueAt, dayEnd)));

  const workerRows = await ctx.db.select().from(workers).where(and(eq(workers.orgId, ctx.orgId), sql`${workers.status} <> 'revoked'`)).orderBy(asc(workers.name));
  const recentVerified = await ctx.db
    .select({ v: verifiedPosts, handle: accounts.handle, avatarColor: accounts.avatarColor, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey, analyticsState: analyticsJobs.state, analyticsDueAt: analyticsJobs.dueAt })
    .from(verifiedPosts)
    .innerJoin(accounts, eq(accounts.id, verifiedPosts.accountId))
    .leftJoin(assets, eq(assets.id, verifiedPosts.assetId))
    .leftJoin(analyticsJobs, eq(analyticsJobs.verifiedPostId, verifiedPosts.id))
    .where(and(eq(verifiedPosts.orgId, ctx.orgId), ...(scopeWhere(scope, verifiedPosts.accountId) ? [scopeWhere(scope, verifiedPosts.accountId)!] : []), ...(creatorScope ? [sql`${verifiedPosts.accountId} in (select id from ${accounts} a where a.creator_id = ANY(${uuidArray(creatorScope)}))`] : [])))
    .orderBy(desc(verifiedPosts.publishedAt))
    .limit(8);
  const unresolved = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.orgId, ctx.orgId), isNull(notifications.resolvedAt), sql`${notifications.severity} <> 'info'`));

  return {
    now,
    dayStart,
    dayEnd,
    planned: { total: plannedCount, verified: verifiedTodayRows[0]?.n ?? 0, byState: counts },
    inProgress,
    upcoming,
    late,
    exceptions,
    held,
    accountsNeedingAttention: attention,
    contentShortages: shortages,
    analyticsProblems: analyticsProblems.map((r) => ({ ...r.a, handle: r.handle, avatarColor: r.avatarColor, jobId: r.jobId, postUrl: r.postUrl, overdueMinutes: Math.max(0, Math.round((now.getTime() - r.a.dueAt.getTime()) / 60000)) })),
    analyticsDueToday: analyticsDueSoon[0]?.n ?? 0,
    workers: workerRows.map(({ tokenHash: _t, ...w }) => w),
    recentVerified: recentVerified.map((r) => ({ ...r.v, handle: r.handle, avatarColor: r.avatarColor, assetName: r.assetName, thumbnailKey: r.thumbnailKey, analyticsState: r.analyticsState, analyticsDueAt: r.analyticsDueAt })),
    unresolvedAlerts: unresolved[0]?.n ?? 0,
    globalPause: ctx.settings.globalPause,
    totalAccounts: scopedAccounts.length,
  };
}

async function jobsWithContext(ctx: Ctx, where: SQL | undefined, order: SQL, limit: number) {
  const rows = await ctx.db
    .select({ j: postingJobs, handle: accounts.handle, avatarColor: accounts.avatarColor, creatorName: creators.name, creatorId: accounts.creatorId, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey, accountState: accounts.state })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .innerJoin(creators, eq(creators.id, accounts.creatorId))
    .leftJoin(assets, eq(assets.id, postingJobs.assetId))
    .where(where)
    .orderBy(order)
    .limit(limit);
  return rows.map((r) => ({ ...r.j, handle: r.handle, avatarColor: r.avatarColor, creatorName: r.creatorName, creatorId: r.creatorId, assetName: r.assetName, thumbnailKey: r.thumbnailKey, accountState: r.accountState }));
}

export function startOfDayInTz(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const offset = asUtc - date.getTime();
  const localMidnightUtc = Date.UTC(get("year"), get("month") - 1, get("day"));
  return new Date(localMidnightUtc - offset);
}
