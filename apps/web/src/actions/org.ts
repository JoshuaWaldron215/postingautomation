"use server";
import { org } from "@synthos/core";
import { run } from "./_util";

export async function setGlobalPauseAction(active: boolean, reason?: string) {
  return run(async (ctx) => {
    await org.setGlobalPause(ctx, active, reason);
  });
}
export async function advanceClockAction(deltaMs: number) {
  return run(async (ctx) => {
    if (deltaMs === 0) await org.resetSimulatedClock(ctx);
    else await org.advanceSimulatedClock(ctx, deltaMs);
  });
}
export async function updateAnalyticsSettingsAction(patch: { delayHours?: number; lateAfterMinutes?: number; threshold?: { metric?: "plays" | "views" | "reach"; value?: number; comparator?: "gt" | "gte" } }) {
  return run(async (ctx) => {
    await org.updateAnalyticsSettings(ctx, patch as never);
  });
}
export async function updateRetentionSettingsAction(patch: { evidenceDays?: number; deletedAssetDays?: number; minGapMinutes?: number }) {
  return run(async (ctx) => {
    await org.updateRetentionSettings(ctx, patch);
  });
}
