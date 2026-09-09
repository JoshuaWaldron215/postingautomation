import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  notificationChannels,
  notificationDeliveries,
  notifications,
  type ChannelSettings,
  type Notification,
  type NotificationChannel,
  type NotificationDelivery,
} from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { AppError, validation } from "../lib/errors";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { creatorScopeOf, requireRole, withTx, type Ctx } from "./context";

export type EmitInput = {
  eventId: string;
  kind: Notification["kind"];
  severity: Notification["severity"];
  title: string;
  body: string;
  accountId?: string | null;
  creatorId?: string | null;
  campaignId?: string | null;
  jobId?: string | null;
  analyticsJobId?: string | null;
  workerId?: string | null;
  data?: Record<string, unknown>;
};

const EXCEPTION_KINDS: Notification["kind"][] = ["login_required", "unknown_outcome", "content_shortage", "worker_offline", "missed_schedule", "missed_analytics", "approval_invalidated", "job_failed"];

/**
 * Creates a persistent in-app notification and queues external deliveries.
 * Deduplicated by (org, eventId): emitting the same event twice is a no-op and returns the existing row.
 * Delivery is a separate concern (processDeliveries); a delivery retry never touches publishing.
 */
export async function emitNotification(ctx: Ctx, input: EmitInput): Promise<{ notification: Notification; created: boolean }> {
  return withTx(ctx, async (tx) => {
    const inserted = await tx.db
      .insert(notifications)
      .values({
        orgId: tx.orgId,
        eventId: input.eventId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        accountId: input.accountId ?? null,
        creatorId: input.creatorId ?? null,
        campaignId: input.campaignId ?? null,
        jobId: input.jobId ?? null,
        analyticsJobId: input.analyticsJobId ?? null,
        workerId: input.workerId ?? null,
        data: input.data ?? {},
        createdAt: tx.clock.now(),
      })
      .onConflictDoNothing({ target: [notifications.orgId, notifications.eventId] })
      .returning();
    if (inserted.length === 0) {
      const existing = await tx.db.query.notifications.findFirst({ where: and(eq(notifications.orgId, tx.orgId), eq(notifications.eventId, input.eventId)) });
      return { notification: existing!, created: false };
    }
    const n = inserted[0]!;
    const channels = await tx.db.query.notificationChannels.findMany({ where: and(eq(notificationChannels.orgId, tx.orgId), eq(notificationChannels.enabled, true)) });
    for (const ch of channels) {
      if (!ch.verifiedAt) continue; // never deliver externally until a labeled test succeeded
      if (!shouldDeliverImmediately(ch.settings, n.kind)) continue;
      await tx.db.insert(notificationDeliveries).values({ orgId: tx.orgId, notificationId: n.id, channelId: ch.id, nextAttemptAt: tx.clock.now() }).onConflictDoNothing();
    }
    return { notification: n, created: true };
  });
}

export function shouldDeliverImmediately(s: ChannelSettings, kind: Notification["kind"]): boolean {
  if (kind === "test") return true;
  if (kind === "digest") return true;
  if (EXCEPTION_KINDS.includes(kind)) return s.exceptionsImmediate;
  if (kind === "post_verified") return s.successIndividual;
  if (kind === "analytics_complete") return s.analyticsIndividual;
  return false;
}

export type NotificationFilter = { unreadOnly?: boolean; unresolvedOnly?: boolean; kind?: Notification["kind"]; accountId?: string; limit?: number };

export async function listNotifications(ctx: Ctx, f: NotificationFilter = {}): Promise<Notification[]> {
  const where: SQL[] = [eq(notifications.orgId, ctx.orgId)];
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`(${notifications.creatorId} IS NULL OR ${notifications.creatorId} = ANY(${uuidArray(scope)}))`);
  if (f.unreadOnly) where.push(isNull(notifications.readAt));
  if (f.unresolvedOnly) where.push(isNull(notifications.resolvedAt));
  if (f.kind) where.push(eq(notifications.kind, f.kind));
  if (f.accountId) where.push(eq(notifications.accountId, f.accountId));
  return ctx.db
    .select()
    .from(notifications)
    .where(and(...where))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(f.limit ?? 50, 500));
}

export async function markRead(ctx: Ctx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await ctx.db.update(notifications).set({ readAt: ctx.clock.now() }).where(and(eq(notifications.orgId, ctx.orgId), inArray(notifications.id, ids), isNull(notifications.readAt)));
}

export async function markAllRead(ctx: Ctx): Promise<void> {
  await ctx.db.update(notifications).set({ readAt: ctx.clock.now() }).where(and(eq(notifications.orgId, ctx.orgId), isNull(notifications.readAt)));
}

export async function resolveNotification(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "operator", "resolve notifications");
  const [row] = await ctx.db
    .update(notifications)
    .set({ resolvedAt: ctx.clock.now(), resolvedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null, readAt: ctx.clock.now() })
    .where(and(eq(notifications.orgId, ctx.orgId), eq(notifications.id, id)))
    .returning();
  if (!row) throw new AppError("not_found", "Notification not found.");
  await recordAudit(ctx, { eventType: "notification.resolved", message: `Resolved “${row.title}”.`, notificationId: row.id, accountId: row.accountId, jobId: row.jobId, isHumanIntervention: true });
}

export async function resolveNotificationsFor(ctx: Ctx, match: { jobId?: string; accountId?: string; kinds?: Notification["kind"][] }): Promise<void> {
  const where: SQL[] = [eq(notifications.orgId, ctx.orgId), isNull(notifications.resolvedAt)];
  if (match.jobId) where.push(eq(notifications.jobId, match.jobId));
  if (match.accountId) where.push(eq(notifications.accountId, match.accountId));
  if (match.kinds) where.push(inArray(notifications.kind, match.kinds));
  if (!match.jobId && !match.accountId) return;
  await ctx.db.update(notifications).set({ resolvedAt: ctx.clock.now(), readAt: ctx.clock.now() }).where(and(...where));
}

// ---------- channels ----------
export type SafeChannel = Omit<NotificationChannel, "secretEncrypted">;
const stripSecret = (c: NotificationChannel): SafeChannel => {
  const { secretEncrypted: _s, ...rest } = c;
  return rest;
};

export async function listChannels(ctx: Ctx): Promise<SafeChannel[]> {
  requireRole(ctx, "operator", "view notification channels");
  const rows = await ctx.db.query.notificationChannels.findMany({ where: eq(notificationChannels.orgId, ctx.orgId), orderBy: asc(notificationChannels.createdAt) });
  return rows.map(stripSecret);
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { exceptionsImmediate: true, successIndividual: false, analyticsIndividual: true, digest: "off", digestTime: "09:00" };

export function describeDiscordWebhook(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw validation("Enter a full Discord webhook URL.");
  }
  if (u.protocol !== "https:" || !/^(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)$/.test(u.hostname) || !u.pathname.startsWith("/api/webhooks/")) {
    throw validation("Only https://discord.com/api/webhooks/… URLs are accepted.");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const idPart = parts[2] ?? "";
  return `discord.com/api/webhooks/${idPart.slice(0, 4)}…${idPart.slice(-2)}/••••••`;
}

export async function createDiscordChannel(ctx: Ctx, input: { name: string; webhookUrl: string; settings?: Partial<ChannelSettings> }): Promise<SafeChannel> {
  requireRole(ctx, "owner", "configure notification destinations");
  const label = describeDiscordWebhook(input.webhookUrl);
  if (!input.name.trim()) throw validation("Give the destination a name.");
  const [row] = await ctx.db
    .insert(notificationChannels)
    .values({
      orgId: ctx.orgId,
      kind: "discord_webhook",
      name: input.name.trim(),
      secretEncrypted: encryptSecret(input.webhookUrl.trim()),
      destinationLabel: label,
      enabled: false,
      settings: { ...DEFAULT_CHANNEL_SETTINGS, ...(input.settings ?? {}) },
      createdByUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .returning();
  await recordAudit(ctx, { eventType: "channel.created", message: `Added Discord destination “${row!.name}” (${label}). Delivery stays off until a test succeeds.` });
  return stripSecret(row!);
}

export async function updateChannel(ctx: Ctx, id: string, patch: { name?: string; enabled?: boolean; settings?: Partial<ChannelSettings>; webhookUrl?: string }): Promise<SafeChannel> {
  requireRole(ctx, "owner", "configure notification destinations");
  const current = await ctx.db.query.notificationChannels.findFirst({ where: and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, ctx.orgId)) });
  if (!current) throw new AppError("not_found", "Destination not found.");
  if (patch.enabled && !current.verifiedAt && !patch.webhookUrl) throw validation("Run a successful test before enabling delivery.");
  const values: Partial<typeof notificationChannels.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.settings) values.settings = { ...current.settings, ...patch.settings };
  if (patch.webhookUrl) {
    values.destinationLabel = describeDiscordWebhook(patch.webhookUrl);
    values.secretEncrypted = encryptSecret(patch.webhookUrl.trim());
    values.verifiedAt = null;
    values.enabled = false;
  }
  const [row] = await ctx.db.update(notificationChannels).set(values).where(eq(notificationChannels.id, id)).returning();
  await recordAudit(ctx, { eventType: "channel.updated", message: `Updated destination “${row!.name}”${patch.enabled !== undefined ? ` (delivery ${patch.enabled ? "on" : "off"})` : ""}.` });
  return stripSecret(row!);
}

export async function deleteChannel(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "owner", "remove notification destinations");
  const [row] = await ctx.db.delete(notificationChannels).where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, ctx.orgId))).returning();
  if (row) await recordAudit(ctx, { eventType: "channel.deleted", message: `Removed destination “${row.name}”.` });
}

// ---------- delivery adapter ----------
export interface DeliveryTransport {
  sendDiscord(webhookUrl: string, payload: { content: string; username?: string }): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }>;
}

export const fetchTransport: DeliveryTransport = {
  async sendDiscord(webhookUrl, payload) {
    try {
      const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
      if (res.ok) return { ok: true };
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, error: `Discord responded ${res.status}`, retryable };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error", retryable: true };
    }
  },
};

export function formatForDiscord(n: Pick<Notification, "kind" | "severity" | "title" | "body" | "data">, appUrl: string, demo: boolean): string {
  const icon = n.severity === "critical" ? "🔴" : n.severity === "warning" ? "🟠" : "🟢";
  const link = (n.data?.["url"] as string | undefined) ? `\n${appUrl}${n.data!["url"] as string}` : "";
  return `${icon} **${n.title}**${demo ? " · Demo data" : ""}\n${n.body}${link}`;
}

/** Sends a labeled test message. Success marks the channel verified; delivery still needs to be enabled explicitly. */
export async function testChannel(ctx: Ctx, id: string, transport: DeliveryTransport = fetchTransport, appUrl = process.env.APP_URL ?? "http://localhost:3000"): Promise<{ ok: boolean; error?: string }> {
  requireRole(ctx, "owner", "test notification destinations");
  const ch = await ctx.db.query.notificationChannels.findFirst({ where: and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, ctx.orgId)) });
  if (!ch) throw new AppError("not_found", "Destination not found.");
  const url = decryptSecret(ch.secretEncrypted);
  const result = await transport.sendDiscord(url, {
    username: "Synthos posting",
    content: formatForDiscord({ kind: "test", severity: "info", title: "Test message", body: `This is a test from Synthos posting${ctx.actor.type === "user" ? ` sent by ${ctx.actor.name}` : ""}. No real event occurred.`, data: {} }, appUrl, ctx.settings.demoMode),
  });
  await ctx.db
    .update(notificationChannels)
    .set({ lastTestAt: ctx.clock.now(), lastTestResult: result.ok ? "ok" : result.error, verifiedAt: result.ok ? ctx.clock.now() : ch.verifiedAt })
    .where(eq(notificationChannels.id, id));
  await recordAudit(ctx, { eventType: "channel.tested", message: result.ok ? `Test message delivered to “${ch.name}”.` : `Test message to “${ch.name}” failed: ${result.error}`, errorCategory: result.ok ? null : "network" });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/** Called by the scheduler. Retries with bounded backoff. Marking a delivery failed never affects the underlying event. */
export async function processDeliveries(ctx: Ctx, transport: DeliveryTransport = fetchTransport, appUrl = process.env.APP_URL ?? "http://localhost:3000", limit = 25): Promise<{ sent: number; failed: number }> {
  const now = ctx.clock.now();
  const due = await ctx.db
    .select({ d: notificationDeliveries, n: notifications, c: notificationChannels })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(and(eq(notificationDeliveries.orgId, ctx.orgId), eq(notificationDeliveries.state, "queued"), lte(notificationDeliveries.nextAttemptAt, now)))
    .orderBy(asc(notificationDeliveries.nextAttemptAt))
    .limit(limit);
  let sent = 0;
  let failed = 0;
  for (const { d, n, c } of due) {
    if (!c.enabled || !c.verifiedAt) {
      await ctx.db.update(notificationDeliveries).set({ state: "skipped", lastError: "Destination disabled or not verified" }).where(eq(notificationDeliveries.id, d.id));
      continue;
    }
    const result = await transport.sendDiscord(decryptSecret(c.secretEncrypted), { username: "Synthos posting", content: formatForDiscord(n, appUrl, ctx.settings.demoMode) });
    const attempts = d.attempts + 1;
    if (result.ok) {
      sent++;
      await ctx.db.update(notificationDeliveries).set({ state: "sent", attempts, sentAt: now, lastError: null }).where(eq(notificationDeliveries.id, d.id));
    } else {
      const giveUp = !result.retryable || attempts >= BACKOFF_MS.length;
      failed++;
      await ctx.db
        .update(notificationDeliveries)
        .set({ state: giveUp ? "failed" : "queued", attempts, lastError: result.error, nextAttemptAt: new Date(now.getTime() + (BACKOFF_MS[attempts - 1] ?? 3_600_000)) })
        .where(eq(notificationDeliveries.id, d.id));
      if (giveUp) await recordAudit(ctx, { eventType: "delivery.failed", message: `Could not deliver “${n.title}” to ${c.name} after ${attempts} attempts: ${result.error}`, notificationId: n.id, errorCategory: "network" });
    }
  }
  return { sent, failed };
}

export async function listDeliveries(ctx: Ctx, notificationId: string): Promise<Array<NotificationDelivery & { channelName: string }>> {
  const rows = await ctx.db
    .select({ d: notificationDeliveries, name: notificationChannels.name })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(and(eq(notificationDeliveries.orgId, ctx.orgId), eq(notificationDeliveries.notificationId, notificationId)));
  return rows.map((r) => ({ ...r.d, channelName: r.name }));
}

/** Builds a daily digest notification summarizing the last 24h. Deduplicated per day. */
export async function emitDailyDigest(ctx: Ctx, dayKey: string, summary: { verified: number; failed: number; needsAttention: number; analyticsDone: number }): Promise<void> {
  await emitNotification(ctx, {
    eventId: `digest:${dayKey}`,
    kind: "digest",
    severity: "info",
    title: `Daily digest for ${dayKey}`,
    body: `${summary.verified} verified live, ${summary.failed} failed, ${summary.needsAttention} need attention, ${summary.analyticsDone} analytics reports completed.`,
    data: { url: "/today" },
  });
}
