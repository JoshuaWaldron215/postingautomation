import { analytics, protocol } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, worker, req) => {
  const body = protocol.ClaimRequest.parse(await req.json().catch(() => ({})));
  return json(await analytics.claimAnalytics(ctx, { workerId: worker.id, max: body.max }));
});
