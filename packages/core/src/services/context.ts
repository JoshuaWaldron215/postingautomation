import { eq } from "drizzle-orm";
import { getDb, type DbOrTx, type Db } from "../db/index";
import { organizations, type OrgSettings, type User } from "../db/schema";
import { OffsetClock, systemClock, type Clock } from "../lib/clock";
import { forbidden, AppError } from "../lib/errors";

export type Role = User["role"];

export type Actor =
  | { type: "user"; id: string; name: string; role: Role; creatorScope: string[] | null }
  | { type: "worker"; id: string; name: string }
  | { type: "scheduler"; id?: undefined; name: "scheduler" }
  | { type: "system"; id?: undefined; name: "system" };

export interface Ctx {
  db: DbOrTx;
  orgId: string;
  actor: Actor;
  clock: Clock;
  settings: OrgSettings;
}

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };

export function requireRole(ctx: Ctx, role: Role, action = "do that"): void {
  if (ctx.actor.type === "system" || ctx.actor.type === "scheduler") return;
  if (ctx.actor.type === "worker") throw forbidden(`Workers cannot ${action}.`);
  if (ROLE_RANK[ctx.actor.role] < ROLE_RANK[role]) {
    throw forbidden(`Only ${role === "owner" ? "owners" : "operators and owners"} can ${action}.`);
  }
}

export function isAtLeast(ctx: Ctx, role: Role): boolean {
  if (ctx.actor.type !== "user") return ctx.actor.type !== "worker";
  return ROLE_RANK[ctx.actor.role] >= ROLE_RANK[role];
}

/** Creator-scoped users may only touch creators in their scope. Owners always pass. */
export function assertCreatorAccess(ctx: Ctx, creatorId: string | null | undefined): void {
  if (ctx.actor.type !== "user") return;
  if (ctx.actor.role === "owner") return;
  const scope = ctx.actor.creatorScope;
  if (!scope || scope.length === 0) return;
  if (!creatorId || !scope.includes(creatorId)) throw forbidden("This creator is outside your access scope.");
}

export function creatorScopeOf(ctx: Ctx): string[] | null {
  if (ctx.actor.type !== "user" || ctx.actor.role === "owner") return null;
  const scope = ctx.actor.creatorScope;
  return scope && scope.length > 0 ? scope : null;
}

export function actorLabel(actor: Actor): string {
  switch (actor.type) {
    case "user":
      return actor.name;
    case "worker":
      return `worker:${actor.name}`;
    default:
      return actor.type;
  }
}

export function actorId(actor: Actor): string | null {
  return actor.type === "user" || actor.type === "worker" ? actor.id : null;
}

export async function loadOrgSettings(db: DbOrTx, orgId: string): Promise<OrgSettings> {
  const row = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  if (!row) throw new AppError("not_found", "Organization not found.");
  return row.settings;
}

export function clockFor(settings: OrgSettings): Clock {
  if (settings.demoMode && settings.simClockOffsetMs) return new OffsetClock(settings.simClockOffsetMs);
  return systemClock;
}

export async function makeCtx(params: { db?: Db; orgId: string; actor: Actor; clock?: Clock }): Promise<Ctx> {
  const db = params.db ?? getDb();
  const settings = await loadOrgSettings(db, params.orgId);
  return { db, orgId: params.orgId, actor: params.actor, clock: params.clock ?? clockFor(settings), settings };
}

/** Runs fn inside a transaction with the same ctx semantics. Nested calls reuse the outer tx. */
export async function withTx<T>(ctx: Ctx, fn: (tx: Ctx) => Promise<T>): Promise<T> {
  const db = ctx.db as Db;
  if (typeof (db as Db).transaction !== "function" || (ctx as { inTx?: boolean }).inTx) return fn(ctx);
  return db.transaction(async (tx) => fn({ ...ctx, db: tx, inTx: true } as Ctx));
}

export const systemActor: Actor = { type: "system", name: "system" };
export const schedulerActor: Actor = { type: "scheduler", name: "scheduler" };
