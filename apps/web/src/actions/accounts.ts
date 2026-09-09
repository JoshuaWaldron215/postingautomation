"use server";
import { accountsService, type PostingPolicy } from "@synthos/core";
import { run } from "./_util";

export async function pauseAccountsAction(ids: string[], reason?: string) {
  return run((ctx) => accountsService.pauseAccounts(ctx, ids, reason));
}
export async function resumeAccountsAction(ids: string[]) {
  return run((ctx) => accountsService.resumeAccounts(ctx, ids));
}
export async function updateAccountAction(id: string, patch: { displayName?: string; creatorId?: string; timezone?: string; postingPolicy?: PostingPolicy; workerId?: string | null; executionRoute?: "simulator" | "browser_hermes" | "pixel" | "official_api"; browserProfileKey?: string | null; tags?: string[] }) {
  return run((ctx) => accountsService.updateAccount(ctx, id, patch));
}
export async function createAccountAction(input: { handle: string; displayName: string; creatorId: string; timezone: string; workerId?: string | null; executionRoute?: "simulator" | "browser_hermes" }) {
  return run((ctx) => accountsService.createAccount(ctx, input));
}
export async function startHandoffAction(id: string, minutes?: number) {
  return run((ctx) => accountsService.startLoginHandoff(ctx, id, minutes));
}
export async function endHandoffAction(id: string, loggedIn: boolean, notes?: string) {
  return run((ctx) => accountsService.endLoginHandoff(ctx, id, { loggedIn, notes }));
}
export async function clearReviewAction(id: string, note: string) {
  return run((ctx) => accountsService.clearReview(ctx, id, note));
}
export async function togglePinAction(id: string) {
  return run((ctx) => accountsService.togglePin(ctx, id));
}
export async function createCreatorAction(input: { name: string; color?: string }) {
  return run((ctx) => accountsService.createCreator(ctx, input));
}
export async function pauseCreatorAction(id: string, reason?: string) {
  return run((ctx) => accountsService.pauseCreator(ctx, id, reason));
}
export async function resumeCreatorAction(id: string) {
  return run((ctx) => accountsService.resumeCreator(ctx, id));
}
