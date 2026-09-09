/**
 * Test harness: creates an isolated organization per test file with users, a creator, accounts,
 * a simulator worker and ready assets (tiny generated videos), and exposes helpers that drive the
 * real services with a controllable clock.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, setDb, type Db } from "../db";
import { accounts, creators, organizations, users, workers, assets as assetsTable } from "../db/schema";
import { FixedClock } from "../lib/clock";
import { hashPassword, issueWorkerToken } from "../lib/crypto";
import { makeCtx, systemActor, type Actor, type Ctx } from "../services/context";
import { DEFAULT_ORG_SETTINGS } from "../services/org";
import { appendUploadChunk, completeUpload, startUpload } from "../services/content";
import { generateSample, sampleSpecs } from "../seed/generate-samples";
import { SimulatorAdapter } from "../adapters/simulator";
import { localWorkerApi } from "../simulation/local-worker-api";
import { executeAnalyticsJob, executeClaimedJob } from "../worker-runtime";
import { claimJobs } from "../services/jobs";
import { claimAnalytics, promoteDueAnalytics } from "../services/analytics";
import { tickOrg } from "../services/scheduler";
import { heartbeat } from "../services/workers";

let shared: { db: Db; client: ReturnType<typeof createDb>["client"] } | null = null;
export function testDb(): Db {
  if (!shared) {
    shared = createDb(process.env.DATABASE_URL!, 4);
    setDb(shared.db, shared.client);
  }
  return shared.db;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(opts: { slug?: string; accountCount?: number; assetCount?: number; tagsByIndex?: Record<number, string[]> } = {}) {
  const db = testDb();
  const slug = `${opts.slug ?? "org"}-${Math.random().toString(36).slice(2, 8)}`;
  const clock = new FixedClock(new Date("2026-03-06T15:00:00Z")); // Friday before US DST change (Mar 8 2026)
  const [org] = await db.insert(organizations).values({ name: slug, slug, settings: { ...DEFAULT_ORG_SETTINGS, demoMode: true } }).returning();
  const orgId = org!.id;
  const mkUser = async (name: string, role: "owner" | "operator" | "viewer", creatorScope: string[] | null = null) => {
    const [u] = await db.insert(users).values({ orgId, email: `${name}-${slug}@test.local`, name, passwordHash: hashPassword("password-1234"), role, creatorScope }).returning();
    return u!;
  };
  const owner = await mkUser("owner", "owner");
  const operator = await mkUser("operator", "operator");
  const viewer = await mkUser("viewer", "viewer");
  const [creator] = await db.insert(creators).values({ orgId, name: "Creator A", slug: "creator-a" }).returning();
  const [creatorB] = await db.insert(creators).values({ orgId, name: "Creator B", slug: "creator-b" }).returning();
  const tok = issueWorkerToken();
  const [worker] = await db.insert(workers).values({ orgId, name: "sim", kind: "simulator", tokenPrefix: tok.prefix, tokenHash: tok.hash, maxConcurrency: 2, status: "online", lastHeartbeatAt: clock.now() }).returning();
  const accountRows = [] as Array<typeof accounts.$inferSelect>;
  for (let i = 0; i < (opts.accountCount ?? 3); i++) {
    const [a] = await db
      .insert(accounts)
      .values({ orgId, creatorId: i === 2 ? creatorB!.id : creator!.id, handle: `acct${i}`, displayName: `Account ${i}`, executionRoute: "simulator", workerId: worker!.id, browserProfileKey: `profile-acct${i}`, timezone: i === 1 ? "Europe/London" : "America/New_York", postingPolicy: { ongoingTimes: ["11:00", "18:00"], dayOne: { count: 3, spacingMinutes: 5 } }, state: "ready", sessionReadiness: "ready", verifiedIgUserId: `ig-${i}`, tags: opts.tagsByIndex?.[i] ?? [] })
      .returning();
    accountRows.push(a!);
  }
  const actorFor = (u: typeof owner): Actor => ({ type: "user", id: u.id, name: u.name, role: u.role, creatorScope: u.creatorScope ?? null });
  const ctxFor = async (actor: Actor): Promise<Ctx> => {
    const c = await makeCtx({ db, orgId, actor });
    c.clock = clock;
    return c;
  };
  const ownerCtx = () => ctxFor(actorFor(owner));
  const operatorCtx = () => ctxFor(actorFor(operator));
  const viewerCtx = () => ctxFor(actorFor(viewer));
  const workerActor: Actor = { type: "worker", id: worker!.id, name: worker!.name };
  const workerCtx = () => ctxFor(workerActor);
  const systemCtx = () => ctxFor(systemActor);

  // Assets: generate tiny sample videos once and upload through the real path.
  const dir = path.resolve(process.cwd(), "storage-test/samples");
  await fs.mkdir(dir, { recursive: true });
  const assetIds: string[] = [];
  const specs = sampleSpecs(opts.assetCount ?? 3).map((s) => ({ ...s, seconds: 2, width: 320, height: 480 }));
  for (const spec of specs) {
    const file = path.join(dir, spec.name);
    const exists = await fs.stat(file).then(() => true).catch(() => false);
    if (!exists) await generateSample(spec, dir);
    const buf = await fs.readFile(file);
    const c = await operatorCtx();
    const { uploadId, chunkBytes } = await startUpload(c, { filename: spec.name, mime: "video/mp4", sizeBytes: buf.length });
    for (let off = 0; off < buf.length; off += chunkBytes) await appendUploadChunk(c, uploadId, off, buf.subarray(off, off + chunkBytes));
    const { asset } = await completeUpload(c, uploadId, { creatorId: creator!.id, caption: `Caption for ${spec.name}` });
    if (asset.status !== "ready") throw new Error(`test asset invalid: ${asset.validationError}`);
    assetIds.push(asset.id);
  }

  const adapterTags: Record<string, string[]> = Object.fromEntries(accountRows.map((a) => [a.id, a.tags]));
  const adapter = new SimulatorAdapter({ stepDelayMs: 0, now: () => clock.now(), tagsFor: (id) => adapterTags[id] ?? [] });
  let current: Ctx | null = null;
  const api = localWorkerApi(() => current!);

  /** Runs one worker pass: heartbeat, tick, claim and execute everything claimable. */
  async function runWorker(rounds = 3) {
    const sys = await systemCtx();
    await heartbeat(sys, worker!.id, {});
    await tickOrg(sys, { deliver: false });
    const wctx = await workerCtx();
    current = wctx;
    let executed = 0;
    for (let r = 0; r < rounds; r++) {
      const { jobs } = await claimJobs(wctx, { workerId: worker!.id, max: 2 });
      for (const j of jobs) { clock.advance(60_000); await executeClaimedJob(adapter, j, api); executed++; }
      await promoteDueAnalytics(wctx);
      const { jobs: aj } = await claimAnalytics(wctx, { workerId: worker!.id, max: 2 });
      for (const a of aj) { clock.advance(30_000); await executeAnalyticsJob(adapter, a, api); executed++; }
      if (jobs.length === 0 && aj.length === 0) break;
    }
    return executed;
  }

  async function countJobs(where = "true") {
    const rows = await db.execute(sql`select state, count(*)::int as n from posting_jobs where org_id = ${orgId} and ${sql.raw(where)} group by state`);
    return Object.fromEntries((rows as unknown as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
  }

  /** Cancels every open job on the given accounts and clears locks/pauses so a test starts from a clean account. */
  async function resetAccounts(idx: number[]) {
    for (const i of idx) {
      const id = accountRows[i]!.id;
      await db.execute(sql`update posting_jobs set state = 'CANCELLED', lease_expires_at = null where account_id = ${id} and state not in ('VERIFIED_PUBLISHED','CANCELLED')`);
      await db.update(accounts).set({ lockJobId: null, lockWorkerId: null, lockExpiresAt: null, state: "ready", stateReason: "test reset", pausedAt: null, pausedReason: null, sessionControl: "worker", sessionReadiness: "ready" }).where(eq(accounts.id, id));
    }
  }
  return { db, orgId, clock, resetAccounts, owner, operator, viewer, creator: creator!, creatorB: creatorB!, worker: worker!, workerToken: tok.token, accounts: accountRows, assetIds, ownerCtx, operatorCtx, viewerCtx, workerCtx, systemCtx, ctxFor, adapter, adapterTags, api, runWorker, countJobs, setTags: (accountId: string, tags: string[]) => { adapterTags[accountId] = tags; return db.update(accounts).set({ tags }).where(eq(accounts.id, accountId)); }, assetsTable };
}

export const nextDay = (iso: string, n = 1) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
