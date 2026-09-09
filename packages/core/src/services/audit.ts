import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { uuidArray } from "../lib/sqlutil";
import { auditEvents, type AuditEvent } from "../db/schema";
import { redact } from "../lib/redact";
import { actorId, actorLabel, requireRole, creatorScopeOf, type Ctx } from "./context";

export type AuditInput = {
  eventType: string;
  message: string;
  accountId?: string | null;
  creatorId?: string | null;
  campaignId?: string | null;
  jobId?: string | null;
  approvalId?: string | null;
  analyticsJobId?: string | null;
  attemptNo?: number | null;
  fromState?: string | null;
  toState?: string | null;
  errorCategory?: string | null;
  evidence?: Record<string, unknown> | null;
  notificationId?: string | null;
  isHumanIntervention?: boolean;
  metadata?: Record<string, unknown>;
};

export async function recordAudit(ctx: Ctx, input: AuditInput): Promise<AuditEvent> {
  const [row] = await ctx.db
    .insert(auditEvents)
    .values({
      orgId: ctx.orgId,
      at: ctx.clock.now(),
      actorType: ctx.actor.type,
      actorId: actorId(ctx.actor),
      actorLabel: actorLabel(ctx.actor),
      eventType: input.eventType,
      message: input.message,
      accountId: input.accountId ?? null,
      creatorId: input.creatorId ?? null,
      campaignId: input.campaignId ?? null,
      jobId: input.jobId ?? null,
      approvalId: input.approvalId ?? null,
      analyticsJobId: input.analyticsJobId ?? null,
      attemptNo: input.attemptNo ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      errorCategory: input.errorCategory ?? null,
      evidence: input.evidence ? redact(input.evidence) : null,
      notificationId: input.notificationId ?? null,
      isHumanIntervention: input.isHumanIntervention ?? ctx.actor.type === "user",
      metadata: redact(input.metadata ?? {}),
    })
    .returning();
  return row!;
}

export type ActivityFilter = {
  q?: string;
  accountId?: string;
  creatorId?: string;
  campaignId?: string;
  jobId?: string;
  actorType?: AuditEvent["actorType"];
  eventType?: string;
  humanOnly?: boolean;
  errorsOnly?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

export async function listActivity(ctx: Ctx, f: ActivityFilter = {}): Promise<{ rows: AuditEvent[]; total: number }> {
  const where: SQL[] = [eq(auditEvents.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(or(sql`${auditEvents.creatorId} = ANY(${uuidArray(scope)})`, sql`${auditEvents.creatorId} IS NULL`)!);
  if (f.accountId) where.push(eq(auditEvents.accountId, f.accountId));
  if (f.creatorId) where.push(eq(auditEvents.creatorId, f.creatorId));
  if (f.campaignId) where.push(eq(auditEvents.campaignId, f.campaignId));
  if (f.jobId) where.push(eq(auditEvents.jobId, f.jobId));
  if (f.actorType) where.push(eq(auditEvents.actorType, f.actorType));
  if (f.eventType) where.push(eq(auditEvents.eventType, f.eventType));
  if (f.humanOnly) where.push(eq(auditEvents.isHumanIntervention, true));
  if (f.errorsOnly) where.push(sql`${auditEvents.errorCategory} IS NOT NULL`);
  if (f.from) where.push(gte(auditEvents.at, f.from));
  if (f.to) where.push(lte(auditEvents.at, f.to));
  if (f.q) where.push(or(ilike(auditEvents.message, `%${f.q}%`), ilike(auditEvents.eventType, `%${f.q}%`), ilike(auditEvents.actorLabel, `%${f.q}%`))!);
  const limit = Math.min(f.limit ?? 100, 1000);
  const rows = await ctx.db
    .select()
    .from(auditEvents)
    .where(and(...where))
    .orderBy(desc(auditEvents.at))
    .limit(limit)
    .offset(f.offset ?? 0);
  const countRows = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(and(...where));
  return { rows, total: countRows[0]?.count ?? 0 };
}

export async function exportActivityCsv(ctx: Ctx, f: ActivityFilter): Promise<string> {
  requireRole(ctx, "operator", "export activity");
  const { rows } = await listActivity(ctx, { ...f, limit: 5000 });
  const header = ["time", "actor_type", "actor", "event_type", "message", "account_id", "campaign_id", "job_id", "approval_id", "attempt", "from_state", "to_state", "error_category", "human_intervention", "notification_id"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.at.toISOString(), r.actorType, r.actorLabel, r.eventType, r.message, r.accountId, r.campaignId, r.jobId, r.approvalId, r.attemptNo, r.fromState, r.toState, r.errorCategory, r.isHumanIntervention, r.notificationId].map(esc).join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
