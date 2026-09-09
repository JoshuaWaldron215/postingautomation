import { and, eq } from "drizzle-orm";
import { accounts, protocol, workersService } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, worker, req) => {
  const body = protocol.HeartbeatRequest.parse(await req.json().catch(() => ({})));
  const w = await workersService.heartbeat(ctx, worker.id, { version: body.version, capabilities: body.capabilities, hostInfo: body.hostInfo, maxConcurrency: body.maxConcurrency });
  const assigned = await ctx.db.select({ id: accounts.id, handle: accounts.handle, browserProfileKey: accounts.browserProfileKey, tags: accounts.tags, sessionControl: accounts.sessionControl }).from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.workerId, worker.id)));
  const res: protocol.HeartbeatResponse = { workerId: w.id, name: w.name, status: w.status, serverTime: ctx.clock.now().toISOString(), demoMode: ctx.settings.demoMode, globalPause: ctx.settings.globalPause.active, accounts: assigned };
  return json(res);
});
