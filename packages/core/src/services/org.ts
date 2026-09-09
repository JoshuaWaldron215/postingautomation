import { eq } from "drizzle-orm";
import { organizations, type OrgSettings } from "../db/schema";
import { validation } from "../lib/errors";
import { recordAudit } from "./audit";
import { requireRole, type Ctx } from "./context";

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  demoMode: true,
  simClockOffsetMs: 0,
  globalPause: { active: false },
  analytics: {
    delayHours: 10,
    threshold: { metric: "plays", value: 1000, comparator: "gte" },
    lateAfterMinutes: 60,
  },
  retention: { evidenceDays: 30, deletedAssetDays: 14 },
  minGapMinutes: 5,
};

export async function getSettings(ctx: Ctx): Promise<OrgSettings> {
  const row = await ctx.db.query.organizations.findFirst({ where: eq(organizations.id, ctx.orgId) });
  return row?.settings ?? DEFAULT_ORG_SETTINGS;
}

export async function saveSettings(ctx: Ctx, next: OrgSettings): Promise<OrgSettings> {
  await ctx.db.update(organizations).set({ settings: next }).where(eq(organizations.id, ctx.orgId));
  ctx.settings = next;
  return next;
}

export async function updateAnalyticsSettings(ctx: Ctx, patch: Partial<OrgSettings["analytics"]>): Promise<OrgSettings> {
  requireRole(ctx, "owner", "change analytics settings");
  const current = await getSettings(ctx);
  const analytics = { ...current.analytics, ...patch, threshold: { ...current.analytics.threshold, ...(patch.threshold ?? {}) } };
  if (analytics.delayHours < 1 || analytics.delayHours > 72) throw validation("Analytics delay must be between 1 and 72 hours.");
  if (analytics.threshold.value < 0) throw validation("Threshold must be zero or more.");
  const next = await saveSettings(ctx, { ...current, analytics });
  await recordAudit(ctx, { eventType: "settings.analytics_updated", message: `Updated analytics settings: ${analytics.delayHours}h delay, ${analytics.threshold.metric} ${analytics.threshold.comparator === "gt" ? ">" : "≥"} ${analytics.threshold.value}.` });
  return next;
}

export async function updateRetentionSettings(ctx: Ctx, patch: Partial<OrgSettings["retention"]> & { minGapMinutes?: number }): Promise<OrgSettings> {
  requireRole(ctx, "owner", "change retention settings");
  const current = await getSettings(ctx);
  const next = await saveSettings(ctx, {
    ...current,
    retention: { ...current.retention, evidenceDays: patch.evidenceDays ?? current.retention.evidenceDays, deletedAssetDays: patch.deletedAssetDays ?? current.retention.deletedAssetDays },
    minGapMinutes: patch.minGapMinutes ?? current.minGapMinutes,
  });
  await recordAudit(ctx, { eventType: "settings.retention_updated", message: "Updated retention and spacing settings." });
  return next;
}

export async function setGlobalPause(ctx: Ctx, active: boolean, reason?: string): Promise<OrgSettings> {
  requireRole(ctx, "owner", "pause or resume all posting");
  const current = await getSettings(ctx);
  const next = await saveSettings(ctx, {
    ...current,
    globalPause: active
      ? { active: true, byUserId: ctx.actor.type === "user" ? ctx.actor.id : undefined, at: ctx.clock.now().toISOString(), reason: reason?.trim() || undefined }
      : { active: false },
  });
  await recordAudit(ctx, {
    eventType: active ? "org.global_pause" : "org.global_resume",
    message: active
      ? `Paused all posting${reason ? `: ${reason}` : ""}. New submissions stop immediately; anything already sent to Instagram cannot be undone.`
      : "Resumed posting for all accounts.",
    isHumanIntervention: true,
  });
  return next;
}

/** Demo-only: shift the simulated clock. Refuses when demo mode is off. */
export async function advanceSimulatedClock(ctx: Ctx, deltaMs: number): Promise<OrgSettings> {
  requireRole(ctx, "operator", "advance the simulated clock");
  const current = await getSettings(ctx);
  if (!current.demoMode) throw validation("The simulated clock is only available in demo mode.");
  const next = await saveSettings(ctx, { ...current, simClockOffsetMs: Math.max(0, current.simClockOffsetMs + deltaMs) });
  await recordAudit(ctx, { eventType: "demo.clock_advanced", message: `Advanced the simulated clock by ${Math.round(deltaMs / 60000)} minutes (simulated time, not real elapsed time).`, metadata: { deltaMs, offsetMs: next.simClockOffsetMs } });
  return next;
}

export async function resetSimulatedClock(ctx: Ctx): Promise<OrgSettings> {
  requireRole(ctx, "operator", "reset the simulated clock");
  const current = await getSettings(ctx);
  const next = await saveSettings(ctx, { ...current, simClockOffsetMs: 0 });
  await recordAudit(ctx, { eventType: "demo.clock_reset", message: "Reset the simulated clock to real time." });
  return next;
}
