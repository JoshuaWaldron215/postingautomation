import { jobs, protocol } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

export const POST = withWorker(async (ctx, worker, req) => {
  const body = protocol.ClaimRequest.parse(await req.json().catch(() => ({})));
  return json(await jobs.claimJobs(ctx, { workerId: worker.id, max: body.max }));
});
