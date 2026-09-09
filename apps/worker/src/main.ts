/**
 * Synthos execution worker.
 *
 *   WORKER_ADAPTER=simulator  → local development against the dashboard (no Instagram)
 *   WORKER_ADAPTER=hermes     → Mac mini: drives Hermes through the file-based task contract
 *
 * The worker only ever makes outbound HTTPS calls to APP_URL with a scoped WORKER_TOKEN.
 * It never exposes a browser-debugging port or terminal. See docs/mac-worker.md.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { HermesAdapter, SimulatorAdapter, loadDotEnv, type PublisherAdapter } from "@synthos/core";
import { executeAnalyticsJob, executeClaimedJob } from "@synthos/core/worker-runtime";
import { ProtocolError, WorkerClient } from "./client.js";

loadDotEnv();

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN ?? "";
const ADAPTER = (process.env.WORKER_ADAPTER ?? "simulator").toLowerCase();
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 3000);
const MAX_CONCURRENCY = Number(process.env.WORKER_MAX_CONCURRENCY ?? 2);
const VERSION = "0.1.0";
const MEDIA_DIR = path.join(os.tmpdir(), "synthos-worker-media");

const log = (m: string) => console.log(`${new Date().toISOString()} worker ${m}`);

function buildAdapter(tagsFor: (accountId: string, handle: string) => string[]): PublisherAdapter {
  if (ADAPTER === "hermes") {
    const command = process.env.HERMES_COMMAND;
    if (!command) throw new Error("HERMES_COMMAND is required for WORKER_ADAPTER=hermes (see docs/mac-worker.md)");
    return new HermesAdapter({
      command,
      workdir: process.env.HERMES_WORKDIR ?? path.join(os.homedir(), "synthos-hermes-work"),
      profilesDir: process.env.HERMES_PROFILES_DIR ?? path.join(os.homedir(), "synthos-browser-profiles"),
      timeoutMs: Number(process.env.HERMES_TIMEOUT_MS ?? 15 * 60_000),
    });
  }
  if (ADAPTER !== "simulator") throw new Error(`Unknown WORKER_ADAPTER "${ADAPTER}". Use simulator or hermes.`);
  return new SimulatorAdapter({ stepDelayMs: Number(process.env.SIMULATOR_STEP_MS ?? 1500), tagsFor });
}

async function main() {
  if (!TOKEN) {
    console.error("WORKER_TOKEN is not set. Create a worker in Settings → Workers and paste its token into .env (or the worker's environment).");
    process.exit(1);
  }
  const client = new WorkerClient(APP_URL, TOKEN, log);
  const accountTags = new Map<string, string[]>();
  const adapter = buildAdapter((id) => accountTags.get(id) ?? []);
  const caps = await adapter.capabilities();
  log(`adapter=${adapter.kind} (${adapter.executionLabel}) live=${caps.live}`);
  for (const n of caps.notes) log(`  note: ${n}`);
  const api = client.api(MEDIA_DIR);
  let active = 0;
  let stopping = false;
  let lastSessionCheck = 0;

  const heartbeat = async () => {
    const res = await client.heartbeat({ version: VERSION, capabilities: { ...caps, adapter: adapter.kind }, hostInfo: { hostname: os.hostname(), platform: os.platform(), release: os.release(), node: process.version }, maxConcurrency: MAX_CONCURRENCY, adapter: adapter.kind });
    for (const a of res.accounts) accountTags.set(a.id, a.tags);
    return res;
  };

  const first = await heartbeat();
  log(`connected as "${first.name}" (${first.workerId.slice(0, 8)}), ${first.accounts.length} accounts assigned, demoMode=${first.demoMode}, globalPause=${first.globalPause}`);
  if (first.demoMode && caps.live) log("WARNING: the organization is in demo mode; live adapters will not be given jobs.");

  const loop = async () => {
    if (stopping) return;
    try {
      const hb = await heartbeat();
      // Periodic session readiness checks (every 15 min) for accounts the worker controls.
      if (Date.now() - lastSessionCheck > 15 * 60_000 && caps.canVerifyIdentity) {
        lastSessionCheck = Date.now();
        for (const a of hb.accounts.filter((x) => x.sessionControl === "worker").slice(0, 25)) {
          const r = await adapter.checkReadiness({ id: a.id, handle: a.handle, verifiedIgUserId: null, browserProfileKey: a.browserProfileKey });
          await client.reportSession({ accountId: a.id, readiness: r.ready ? "ready" : "needs_login" }).catch(() => {});
        }
      }
      const capacity = MAX_CONCURRENCY - active;
      if (capacity > 0 && !hb.globalPause) {
        const { jobs, reason } = await client.claimJobs(Math.min(capacity, 5));
        if (reason && jobs.length === 0 && Math.random() < 0.05) log(`no jobs: ${reason}`);
        for (const job of jobs) {
          active++;
          log(`claimed post for @${job.account.handle} (attempt ${job.attemptNo}, fence ${job.fence})`);
          executeClaimedJob(adapter, job, api)
            .catch((err) => log(`job ${job.jobId} crashed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
              active--;
              void fs.rm(path.join(MEDIA_DIR), { recursive: true, force: true }).catch(() => {});
            });
        }
        const { jobs: analyticsJobs } = await client.claimAnalytics(Math.max(1, Math.min(capacity - jobs.length, 3)));
        for (const a of analyticsJobs) {
          active++;
          log(`claimed analytics check for @${a.account.handle}`);
          executeAnalyticsJob(adapter, a, api)
            .catch((err) => log(`analytics ${a.analyticsJobId} crashed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => active--);
        }
      }
      // Reconcile unclear outcomes when the adapter can look at the profile.
      if (caps.canReconcile) {
        const { jobs: unknown } = await client.listUnknown();
        for (const u of unknown.slice(0, 2)) {
          const finding = await adapter.reconcile({ jobId: u.jobId, account: u.account, content: u.content, idempotencyKey: u.idempotencyKey }, { log, storeEvidence: (n, d, m) => client.uploadEvidence(n, d, m, { jobId: u.jobId }) });
          if (finding.found === "unknown") continue;
          await client.reconcile(u.jobId, finding.found ? { found: true, postUrl: finding.postUrl, externalId: finding.externalId, publishedAt: finding.publishedAt, publishedAtSource: finding.publishedAtSource, evidenceKey: finding.evidenceKey ?? null } : { found: false, evidenceKey: finding.evidenceKey ?? null, notes: finding.notes });
          log(`reconciled ${u.jobId}: ${finding.found ? "post found" : "no post"}`);
        }
      }
    } catch (err) {
      if (err instanceof ProtocolError && err.status === 401) {
        log("token rejected (revoked or rotated). Exiting.");
        process.exit(2);
      }
      log(`loop error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!stopping) setTimeout(() => void loop(), POLL_MS);
    }
  };
  void loop();
  const stop = () => {
    stopping = true;
    log("stopping after in-flight work finishes");
    const wait = setInterval(() => {
      if (active === 0) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
