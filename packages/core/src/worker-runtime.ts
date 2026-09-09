/**
 * Adapter-agnostic execution loop for one claimed job / analytics job.
 * The real worker implements `WorkerApi` over HTTP; the seed and tests implement it with direct
 * service calls, so the same code path is exercised everywhere.
 */
import type { PublisherAdapter, AdapterControl } from "./adapters/types";
import type { ClaimedJob } from "./services/jobs";
import type { ClaimedAnalyticsJob, AnalyticsResult } from "./services/analytics";
import type { JobResult } from "./services/jobs";

export interface WorkerApi {
  beginSubmitting(jobId: string, fence: number, identity: { observedHandle: string | null; observedIgUserId: string | null; sessionReady: boolean }): Promise<{ ok: true } | { ok: false; reason: string }>;
  heartbeatJob(jobId: string, fence: number): Promise<{ shouldAbort: boolean; reason?: string }>;
  reportResult(jobId: string, fence: number, result: JobResult): Promise<void>;
  heartbeatAnalytics(analyticsJobId: string, fence: number): Promise<void>;
  reportAnalytics(analyticsJobId: string, fence: number, result: AnalyticsResult): Promise<void>;
  storeEvidence(name: string, data: Buffer, mime: string, ref: { jobId?: string; analyticsJobId?: string }): Promise<string | null>;
  /** Downloads the media for a claimed job to a local path (worker) or returns the storage path (seed/tests). */
  fetchMedia(job: ClaimedJob): Promise<string>;
  log(message: string): void;
}

export async function executeClaimedJob(adapter: PublisherAdapter, job: ClaimedJob, api: WorkerApi): Promise<void> {
  const log = (m: string) => api.log(`[job ${job.jobId.slice(0, 8)} @${job.account.handle}] ${m}`);
  const storeEvidence = (name: string, data: Buffer, mime: string) => api.storeEvidence(name, data, mime, { jobId: job.jobId });
  let identity: Awaited<ReturnType<PublisherAdapter["verifyIdentity"]>>;
  try {
    identity = await adapter.verifyIdentity(job.account, { log, storeEvidence });
  } catch (err) {
    await api.reportResult(job.jobId, job.fence, { outcome: "failed", category: "internal", message: `Identity check crashed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  // The server persists SUBMITTING and re-checks pauses/approval/identity. If it says no, we never click Share.
  const gate = await api.beginSubmitting(job.jobId, job.fence, { observedHandle: identity.observedHandle, observedIgUserId: identity.observedIgUserId, sessionReady: identity.sessionReady });
  if (!gate.ok) {
    log(`not submitting: ${gate.reason}`);
    return;
  }
  let mediaPath: string;
  try {
    mediaPath = await api.fetchMedia(job);
  } catch (err) {
    await api.reportResult(job.jobId, job.fence, { outcome: "failed", category: "content_missing", message: `Could not download media: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const ctrl: AdapterControl = {
    heartbeat: async () => {
      const hb = await api.heartbeatJob(job.jobId, job.fence);
      if (hb.shouldAbort) log(`abort requested: ${hb.reason}`);
      return !hb.shouldAbort;
    },
    storeEvidence,
    log,
    mediaPath,
  };
  let outcome: Awaited<ReturnType<PublisherAdapter["publish"]>>;
  try {
    outcome = await adapter.publish(job, ctrl);
  } catch (err) {
    // We were already SUBMITTING: a crash here is an unknown outcome, never a retry.
    outcome = { outcome: "unknown", message: `Publish step crashed after submission started: ${err instanceof Error ? err.message : String(err)}` };
  }
  await api.reportResult(job.jobId, job.fence, outcome);
}

export async function executeAnalyticsJob(adapter: PublisherAdapter, job: ClaimedAnalyticsJob, api: WorkerApi): Promise<void> {
  const log = (m: string) => api.log(`[analytics ${job.analyticsJobId.slice(0, 8)} @${job.account.handle}] ${m}`);
  const storeEvidence = (name: string, data: Buffer, mime: string) => api.storeEvidence(name, data, mime, { analyticsJobId: job.analyticsJobId });
  let result: Awaited<ReturnType<PublisherAdapter["readMetrics"]>>;
  try {
    result = await adapter.readMetrics(job, { log, storeEvidence, heartbeat: async () => { await api.heartbeatAnalytics(job.analyticsJobId, job.fence); return true; } });
  } catch (err) {
    result = { outcome: "failed", category: "internal", message: err instanceof Error ? err.message : String(err) };
  }
  await api.reportAnalytics(job.analyticsJobId, job.fence, result.outcome === "observed" ? { ...result, postFound: true } : result);
}
