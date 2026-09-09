import { analytics, protocol } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, _worker, req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = protocol.JobHeartbeatRequest.parse(await req.json());
  await analytics.heartbeatAnalytics(ctx, id, body.fence);
  return json({ ok: true });
});
