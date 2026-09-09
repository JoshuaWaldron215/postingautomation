"use server";
import { notificationsService } from "@synthos/core";
import { run } from "./_util";

export async function markNotificationsRead(ids: string[]) {
  return run((ctx) => notificationsService.markRead(ctx, ids), []);
}
export async function resolveNotificationAction(id: string) {
  return run((ctx) => notificationsService.resolveNotification(ctx, id));
}
export async function createChannelAction(input: { name: string; webhookUrl: string }) {
  return run((ctx) => notificationsService.createDiscordChannel(ctx, input));
}
export async function updateChannelAction(id: string, patch: { name?: string; enabled?: boolean; webhookUrl?: string; settings?: Partial<{ exceptionsImmediate: boolean; successIndividual: boolean; analyticsIndividual: boolean; digest: "off" | "daily"; digestTime: string }> }) {
  return run((ctx) => notificationsService.updateChannel(ctx, id, patch));
}
export async function deleteChannelAction(id: string) {
  return run((ctx) => notificationsService.deleteChannel(ctx, id));
}
export async function testChannelAction(id: string) {
  return run((ctx) => notificationsService.testChannel(ctx, id));
}
