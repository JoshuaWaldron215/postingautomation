import { workersService, accountsService } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { WorkersView } from "@/components/settings/workers-view";
export const metadata = { title: "Workers" };
export default async function WorkersPage() {
  const ctx = await getUserCtx();
  const [workers, accounts] = await Promise.all([workersService.listWorkers(ctx), accountsService.listAccounts(ctx, { sort: "handle" })]);
  return <WorkersView workers={workers.map((w) => ({ id: w.id, name: w.name, kind: w.kind, status: w.status, lastHeartbeatAt: w.lastHeartbeatAt?.toISOString() ?? null, tokenPrefix: w.tokenPrefix, maxConcurrency: w.maxConcurrency, version: w.version, capabilities: w.capabilities, hostInfo: w.hostInfo, accountCount: w.accountCount, createdAt: w.createdAt.toISOString(), revokedAt: w.revokedAt?.toISOString() ?? null }))} accounts={accounts.map((a) => ({ id: a.id, handle: a.handle, workerId: a.workerId, effectiveState: a.effectiveState }))} role={ctx.user.role} demoMode={ctx.settings.demoMode} appUrl={process.env.APP_URL ?? "http://localhost:3000"} />;
}
