"use server";
import { content } from "@synthos/core";
import { run } from "./_util";

export async function updateAssetAction(id: string, patch: { caption?: string; creatorId?: string | null; familyId?: string | null; variantLabel?: string | null; tags?: string[]; sourceOrder?: number }) {
  return run((ctx) => content.updateAsset(ctx, id, patch));
}
export async function bulkUpdateAssetsAction(ids: string[], patch: { creatorId?: string | null; familyId?: string | null; tags?: string[] }) {
  return run((ctx) => content.bulkUpdateAssets(ctx, ids, patch));
}
export async function deleteAssetAction(id: string) {
  return run((ctx) => content.deleteAsset(ctx, id));
}
export async function reorderAssetsAction(ids: string[]) {
  return run((ctx) => content.reorderAssets(ctx, ids));
}
export async function retryProcessingAction(id: string) {
  return run((ctx) => content.retryProcessing(ctx, id));
}
export async function createFamilyAction(input: { name: string; creatorId?: string | null; description?: string }) {
  return run((ctx) => content.createFamily(ctx, input));
}
