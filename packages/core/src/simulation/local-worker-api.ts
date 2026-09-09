/**
 * WorkerApi backed by direct service calls (no HTTP). Used by the seed and the test-suite so the
 * simulator drives exactly the same services the HTTP worker protocol calls.
 */
import { and, eq } from "drizzle-orm";
import { assets, postingJobs } from "../db/schema";
import { reportAnalytics, heartbeatAnalytics, type AnalyticsResult } from "../services/analytics";
import type { Ctx } from "../services/context";
import { beginSubmitting, heartbeatJob, reportResult, type ClaimedJob, type JobResult } from "../services/jobs";
import { resolveKey, writeFileKey } from "../services/media";
import { shortId } from "../lib/ids";
import type { WorkerApi } from "../worker-runtime";

export function localWorkerApi(ctx: () => Ctx, opts: { log?: (m: string) => void } = {}): WorkerApi {
  return {
    async beginSubmitting(jobId, fence, identity) {
      const r = await beginSubmitting(ctx(), jobId, fence, identity);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    async heartbeatJob(jobId, fence) {
      const r = await heartbeatJob(ctx(), jobId, fence);
      return { shouldAbort: r.shouldAbort, reason: r.reason };
    },
    async reportResult(jobId, fence, result: JobResult) {
      await reportResult(ctx(), jobId, fence, result);
    },
    async heartbeatAnalytics(id, fence) {
      await heartbeatAnalytics(ctx(), id, fence);
    },
    async reportAnalytics(id, fence, result: AnalyticsResult) {
      await reportAnalytics(ctx(), id, fence, result);
    },
    async storeEvidence(name, data, mime, ref) {
      const ext = mime === "image/png" ? "png" : "txt";
      const key = `evidence/${ctx().orgId}/${ref.jobId ?? ref.analyticsJobId ?? "misc"}/${shortId()}-${name.replace(/[^a-z0-9_.-]/gi, "_")}.${ext}`;
      await writeFileKey(key, data);
      return key;
    },
    async fetchMedia(job: ClaimedJob) {
      const c = ctx();
      const j = await c.db.query.postingJobs.findFirst({ where: and(eq(postingJobs.id, job.jobId), eq(postingJobs.orgId, c.orgId)) });
      const a = j?.assetId ? await c.db.query.assets.findFirst({ where: eq(assets.id, j.assetId) }) : null;
      if (!a) throw new Error("asset missing");
      return resolveKey(a.storageKey);
    },
    log: opts.log ?? (() => {}),
  };
}
