import { and, eq } from "drizzle-orm";
import { accounts, assets, postingJobs } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

/** Unclear outcomes on this worker's accounts, for reconciliation. */
export const GET = withWorker(async (ctx, worker) => {
  const rows = await ctx.db
    .select({ j: postingJobs, a: accounts, asset: assets })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .leftJoin(assets, eq(assets.id, postingJobs.assetId))
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.state, "UNKNOWN_OUTCOME"), eq(accounts.workerId, worker.id), eq(accounts.sessionControl, "worker")))
    .limit(10);
  return json({
    jobs: rows.map(({ j, a, asset }) => ({
      jobId: j.id,
      account: { id: a.id, handle: a.handle, verifiedIgUserId: a.verifiedIgUserId, timezone: a.timezone, browserProfileKey: a.browserProfileKey, executionRoute: a.executionRoute },
      content: { assetId: j.assetId, sha256: j.approvalSnapshot?.sha256 ?? "", caption: j.approvalSnapshot?.caption ?? "", format: "reel", audience: "public", mediaUrlPath: "", filename: asset?.originalFilename ?? "", mime: asset?.mime ?? "", durationSeconds: asset?.durationSeconds ?? null },
      idempotencyKey: j.idempotencyKey,
    })),
  });
});
