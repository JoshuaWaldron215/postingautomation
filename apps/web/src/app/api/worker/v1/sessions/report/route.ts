import { accountsService, protocol } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, _worker, req) => {
  const body = protocol.SessionReportRequest.parse(await req.json());
  await accountsService.reportSession(ctx, body.accountId, { readiness: body.readiness, observedHandle: body.observedHandle, observedIgUserId: body.observedIgUserId });
  return json({ ok: true });
});
