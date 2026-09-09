"use server";
import { auth, workersService } from "@synthos/core";
import { run } from "./_util";

export async function createWorkerAction(input: { name: string; kind: "simulator" | "hermes_mac"; maxConcurrency?: number }) {
  return run((ctx) => workersService.createWorker(ctx, input));
}
export async function revokeWorkerAction(id: string) {
  return run((ctx) => workersService.revokeWorker(ctx, id));
}
export async function rotateWorkerTokenAction(id: string) {
  return run((ctx) => workersService.rotateWorkerToken(ctx, id));
}
export async function createUserAction(input: { email: string; name: string; password: string; role: "owner" | "operator" | "viewer"; creatorScope?: string[] | null }) {
  return run((ctx) => auth.createUser(ctx, input));
}
export async function updateUserRoleAction(id: string, role: "owner" | "operator" | "viewer", creatorScope?: string[] | null) {
  return run((ctx) => auth.updateUserRole(ctx, id, role, creatorScope));
}
export async function exportActivityAction(filter: Record<string, string | undefined>) {
  return run(async (ctx) => {
    const { audit } = await import("@synthos/core");
    return audit.exportActivityCsv(ctx, { q: filter.q, accountId: filter.accountId, creatorId: filter.creatorId, campaignId: filter.campaignId, eventType: filter.eventType, humanOnly: filter.humanOnly === "1", errorsOnly: filter.errorsOnly === "1" });
  }, []);
}
