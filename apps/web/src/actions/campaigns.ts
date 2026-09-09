"use server";
import { campaignsService, type CampaignTemplate } from "@synthos/core";
import { run } from "./_util";

export type CampaignFormInput = { name: string; creatorId?: string | null; startDate: string; endDate: string; template: CampaignTemplate; accountIds: string[]; assetIds: string[]; assignment?: "shared" | "unique" };

export async function previewCampaignAction(input: Omit<CampaignFormInput, "name">, excludeCampaignId?: string) {
  return run(async (ctx) => {
    const p = await campaignsService.previewCampaign(ctx, input, excludeCampaignId);
    return { ...p, slots: p.slots.map((s) => ({ ...s, plannedAt: s.plannedAt.toISOString() })), conflicts: p.conflicts.map((c) => ({ ...c, plannedAt: c.plannedAt.toISOString() })) };
  }, []);
}
export async function createCampaignAction(input: CampaignFormInput) {
  return run((ctx) => campaignsService.createCampaign(ctx, input));
}
export async function updateCampaignAction(id: string, input: CampaignFormInput) {
  return run((ctx) => campaignsService.updateCampaign(ctx, id, input));
}
export async function approveCampaignAction(id: string) {
  return run((ctx) => campaignsService.approveCampaign(ctx, id));
}
export async function pauseCampaignAction(id: string, reason?: string) {
  return run((ctx) => campaignsService.pauseCampaign(ctx, id, reason));
}
export async function resumeCampaignAction(id: string) {
  return run((ctx) => campaignsService.resumeCampaign(ctx, id));
}
export async function cancelCampaignAction(id: string, reason?: string) {
  return run((ctx) => campaignsService.cancelCampaign(ctx, id, reason));
}
export async function assignAssetToJobAction(jobId: string, assetId: string | null) {
  return run((ctx) => campaignsService.assignAssetToJob(ctx, jobId, assetId));
}
