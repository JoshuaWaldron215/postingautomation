import { jobs, protocol } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, _worker, req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = protocol.ReconcileRequest.parse(await req.json());
  return json(await jobs.reconcileJob(ctx, id, body.finding));
});
