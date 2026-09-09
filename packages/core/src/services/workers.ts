import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { accounts, workers, type Worker } from "../db/schema";
import { constantTimeEqualHex, issueWorkerToken, parseWorkerToken } from "../lib/crypto";
import { workerOfflineAfterMs } from "../lib/env";
import { AppError, validation } from "../lib/errors";
import { recordAudit } from "./audit";
import { requireRole, type Ctx } from "./context";
import { emitNotification } from "./notifications";

export type SafeWorker = Omit<Worker, "tokenHash">;
const strip = (w: Worker): SafeWorker => {
  const { tokenHash: _t, ...rest } = w;
  return rest;
};

export async function listWorkers(ctx: Ctx): Promise<Array<SafeWorker & { accountCount: number }>> {
  const rows = await ctx.db
    .select({ w: workers, accountCount: sql<number>`(select count(*)::int from ${accounts} a where a.worker_id = ${workers.id})` })
    .from(workers)
    .where(eq(workers.orgId, ctx.orgId))
    .orderBy(workers.createdAt);
  return rows.map((r) => ({ ...strip(r.w), accountCount: r.accountCount }));
}

/** Creates a worker and returns its one-time token. The token is shown once and only its hash is stored. */
export async function createWorker(ctx: Ctx, input: { name: string; kind: Worker["kind"]; maxConcurrency?: number }): Promise<{ worker: SafeWorker; token: string }> {
  requireRole(ctx, "owner", "create workers");
  if (!input.name.trim()) throw validation("Give the worker a name.");
  const { token, prefix, hash } = issueWorkerToken();
  const [row] = await ctx.db
    .insert(workers)
    .values({ orgId: ctx.orgId, name: input.name.trim(), kind: input.kind, tokenPrefix: prefix, tokenHash: hash, maxConcurrency: input.maxConcurrency ?? 1, createdByUserId: ctx.actor.type === "user" ? ctx.actor.id : null })
    .returning();
  await recordAudit(ctx, { eventType: "worker.created", message: `Created ${input.kind} worker “${row!.name}”. A scoped token was issued.`, metadata: { workerId: row!.id, tokenPrefix: prefix } });
  return { worker: strip(row!), token };
}

export async function revokeWorker(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "owner", "revoke workers");
  const [row] = await ctx.db.update(workers).set({ status: "revoked", revokedAt: ctx.clock.now() }).where(and(eq(workers.id, id), eq(workers.orgId, ctx.orgId))).returning();
  if (!row) throw new AppError("not_found", "Worker not found.");
  await recordAudit(ctx, { eventType: "worker.revoked", message: `Revoked worker “${row.name}”. Its token no longer works; leases it held will expire.`, metadata: { workerId: id } });
}

export async function rotateWorkerToken(ctx: Ctx, id: string): Promise<{ token: string }> {
  requireRole(ctx, "owner", "rotate worker tokens");
  const { token, prefix, hash } = issueWorkerToken();
  const [row] = await ctx.db.update(workers).set({ tokenPrefix: prefix, tokenHash: hash, status: "never_connected", revokedAt: null }).where(and(eq(workers.id, id), eq(workers.orgId, ctx.orgId))).returning();
  if (!row) throw new AppError("not_found", "Worker not found.");
  await recordAudit(ctx, { eventType: "worker.token_rotated", message: `Rotated the token for worker “${row.name}”.`, metadata: { workerId: id, tokenPrefix: prefix } });
  return { token };
}

/** Authenticates a bearer token. Returns null for unknown/revoked tokens. */
export async function authenticateWorker(db: Db, bearer: string | null | undefined): Promise<Worker | null> {
  if (!bearer) return null;
  const parsed = parseWorkerToken(bearer.replace(/^Bearer\s+/i, ""));
  if (!parsed) return null;
  const row = await db.query.workers.findFirst({ where: eq(workers.tokenPrefix, parsed.prefix) });
  if (!row || row.status === "revoked") return null;
  if (!constantTimeEqualHex(row.tokenHash, parsed.secretHash)) return null;
  return row;
}

export async function heartbeat(ctx: Ctx, workerId: string, info: { version?: string; capabilities?: Record<string, unknown>; hostInfo?: Record<string, unknown>; maxConcurrency?: number }): Promise<Worker> {
  const existing = await ctx.db.query.workers.findFirst({ where: eq(workers.id, workerId) });
  if (!existing) throw new AppError("not_found", "Worker not found.");
  const wasOffline = existing.status !== "online";
  const [row] = await ctx.db
    .update(workers)
    .set({
      status: "online",
      lastHeartbeatAt: ctx.clock.now(),
      version: info.version ?? existing.version,
      capabilities: info.capabilities ?? existing.capabilities,
      hostInfo: info.hostInfo ?? existing.hostInfo,
      maxConcurrency: info.maxConcurrency ?? existing.maxConcurrency,
    })
    .where(eq(workers.id, workerId))
    .returning();
  // Account state is not rewritten here: "offline" is derived from the worker status when listing accounts,
  // so an account that needed a login before the outage still needs it afterwards.
  if (wasOffline) await recordAudit(ctx, { eventType: "worker.online", message: `Worker “${row!.name}” connected.`, metadata: { workerId } });
  return row!;
}

/** Scheduler: marks workers without a recent heartbeat offline and notifies once per outage. */
export async function detectOfflineWorkers(ctx: Ctx): Promise<string[]> {
  const cutoff = new Date(ctx.clock.now().getTime() - workerOfflineAfterMs());
  const stale = await ctx.db
    .select()
    .from(workers)
    .where(and(eq(workers.orgId, ctx.orgId), eq(workers.status, "online"), lt(workers.lastHeartbeatAt, cutoff)));
  const ids: string[] = [];
  for (const w of stale) {
    await ctx.db.update(workers).set({ status: "offline" }).where(eq(workers.id, w.id));
    await recordAudit(ctx, { eventType: "worker.offline", message: `Worker “${w.name}” went offline (no heartbeat since ${w.lastHeartbeatAt?.toISOString() ?? "unknown"}).`, errorCategory: "worker_lost", metadata: { workerId: w.id } });
    await emitNotification(ctx, {
      eventId: `worker_offline:${w.id}:${w.lastHeartbeatAt?.getTime() ?? 0}`,
      kind: "worker_offline",
      severity: "critical",
      title: `Worker “${w.name}” is offline`,
      body: "Accounts assigned to this worker will not post until it reconnects. Scheduled jobs are held, not lost.",
      workerId: w.id,
      data: { url: `/settings/workers` },
    });
    ids.push(w.id);
  }
  return ids;
}
