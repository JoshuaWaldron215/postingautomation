/**
 * HTTP client for the worker protocol. Outbound only; authenticated with a scoped worker token.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { protocol, jobs, analytics } from "@synthos/core";
import type { WorkerApi } from "@synthos/core/worker-runtime";

export class ProtocolError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: (m: string) => void,
  ) {}

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/worker/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) throw new ProtocolError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  heartbeat(body: protocol.HeartbeatRequest) {
    return this.call<protocol.HeartbeatResponse>("POST", "/heartbeat", body);
  }
  claimJobs(max: number) {
    return this.call<{ jobs: jobs.ClaimedJob[]; reason?: string }>("POST", "/jobs/claim", { max });
  }
  claimAnalytics(max: number) {
    return this.call<{ jobs: analytics.ClaimedAnalyticsJob[]; reason?: string }>("POST", "/analytics/claim", { max });
  }
  listUnknown() {
    return this.call<{ jobs: Array<{ jobId: string; account: jobs.ClaimedJob["account"]; content: jobs.ClaimedJob["content"]; idempotencyKey: string }> }>("GET", "/jobs/unknown");
  }
  reconcile(jobId: string, finding: protocol.ReconcileRequest["finding"]) {
    return this.call<{ state: string }>("POST", `/jobs/${jobId}/reconcile`, { finding });
  }
  reportSession(body: protocol.SessionReportRequest) {
    return this.call<{ ok: true }>("POST", "/sessions/report", body);
  }

  async downloadMedia(job: jobs.ClaimedJob, dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${job.jobId}-${job.content.filename.replace(/[^a-z0-9_.-]/gi, "_")}`);
    const res = await fetch(`${this.baseUrl}${job.content.mediaUrlPath}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`media download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(target, buf);
    return target;
  }

  async uploadEvidence(name: string, data: Buffer, mime: string, ref: { jobId?: string; analyticsJobId?: string }): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/worker/v1/evidence?${new URLSearchParams({ name, ...(ref.jobId ? { jobId: ref.jobId } : {}), ...(ref.analyticsJobId ? { analyticsJobId: ref.analyticsJobId } : {}) })}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": mime },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { key: string };
      return json.key;
    } catch (err) {
      this.log(`evidence upload failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  api(mediaDir: string): WorkerApi {
    return {
      beginSubmitting: async (jobId, fence, identity) => {
        const r = await this.call<{ ok: true } | { ok: false; reason: string }>("POST", `/jobs/${jobId}/submitting`, { fence, identity });
        return r;
      },
      heartbeatJob: async (jobId, fence) => this.call("POST", `/jobs/${jobId}/heartbeat`, { fence }),
      reportResult: async (jobId, fence, result) => {
        await this.call("POST", `/jobs/${jobId}/result`, { fence, result });
      },
      heartbeatAnalytics: async (id, fence) => {
        await this.call("POST", `/analytics/${id}/heartbeat`, { fence });
      },
      reportAnalytics: async (id, fence, result) => {
        await this.call("POST", `/analytics/${id}/result`, { fence, result });
      },
      storeEvidence: (name, data, mime, ref) => this.uploadEvidence(name, data, mime, ref),
      fetchMedia: (job) => this.downloadMedia(job, mediaDir),
      log: this.log,
    };
  }
}
