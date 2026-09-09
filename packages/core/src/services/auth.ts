import { and, eq, gt } from "drizzle-orm";
import { type Db } from "../db/index";
import { sessions, users, type User } from "../db/schema";
import { hashPassword, randomToken, verifyPassword } from "../lib/crypto";
import { AppError, validation } from "../lib/errors";
import { recordAudit } from "./audit";
import { requireRole, type Actor, type Ctx } from "./context";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export function userActor(u: Pick<User, "id" | "name" | "role" | "creatorScope">): Actor {
  return { type: "user", id: u.id, name: u.name, role: u.role, creatorScope: u.creatorScope ?? null };
}

export async function login(db: Db, email: string, password: string): Promise<{ sessionId: string; user: User } | null> {
  const user = await db.query.users.findFirst({ where: eq(users.email, email.trim().toLowerCase()) });
  if (!user || user.disabledAt) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  const sessionId = randomToken(32);
  await db.insert(sessions).values({ id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
  return { sessionId, user };
}

export async function logout(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function resolveSession(db: Db, sessionId: string): Promise<User | null> {
  const row = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const user = row[0]?.user;
  if (!user || user.disabledAt) return null;
  return user;
}

export async function listUsers(ctx: Ctx): Promise<Array<Omit<User, "passwordHash">>> {
  requireRole(ctx, "owner", "manage users");
  const rows = await ctx.db.query.users.findMany({ where: eq(users.orgId, ctx.orgId), orderBy: users.createdAt });
  return rows.map(({ passwordHash: _ph, ...u }) => u);
}

export async function createUser(
  ctx: Ctx,
  input: { email: string; name: string; password: string; role: User["role"]; creatorScope?: string[] | null },
): Promise<Omit<User, "passwordHash">> {
  requireRole(ctx, "owner", "create users");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw validation("Enter a valid email address.");
  if (input.password.length < 10) throw validation("Passwords need at least 10 characters.");
  if (!input.name.trim()) throw validation("Name is required.");
  const existing = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) throw new AppError("conflict", "A user with that email already exists.");
  const [row] = await ctx.db
    .insert(users)
    .values({ orgId: ctx.orgId, email, name: input.name.trim(), passwordHash: hashPassword(input.password), role: input.role, creatorScope: input.creatorScope ?? null })
    .returning();
  await recordAudit(ctx, { eventType: "user.created", message: `Added ${row!.name} as ${row!.role}.`, metadata: { userId: row!.id, role: row!.role } });
  const { passwordHash: _ph, ...safe } = row!;
  return safe;
}

export async function updateUserRole(ctx: Ctx, userId: string, role: User["role"], creatorScope?: string[] | null): Promise<void> {
  requireRole(ctx, "owner", "change roles");
  if (ctx.actor.type === "user" && ctx.actor.id === userId && role !== "owner") throw validation("You cannot remove your own owner role.");
  const target = await ctx.db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.orgId, ctx.orgId)) });
  if (!target) throw new AppError("not_found", "User not found.");
  await ctx.db.update(users).set({ role, creatorScope: creatorScope ?? null }).where(eq(users.id, userId));
  await recordAudit(ctx, { eventType: "user.role_changed", message: `Changed ${target.name}'s role from ${target.role} to ${role}.`, metadata: { userId, role } });
}

export async function setPinnedAccounts(db: Db, userId: string, pinnedAccountIds: string[]): Promise<void> {
  await db.update(users).set({ preferences: { pinnedAccountIds } }).where(eq(users.id, userId));
}
