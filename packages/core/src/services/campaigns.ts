import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import {
  accounts,
  approvals,
  assets,
  campaignAccounts,
  campaignAssets,
  campaigns,
  creators,
  postingJobs,
  type Campaign,
  type CampaignTemplate,
  type JobApprovalSnapshot,
  type PostingJob,
} from "../db/schema";
import { sha256Hex } from "../lib/crypto";
import { AppError, conflict, notFound, validation } from "../lib/errors";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { assertCreatorAccess, creatorScopeOf, requireRole, withTx, type Ctx } from "./context";
import { emitNotification } from "./notifications";
import { coverage, findConflicts, generatePlan, parseHHmm, type Conflict, type PlannedSlot } from "./scheduling";

export const DEMO_TEMPLATE: CampaignTemplate = {
  dayOne: { enabled: true, count: 3, spacingMinutes: 5, firstTime: "10:00" },
  ongoing: { enabled: true, times: ["11:00", "18:00"] },
  limits: { maxPostsPerAccount: null, maxPostsTotal: null },
};

export type CampaignInput = {
  name: string;
  creatorId?: string | null;
  startDate: string;
  endDate: string;
  template: CampaignTemplate;
  accountIds: string[];
  assetIds: string[];
  /** shared: every account posts the same ordered list. unique: assets are dealt out round-robin so each is posted once. */
  assignment?: "shared" | "unique";
};

function validateTemplate(t: CampaignTemplate) {
  if (t.dayOne.enabled) {
    if (t.dayOne.count < 1 || t.dayOne.count > 10) throw validation("Day-one posts must be between 1 and 10.");
    if (t.dayOne.spacingMinutes < 1) throw validation("Day-one spacing must be at least 1 minute.");
    parseHHmm(t.dayOne.firstTime);
  }
  if (t.ongoing.enabled) {
    if (t.ongoing.times.length === 0) throw validation("Add at least one daily posting time, or disable ongoing posting.");
    t.ongoing.times.forEach(parseHHmm);
  }
  if (!t.dayOne.enabled && !t.ongoing.enabled) throw validation("Enable day-one or ongoing posting.");
  if (t.limits.maxPostsPerAccount != null && t.limits.maxPostsPerAccount < 1) throw validation("Per-account limit must be at least 1.");
  if (t.limits.maxPostsTotal != null && t.limits.maxPostsTotal < 1) throw validation("Total limit must be at least 1.");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function loadPlanAccounts(ctx: Ctx, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const rows = await ctx.db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, accountIds)));
  if (rows.length !== accountIds.length) throw validation("One or more accounts were not found.");
  for (const a of rows) assertCreatorAccess(ctx, a.creatorId);
  return rows;
}

export type CampaignPreview = {
  slots: Array<PlannedSlot & { assetId: string | null; assetName: string | null }>;
  conflicts: Conflict[];
  coverage: ReturnType<typeof coverage>;
  perAccount: Array<{ accountId: string; handle: string; timezone: string; slots: number; withContent: number; shortfall: number }>;
};

/** Builds the plan without persisting anything. */
export async function previewCampaign(ctx: Ctx, input: Omit<CampaignInput, "name">, excludeCampaignId?: string): Promise<CampaignPreview> {
  validateTemplate(input.template);
  if (!ISO_DATE.test(input.startDate) || !ISO_DATE.test(input.endDate)) throw validation("Dates must be YYYY-MM-DD.");
  const accs = await loadPlanAccounts(ctx, input.accountIds);
  const slots = generatePlan({
    template: input.template,
    startDate: input.startDate,
    endDate: input.endDate,
    accounts: accs.map((a) => ({ id: a.id, handle: a.handle, timezone: a.timezone, policyTimes: a.postingPolicy.ongoingTimes })),
  });
  const assetRows = input.assetIds.length
    ? await ctx.db.select().from(assets).where(and(eq(assets.orgId, ctx.orgId), inArray(assets.id, input.assetIds), isNull(assets.deletedAt), eq(assets.status, "ready")))
    : [];
  const ordered = input.assetIds.map((id) => assetRows.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const assignment = input.assignment ?? "shared";
  let cursor = 0;
  const slotsWithAssets = slots.map((s) => {
    let asset: (typeof ordered)[number] | undefined;
    if (assignment === "shared") asset = ordered[s.sequence];
    else asset = ordered[cursor++];
    return { ...s, assetId: asset?.id ?? null, assetName: asset?.originalFilename ?? null };
  });
  const existingWhere: SQL[] = [eq(postingJobs.orgId, ctx.orgId), inArray(postingJobs.state, ["QUEUED", "READY", "PREPARING", "SUBMITTING", "HELD"])];
  if (input.accountIds.length) existingWhere.push(inArray(postingJobs.accountId, input.accountIds));
  if (excludeCampaignId) existingWhere.push(ne(postingJobs.campaignId, excludeCampaignId));
  const existing = input.accountIds.length
    ? await ctx.db
        .select({ accountId: postingJobs.accountId, plannedAt: postingJobs.plannedAt, campaignName: campaigns.name })
        .from(postingJobs)
        .innerJoin(campaigns, eq(campaigns.id, postingJobs.campaignId))
        .where(and(...existingWhere))
    : [];
  const conflicts = findConflicts(slots, existing, ctx.settings.minGapMinutes);
  const perAccount = accs.map((a) => {
    const mine = slotsWithAssets.filter((s) => s.accountId === a.id);
    const withContent = mine.filter((s) => s.assetId).length;
    return { accountId: a.id, handle: a.handle, timezone: a.timezone, slots: mine.length, withContent, shortfall: mine.length - withContent };
  });
  return { slots: slotsWithAssets, conflicts, coverage: coverage(slots, ordered.length), perAccount };
}

export async function createCampaign(ctx: Ctx, input: CampaignInput): Promise<Campaign> {
  requireRole(ctx, "operator", "create campaigns");
  if (!input.name.trim()) throw validation("Give the campaign a name.");
  if (input.accountIds.length === 0) throw validation("Pick at least one account.");
  if (input.creatorId) assertCreatorAccess(ctx, input.creatorId);
  const preview = await previewCampaign(ctx, input);
  if (preview.conflicts.some((c) => c.severity === "error")) throw conflict("The schedule collides with posts already scheduled on the same account. Adjust the dates or times.", { conflicts: preview.conflicts });
  return withTx(ctx, async (tx) => {
    const [c] = await tx.db
      .insert(campaigns)
      .values({
        orgId: tx.orgId,
        creatorId: input.creatorId ?? null,
        name: input.name.trim(),
        startDate: input.startDate,
        endDate: input.endDate,
        template: { ...input.template, ...(input.assignment ? { assignment: input.assignment } : {}) } as CampaignTemplate,
        createdByUserId: tx.actor.type === "user" ? tx.actor.id : null,
      })
      .returning();
    await tx.db.insert(campaignAccounts).values(input.accountIds.map((accountId) => ({ campaignId: c!.id, accountId })));
    if (input.assetIds.length) await tx.db.insert(campaignAssets).values(input.assetIds.map((assetId, i) => ({ campaignId: c!.id, assetId, position: i })));
    await materializeJobs(tx, c!, preview);
    await recordAudit(tx, { eventType: "campaign.created", message: `Created campaign “${c!.name}” with ${preview.slots.length} planned posts across ${input.accountIds.length} account${input.accountIds.length === 1 ? "" : "s"}.`, campaignId: c!.id, creatorId: c!.creatorId });
    return c!;
  });
}

/** Writes draft jobs for the preview. Only unapproved jobs are replaced. */
async function materializeJobs(ctx: Ctx, c: Campaign, preview: CampaignPreview) {
  await ctx.db.delete(postingJobs).where(and(eq(postingJobs.campaignId, c.id), isNull(postingJobs.approvalId), notInArray(postingJobs.state, ["VERIFIED_PUBLISHED", "CANCELLED"])));
  const existingApproved = await ctx.db.select({ key: postingJobs.idempotencyKey }).from(postingJobs).where(eq(postingJobs.campaignId, c.id));
  const taken = new Set(existingApproved.map((r) => r.key));
  const values = preview.slots
    .map((s) => ({
      orgId: ctx.orgId,
      campaignId: c.id,
      accountId: s.accountId,
      assetId: s.assetId,
      sequence: s.sequence,
      isDayOne: s.isDayOne,
      plannedAt: s.plannedAt,
      plannedTimezone: s.timezone,
      state: (s.assetId ? "QUEUED" : "HELD") as PostingJob["state"],
      stateReason: s.assetId ? null : "No content available for this slot",
      errorCategory: s.assetId ? null : ("content_missing" as const),
      idempotencyKey: `${c.id}:${s.accountId}:${s.sequence}`,
    }))
    .filter((v) => !taken.has(v.idempotencyKey));
  if (values.length) await ctx.db.insert(postingJobs).values(values);
}

export async function updateCampaign(ctx: Ctx, id: string, input: CampaignInput): Promise<{ campaign: Campaign; invalidatedJobs: number }> {
  requireRole(ctx, "operator", "edit campaigns");
  const current = await getCampaign(ctx, id);
  if (current.status === "completed" || current.status === "cancelled") throw conflict("Finished campaigns cannot be edited. Create a new campaign instead.");
  const preview = await previewCampaign(ctx, input, id);
  if (preview.conflicts.some((c) => c.severity === "error")) throw conflict("The schedule collides with posts already scheduled on the same account.", { conflicts: preview.conflicts });
  return withTx(ctx, async (tx) => {
    let invalidatedJobs = 0;
    if (current.status === "approved" || current.status === "paused") {
      invalidatedJobs = await invalidateCampaignApproval(tx, id, "schedule, content or audience edited");
    }
    await tx.db
      .update(campaigns)
      .set({ name: input.name.trim(), creatorId: input.creatorId ?? null, startDate: input.startDate, endDate: input.endDate, template: { ...input.template, ...(input.assignment ? { assignment: input.assignment } : {}) } as CampaignTemplate, updatedAt: tx.clock.now() })
      .where(eq(campaigns.id, id));
    await tx.db.delete(campaignAccounts).where(eq(campaignAccounts.campaignId, id));
    await tx.db.insert(campaignAccounts).values(input.accountIds.map((accountId) => ({ campaignId: id, accountId })));
    await tx.db.delete(campaignAssets).where(eq(campaignAssets.campaignId, id));
    if (input.assetIds.length) await tx.db.insert(campaignAssets).values(input.assetIds.map((assetId, i) => ({ campaignId: id, assetId, position: i })));
    // Invalidated jobs are replaced by the new plan.
    await tx.db.delete(postingJobs).where(and(eq(postingJobs.campaignId, id), eq(postingJobs.state, "BLOCKED"), eq(postingJobs.errorCategory, "approval_changed")));
    const c = (await tx.db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;
    await materializeJobs(tx, c, preview);
    await recordAudit(tx, { eventType: "campaign.updated", message: `Edited campaign “${c.name}”${invalidatedJobs ? `; ${invalidatedJobs} approved jobs need re-approval` : ""}.`, campaignId: id, creatorId: c.creatorId });
    return { campaign: c, invalidatedJobs };
  });
}

export type CampaignRow = Campaign & {
  creatorName: string | null;
  accountCount: number;
  jobCounts: Record<string, number>;
  approvedByName: string | null;
  approvedAt: Date | null;
};

export async function listCampaigns(ctx: Ctx, f: { status?: Campaign["status"][]; creatorId?: string; accountId?: string } = {}): Promise<CampaignRow[]> {
  const where: SQL[] = [eq(campaigns.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`(${campaigns.creatorId} IS NULL OR ${campaigns.creatorId} = ANY(${uuidArray(scope)}))`);
  if (f.status?.length) where.push(inArray(campaigns.status, f.status));
  if (f.creatorId) where.push(eq(campaigns.creatorId, f.creatorId));
  if (f.accountId) where.push(sql`exists (select 1 from ${campaignAccounts} ca where ca.campaign_id = ${campaigns.id} and ca.account_id = ${f.accountId})`);
  const rows = await ctx.db
    .select({
      c: campaigns,
      creatorName: creators.name,
      accountCount: sql<number>`(select count(*)::int from ${campaignAccounts} ca where ca.campaign_id = ${campaigns.id})`,
      jobCounts: sql<Record<string, number>>`(select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) from (select state, count(*)::int n from ${postingJobs} j where j.campaign_id = ${campaigns.id} group by state) s)`,
      approvedByName: sql<string | null>`(select u.name from ${approvals} ap join users u on u.id = ap.approved_by_user_id where ap.id = ${campaigns.currentApprovalId})`,
      approvedAt: sql<Date | null>`(select ap.approved_at from ${approvals} ap where ap.id = ${campaigns.currentApprovalId})`,
    })
    .from(campaigns)
    .leftJoin(creators, eq(creators.id, campaigns.creatorId))
    .where(and(...where))
    .orderBy(desc(campaigns.createdAt));
  return rows.map((r) => ({ ...r.c, creatorName: r.creatorName, accountCount: r.accountCount, jobCounts: r.jobCounts, approvedByName: r.approvedByName, approvedAt: r.approvedAt ? new Date(r.approvedAt) : null }));
}

export async function getCampaign(ctx: Ctx, id: string): Promise<Campaign> {
  const c = await ctx.db.query.campaigns.findFirst({ where: and(eq(campaigns.id, id), eq(campaigns.orgId, ctx.orgId)) });
  if (!c) throw notFound("Campaign");
  assertCreatorAccess(ctx, c.creatorId);
  return c;
}

export async function getCampaignDetail(ctx: Ctx, id: string) {
  const c = await getCampaign(ctx, id);
  const accs = await ctx.db.select({ a: accounts }).from(campaignAccounts).innerJoin(accounts, eq(accounts.id, campaignAccounts.accountId)).where(eq(campaignAccounts.campaignId, id));
  const assetRows = await ctx.db.select({ a: assets, position: campaignAssets.position }).from(campaignAssets).innerJoin(assets, eq(assets.id, campaignAssets.assetId)).where(eq(campaignAssets.campaignId, id)).orderBy(asc(campaignAssets.position));
  const jobs = await ctx.db
    .select({ j: postingJobs, handle: accounts.handle, assetName: assets.originalFilename, thumbnailKey: assets.thumbnailKey })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .leftJoin(assets, eq(assets.id, postingJobs.assetId))
    .where(eq(postingJobs.campaignId, id))
    .orderBy(asc(postingJobs.plannedAt), asc(accounts.handle));
  const approvalRows = await ctx.db.select().from(approvals).where(eq(approvals.campaignId, id)).orderBy(desc(approvals.approvedAt));
  return { campaign: c, accounts: accs.map((r) => r.a), assets: assetRows.map((r) => ({ ...r.a, position: r.position })), jobs: jobs.map((r) => ({ ...r.j, handle: r.handle, assetName: r.assetName, thumbnailKey: r.thumbnailKey })), approvals: approvalRows };
}

/**
 * Approves every approvable job in the campaign once. The approval binds account, asset
 * version/hash, exact caption, audience/format, schedule/timezone and campaign limits.
 * From this point the worker publishes those jobs autonomously.
 */
export async function approveCampaign(ctx: Ctx, id: string): Promise<{ approvalId: string; approvedJobs: number; heldJobs: number }> {
  requireRole(ctx, "operator", "approve campaigns");
  return withTx(ctx, async (tx) => {
    const c = await getCampaign(tx, id);
    if (c.status === "completed" || c.status === "cancelled") throw conflict("This campaign is finished.");
    const jobs = await tx.db
      .select({ j: postingJobs, a: assets, acc: accounts })
      .from(postingJobs)
      .leftJoin(assets, eq(assets.id, postingJobs.assetId))
      .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
      .where(and(eq(postingJobs.campaignId, id), inArray(postingJobs.state, ["QUEUED", "READY", "HELD", "BLOCKED"])))
      .orderBy(asc(postingJobs.plannedAt));
    const approvable = jobs.filter(({ j, a }) => a && !a.deletedAt && a.status === "ready" && (j.approvalId == null || (j.state === "BLOCKED" && j.errorCategory === "approval_changed")));
    if (approvable.length === 0 && jobs.every(({ j }) => j.approvalId)) throw conflict("Everything in this campaign is already approved.");
    if (approvable.length === 0) throw validation("There is nothing approvable yet: assign ready content to the campaign first.");
    const approvedBy = tx.actor.type === "user" ? { id: tx.actor.id, name: tx.actor.name } : { id: "system", name: "system" };
    const snapshotJobs = approvable.map(({ j, a, acc }) => ({
      jobId: j.id,
      accountId: acc.id,
      handle: acc.handle,
      verifiedIgUserId: acc.verifiedIgUserId,
      assetId: a!.id,
      assetVersion: a!.version,
      sha256: a!.sha256,
      caption: a!.caption,
      format: "reel" as const,
      audience: "public" as const,
      timezone: acc.timezone,
      plannedAt: j.plannedAt.toISOString(),
    }));
    const snapshot = { campaignId: id, campaignName: c.name, approvedBy, template: c.template, startDate: c.startDate, endDate: c.endDate, jobs: snapshotJobs };
    const [ap] = await tx.db
      .insert(approvals)
      .values({ orgId: tx.orgId, campaignId: id, approvedByUserId: approvedBy.id === "system" ? c.createdByUserId ?? tx.orgId : approvedBy.id, approvedAt: tx.clock.now(), snapshot, snapshotHash: sha256Hex(JSON.stringify(snapshotJobs)), jobCount: snapshotJobs.length })
      .returning();
    const now = tx.clock.now();
    for (const sj of snapshotJobs) {
      const jobSnapshot: JobApprovalSnapshot = { ...sj, limits: c.template.limits };
      const plannedAt = new Date(sj.plannedAt);
      await tx.db
        .update(postingJobs)
        .set({ approvalId: ap!.id, approvalSnapshot: jobSnapshot, state: plannedAt <= now ? "READY" : "QUEUED", stateReason: plannedAt <= now ? "Planned time has passed; will post as soon as the worker is free" : null, errorCategory: null, errorMessage: null, updatedAt: now })
        .where(eq(postingJobs.id, sj.jobId));
      await tx.db.update(assets).set({ lockedAt: now }).where(and(eq(assets.id, sj.assetId), isNull(assets.lockedAt)));
    }
    const heldJobs = jobs.filter(({ j }) => j.state === "HELD" && !j.assetId).length;
    await tx.db.update(campaigns).set({ status: "approved", currentApprovalId: ap!.id, reapprovalReason: null, updatedAt: now }).where(eq(campaigns.id, id));
    await recordAudit(tx, {
      eventType: "campaign.approved",
      message: `Approved “${c.name}”: ${snapshotJobs.length} post${snapshotJobs.length === 1 ? "" : "s"} authorized for automatic publishing${heldJobs ? `; ${heldJobs} slot${heldJobs === 1 ? "" : "s"} held for missing content` : ""}.`,
      campaignId: id,
      approvalId: ap!.id,
      creatorId: c.creatorId,
      isHumanIntervention: true,
      metadata: { snapshotHash: ap!.snapshotHash },
    });
    if (heldJobs > 0) {
      await emitNotification(tx, { eventId: `content_shortage:${id}:${ap!.id}`, kind: "content_shortage", severity: "warning", title: `“${c.name}” needs more content`, body: `${heldJobs} scheduled slot${heldJobs === 1 ? "" : "s"} have no video assigned. Those slots are held, not skipped or recycled.`, campaignId: id, creatorId: c.creatorId, data: { url: `/schedule?campaign=${id}` } });
    }
    return { approvalId: ap!.id, approvedJobs: snapshotJobs.length, heldJobs };
  });
}

/** Blocks approved jobs that reference the asset and flags their campaigns. Returns the count of affected jobs. */
export async function invalidateApprovalsForAsset(ctx: Ctx, assetId: string, reason: string): Promise<number> {
  const affected = await ctx.db
    .update(postingJobs)
    .set({ state: "BLOCKED", errorCategory: "approval_changed", stateReason: `Approved content changed (${reason}). Re-approve the campaign to continue.`, updatedAt: ctx.clock.now() })
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.assetId, assetId), sql`${postingJobs.approvalId} IS NOT NULL`, inArray(postingJobs.state, ["QUEUED", "READY", "HELD", "PREPARING"])))
    .returning({ id: postingJobs.id, campaignId: postingJobs.campaignId, accountId: postingJobs.accountId });
  await flagCampaigns(ctx, affected, reason);
  return affected.length;
}

export async function invalidateApprovalsForAccount(ctx: Ctx, accountId: string, reason: string): Promise<number> {
  const affected = await ctx.db
    .update(postingJobs)
    .set({ state: "BLOCKED", errorCategory: "approval_changed", stateReason: `Account settings changed (${reason}). Re-approve the campaign to continue.`, updatedAt: ctx.clock.now() })
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.accountId, accountId), sql`${postingJobs.approvalId} IS NOT NULL`, inArray(postingJobs.state, ["QUEUED", "READY", "HELD", "PREPARING"])))
    .returning({ id: postingJobs.id, campaignId: postingJobs.campaignId, accountId: postingJobs.accountId });
  await flagCampaigns(ctx, affected, reason);
  return affected.length;
}

async function invalidateCampaignApproval(ctx: Ctx, campaignId: string, reason: string): Promise<number> {
  const affected = await ctx.db
    .update(postingJobs)
    .set({ state: "BLOCKED", errorCategory: "approval_changed", stateReason: `Campaign edited (${reason}). Re-approve to continue.`, updatedAt: ctx.clock.now() })
    .where(and(eq(postingJobs.campaignId, campaignId), sql`${postingJobs.approvalId} IS NOT NULL`, inArray(postingJobs.state, ["QUEUED", "READY", "HELD", "PREPARING"])))
    .returning({ id: postingJobs.id, campaignId: postingJobs.campaignId, accountId: postingJobs.accountId });
  await flagCampaigns(ctx, affected, reason);
  return affected.length;
}

async function flagCampaigns(ctx: Ctx, affected: Array<{ id: string; campaignId: string; accountId: string }>, reason: string) {
  const byCampaign = new Map<string, number>();
  for (const a of affected) byCampaign.set(a.campaignId, (byCampaign.get(a.campaignId) ?? 0) + 1);
  for (const [campaignId, n] of byCampaign) {
    const [c] = await ctx.db.update(campaigns).set({ status: "needs_reapproval", reapprovalReason: reason, updatedAt: ctx.clock.now() }).where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["approved", "paused"]))).returning();
    if (!c) continue;
    await recordAudit(ctx, { eventType: "approval.invalidated", message: `${n} approved job${n === 1 ? "" : "s"} in “${c.name}” blocked because ${reason}. Re-approval required.`, campaignId, approvalId: c.currentApprovalId, errorCategory: "approval_changed", creatorId: c.creatorId });
    await emitNotification(ctx, { eventId: `approval_invalidated:${campaignId}:${ctx.clock.now().getTime()}`, kind: "approval_invalidated", severity: "warning", title: `“${c.name}” needs re-approval`, body: `${n} job${n === 1 ? "" : "s"} were blocked because ${reason}. Review and approve the campaign again to resume.`, campaignId, creatorId: c.creatorId, data: { url: `/schedule?campaign=${campaignId}` } });
  }
}

export async function pauseCampaign(ctx: Ctx, id: string, reason?: string): Promise<void> {
  requireRole(ctx, "operator", "pause campaigns");
  const c = await getCampaign(ctx, id);
  if (c.status !== "approved") throw conflict("Only approved, running campaigns can be paused.");
  await ctx.db.update(campaigns).set({ status: "paused", pausedAt: ctx.clock.now(), pausedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null, pausedReason: reason ?? null, updatedAt: ctx.clock.now() }).where(eq(campaigns.id, id));
  const inflight = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(postingJobs).where(and(eq(postingJobs.campaignId, id), inArray(postingJobs.state, ["PREPARING", "SUBMITTING"])));
  await recordAudit(ctx, { eventType: "campaign.paused", message: `Paused “${c.name}”${reason ? `: ${reason}` : ""}. No new posts will start${inflight[0]?.n ? `; ${inflight[0].n} already in progress will finish` : ""}.`, campaignId: id, creatorId: c.creatorId, isHumanIntervention: true });
}

export async function resumeCampaign(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "operator", "resume campaigns");
  const c = await getCampaign(ctx, id);
  if (c.status !== "paused") throw conflict("This campaign is not paused.");
  await ctx.db.update(campaigns).set({ status: "approved", pausedAt: null, pausedByUserId: null, pausedReason: null, updatedAt: ctx.clock.now() }).where(eq(campaigns.id, id));
  await recordAudit(ctx, { eventType: "campaign.resumed", message: `Resumed “${c.name}”. Overdue posts will publish as soon as the worker is free, keeping the minimum spacing.`, campaignId: id, creatorId: c.creatorId, isHumanIntervention: true });
}

export async function cancelCampaign(ctx: Ctx, id: string, reason?: string): Promise<void> {
  requireRole(ctx, "operator", "cancel campaigns");
  const c = await getCampaign(ctx, id);
  await withTx(ctx, async (tx) => {
    const cancelled = await tx.db
      .update(postingJobs)
      .set({ state: "CANCELLED", stateReason: `Campaign cancelled${reason ? `: ${reason}` : ""}`, updatedAt: tx.clock.now() })
      .where(and(eq(postingJobs.campaignId, id), inArray(postingJobs.state, ["QUEUED", "READY", "HELD", "BLOCKED", "FAILED"])))
      .returning({ id: postingJobs.id });
    await tx.db.update(campaigns).set({ status: "cancelled", updatedAt: tx.clock.now() }).where(eq(campaigns.id, id));
    if (c.currentApprovalId) await tx.db.update(approvals).set({ revokedAt: tx.clock.now(), revokedByUserId: tx.actor.type === "user" ? tx.actor.id : null, revokedReason: reason ?? "Campaign cancelled" }).where(eq(approvals.id, c.currentApprovalId));
    await recordAudit(tx, { eventType: "campaign.cancelled", message: `Cancelled “${c.name}”: ${cancelled.length} pending post${cancelled.length === 1 ? "" : "s"} cancelled. Posts already live are unaffected; anything mid-submission cannot be recalled.`, campaignId: id, approvalId: c.currentApprovalId, creatorId: c.creatorId, isHumanIntervention: true });
  });
}

/** Scheduler: marks campaigns completed when nothing is left to do and holds jobs past the end date. */
export async function reconcileCampaignLifecycle(ctx: Ctx): Promise<void> {
  const active = await ctx.db.select().from(campaigns).where(and(eq(campaigns.orgId, ctx.orgId), inArray(campaigns.status, ["approved", "paused", "needs_reapproval"])));
  for (const c of active) {
    const counts = await ctx.db.select({ state: postingJobs.state, n: sql<number>`count(*)::int` }).from(postingJobs).where(eq(postingJobs.campaignId, c.id)).groupBy(postingJobs.state);
    const open = counts.filter((r) => !["VERIFIED_PUBLISHED", "CANCELLED"].includes(r.state)).reduce((s, r) => s + r.n, 0);
    if (open === 0 && counts.length > 0) {
      await ctx.db.update(campaigns).set({ status: "completed", completedAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(campaigns.id, c.id));
      await recordAudit(ctx, { eventType: "campaign.completed", message: `“${c.name}” finished: every planned post is verified live or cancelled.`, campaignId: c.id, creatorId: c.creatorId });
    }
  }
}

export async function assignAssetToJob(ctx: Ctx, jobId: string, assetId: string | null): Promise<void> {
  requireRole(ctx, "operator", "assign content");
  const job = await ctx.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.id, jobId), eq(postingJobs.orgId, ctx.orgId)) });
  if (!job) throw notFound("Job");
  if (["VERIFIED_PUBLISHED", "CANCELLED", "PREPARING", "SUBMITTING"].includes(job.state)) throw conflict("This post cannot be changed in its current state.");
  if (assetId) {
    const a = await ctx.db.query.assets.findFirst({ where: and(eq(assets.id, assetId), eq(assets.orgId, ctx.orgId), isNull(assets.deletedAt)) });
    if (!a || a.status !== "ready") throw validation("Pick a ready video.");
  }
  const wasApproved = job.approvalId != null;
  await ctx.db
    .update(postingJobs)
    .set({ assetId, approvalId: null, approvalSnapshot: null, state: assetId ? "QUEUED" : "HELD", stateReason: assetId ? (wasApproved ? "Content changed; needs approval" : null) : "No content available for this slot", errorCategory: assetId ? null : "content_missing", updatedAt: ctx.clock.now() })
    .where(eq(postingJobs.id, jobId));
  if (assetId) {
    const c = await ctx.db.query.campaigns.findFirst({ where: eq(campaigns.id, job.campaignId) });
    if (c && (c.status === "approved" || c.status === "paused")) await ctx.db.update(campaigns).set({ status: "needs_reapproval", reapprovalReason: "content assigned to a slot", updatedAt: ctx.clock.now() }).where(eq(campaigns.id, c.id));
  }
  await recordAudit(ctx, { eventType: "job.asset_assigned", message: assetId ? "Assigned a video to this slot; the campaign needs approval before it can post." : "Removed the video from this slot; it is now held.", jobId, campaignId: job.campaignId, accountId: job.accountId, isHumanIntervention: true });
}

export const isDemoTemplateDefault = (t: CampaignTemplate) => JSON.stringify(t.ongoing.times) === JSON.stringify(DEMO_TEMPLATE.ongoing.times);
export type { PlannedSlot, Conflict };
export { AppError };
