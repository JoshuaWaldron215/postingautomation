/**
 * Demo seed: one organization, four users, three workers, eight creators, 100 synthetic accounts,
 * generated sample media, and several days of simulated history produced by running the real
 * services with a controlled clock. Everything is labeled demo data in the dashboard.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../lib/env";
loadDotEnv();
import { and, eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../db/index";
import { accounts, assets, creators, notificationChannels, organizations, postingJobs, uploads, users, workers } from "../db/schema";
import { SimulatorAdapter } from "../adapters/simulator";
import { FixedClock, hours, minutes } from "../lib/clock";
import { encryptSecret, hashPassword, issueWorkerToken, parseWorkerToken, sha256Hex } from "../lib/crypto";
import { claimAnalytics, promoteDueAnalytics } from "../services/analytics";
import { pauseCreator, updateAccount, pauseAccounts } from "../services/accounts";
import { approveCampaign, createCampaign, DEMO_TEMPLATE } from "../services/campaigns";
import { appendUploadChunk, completeUpload, createFamily, startUpload, updateAsset } from "../services/content";
import { makeCtx, systemActor, type Actor, type Ctx } from "../services/context";
import { claimJobs } from "../services/jobs";
import { DEFAULT_ORG_SETTINGS } from "../services/org";
import { tickOrg } from "../services/scheduler";
import { heartbeat } from "../services/workers";
import { runMigrations } from "../db/migrate";
import { localWorkerApi } from "../simulation/local-worker-api";
import { executeAnalyticsJob, executeClaimedJob } from "../worker-runtime";
import { generateAllSamples, SAMPLES_DIR } from "./generate-samples";
import { DEFAULT_CHANNEL_SETTINGS } from "../services/notifications";

const DISPLAY_TZ = "America/New_York";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CREATORS = [
  { name: "Maya Chen", color: "#c2410c" },
  { name: "Nadia Reyes", color: "#7c3aed" },
  { name: "Theo Park", color: "#0f766e" },
  { name: "Lena Okafor", color: "#be185d" },
  { name: "Sam Rivera", color: "#1d4ed8" },
  { name: "Priya Nair", color: "#b45309" },
  { name: "Dev Malhotra", color: "#4d7c0f" },
  { name: "Jules Fontaine", color: "#6d28d9" },
];
const SUFFIXES = ["", ".daily", ".clips", ".fit", ".official", ".reels", ".life", ".studio", ".tv", ".now", ".hq", ".moments", ".vibes"];
const TIMEZONES = ["America/New_York", "America/New_York", "America/Los_Angeles", "America/Chicago", "Europe/London", "Asia/Dubai", "Australia/Sydney"];
const AVATARS = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16", "#06b6d4"];

const CAPTIONS = [
  "Three moves I do every morning before coffee ☀️ Save this for tomorrow.",
  "The mistake I see in almost every gym… and the 10-second fix.",
  "Meal prep in 9 minutes. No, really. Full list in comments.",
  "POV: you finally stopped skipping mobility day.",
  "What a rest day actually looks like when you train 5x a week.",
  "Form check: hip hinge vs. squat. Which one are you doing?",
  "Budget-friendly breakfast that keeps me full until 1pm.",
  "The 5-minute reset I use between meetings.",
  "Stop stretching cold. Do this instead.",
  "One week of lunches, one shopping trip.",
  "My honest take on late-night snacks.",
  "Beginner routine you can do in a hallway.",
  "",
  "Why I stopped counting steps (and what I track now).",
  "",
  "Quick desk stretch for tight shoulders.",
];

async function upsertOrg(db: Db) {
  const existing = await db.query.organizations.findFirst({ where: eq(organizations.slug, "map-agency") });
  if (existing) return existing;
  const [org] = await db.insert(organizations).values({ name: "MAP Agency", slug: "map-agency", settings: { ...DEFAULT_ORG_SETTINGS, demoMode: true } }).returning();
  return org!;
}

async function uploadFile(ctx: Ctx, file: string, creatorId: string | null, caption: string, tags: string[]) {
  const buf = await fs.readFile(file);
  const { uploadId, chunkBytes } = await startUpload(ctx, { filename: path.basename(file), mime: "video/mp4", sizeBytes: buf.length });
  for (let off = 0; off < buf.length; off += chunkBytes) await appendUploadChunk(ctx, uploadId, off, buf.subarray(off, Math.min(buf.length, off + chunkBytes)));
  return completeUpload(ctx, uploadId, { creatorId, caption, tags });
}

export async function seed(db: Db, opts: { log?: (m: string) => void; workerToken?: string; historyDays?: number } = {}): Promise<{ orgId: string; workerToken: string; userLogins: Array<{ email: string; password: string; role: string }> }> {
  const log = opts.log ?? console.log;
  const rand = prng(20260909);
  const realNow = new Date();
  const org = await upsertOrg(db);
  const already = await db.select({ n: sql<number>`count(*)::int` }).from(accounts).where(eq(accounts.orgId, org.id));
  if ((already[0]?.n ?? 0) > 0) throw new Error("Database already seeded. Run `pnpm db:reset` first.");
  log("Note: stop the scheduler and worker processes before seeding; they would interfere with the simulated history.");

  // ---- users ----
  const userLogins = [
    { email: "shafiq@map.agency", password: "demo-owner-2026", role: "owner", name: "Shafiq" },
    { email: "josh@synthos.dev", password: "demo-operator-2026", role: "operator", name: "Josh" },
    { email: "riley@map.agency", password: "demo-viewer-2026", role: "viewer", name: "Riley" },
    { email: "ana@map.agency", password: "demo-scoped-2026", role: "operator", name: "Ana (Maya only)" },
  ] as const;
  const userRows: Record<string, typeof users.$inferSelect> = {};
  for (const u of userLogins) {
    const [row] = await db.insert(users).values({ orgId: org.id, email: u.email, name: u.name, passwordHash: hashPassword(u.password), role: u.role }).returning();
    userRows[u.email] = row!;
  }
  const owner = userRows["shafiq@map.agency"]!;
  const ownerActor: Actor = { type: "user", id: owner.id, name: owner.name, role: "owner", creatorScope: null };
  const clock = new FixedClock(realNow);
  const ctxOf = async (actor: Actor) => {
    const c = await makeCtx({ db, orgId: org.id, actor });
    c.clock = clock;
    return c;
  };
  let ctx = await ctxOf(ownerActor);

  // ---- workers ----
  const tokenParsed = opts.workerToken ? parseWorkerToken(opts.workerToken) : null;
  const issued = tokenParsed ? { token: opts.workerToken!, prefix: tokenParsed.prefix, hash: tokenParsed.secretHash } : issueWorkerToken();
  const [simWorker] = await db.insert(workers).values({ orgId: org.id, name: "local-simulator", kind: "simulator", tokenPrefix: issued.prefix, tokenHash: issued.hash, maxConcurrency: 2, status: "online", lastHeartbeatAt: realNow, createdByUserId: owner.id }).returning();
  const b = issueWorkerToken();
  const [simWorkerB] = await db.insert(workers).values({ orgId: org.id, name: "sim-worker-b", kind: "simulator", tokenPrefix: b.prefix, tokenHash: b.hash, maxConcurrency: 1, status: "online", lastHeartbeatAt: realNow, createdByUserId: owner.id }).returning();
  const h = issueWorkerToken();
  const [macWorker] = await db.insert(workers).values({ orgId: org.id, name: "mac-mini-hermes", kind: "hermes_mac", tokenPrefix: h.prefix, tokenHash: h.hash, maxConcurrency: 1, status: "never_connected", createdByUserId: owner.id, hostInfo: {} }).returning();
  const offlineAt = new Date(realNow.getTime() - hours(2));

  // ---- creators & accounts ----
  const creatorRows: Array<typeof creators.$inferSelect> = [];
  for (const c of CREATORS) {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const [row] = await db.insert(creators).values({ orgId: org.id, name: c.name, slug, color: c.color }).returning();
    creatorRows.push(row!);
  }
  const accountRows: Array<typeof accounts.$inferSelect> = [];
  const scenarioTags: Record<string, string[]> = {};
  let i = 0;
  const perCreator = [13, 12, 13, 12, 13, 12, 13, 12];
  for (let c = 0; c < creatorRows.length; c++) {
    const creator = creatorRows[c]!;
    const first = creator.name.split(" ")[0]!.toLowerCase();
    const last = creator.name.split(" ")[1]!.toLowerCase();
    for (let k = 0; k < perCreator[c]!; k++) {
      const suffix = SUFFIXES[k % SUFFIXES.length]!;
      const handle = k === 0 ? `${first}.${last}` : `${first}${suffix}`;
      const displayName = k === 0 ? creator.name : `${creator.name.split(" ")[0]} ${suffix.replace(".", "").replace(/^\w/, (m) => m.toUpperCase()) || "Main"}`;
      // Worker distribution: 70 local-simulator, 10 sim-worker-b, 8 mac-mini-hermes, 12 unassigned.
      let workerId: string | null = simWorker!.id;
      let route: typeof accounts.$inferSelect.executionRoute = "simulator";
      if (i % 10 === 9) workerId = simWorkerB!.id;
      if (c === 2 && k >= 5) {
        workerId = macWorker!.id;
        route = "browser_hermes";
      }
      if (i % 8 === 7 && !(c === 2 && k >= 5)) workerId = null;
      const tags: string[] = [];
      if ([3, 17, 44, 61, 88].includes(i)) tags.push("sim:needs_login");
      if (i === 21) tags.push("sim:mismatch");
      if ([6, 50].includes(i)) tags.push("sim:unknown_outcome");
      if ([9, 33].includes(i)) tags.push("sim:fail_network");
      if ([2, 30, 66].includes(i)) tags.push("sim:no_metrics");
      if ([1, 27].includes(i)) tags.push("sim:viral");
      if (i === 5) tags.push("sim:analytics_fail");
      if (i === 8) tags.push("sim:post_missing");
      if (i === 12) tags.push("sim:slow");
      const tz = TIMEZONES[(i * 7 + c) % TIMEZONES.length]!;
      const [row] = await db
        .insert(accounts)
        .values({
          orgId: org.id,
          creatorId: creator.id,
          handle,
          displayName,
          avatarColor: AVATARS[i % AVATARS.length]!,
          executionRoute: route,
          workerId,
          browserProfileKey: `profile-${handle}`,
          timezone: tz,
          postingPolicy: { ongoingTimes: ["11:00", "18:00"], dayOne: { count: 3, spacingMinutes: 5 } },
          state: workerId ? "ready" : "unassigned",
          stateReason: workerId ? "Added" : "No worker assigned yet",
          sessionReadiness: workerId && workerId !== macWorker!.id ? "ready" : "unknown",
          sessionCheckedAt: workerId && workerId !== macWorker!.id ? new Date(realNow.getTime() - hours(30)) : null,
          verifiedIgUserId: workerId && workerId !== macWorker!.id && !tags.includes("sim:mismatch") ? `sim-${sha256Hex(handle).slice(0, 10)}` : null,
          tags,
        })
        .returning();
      accountRows.push(row!);
      scenarioTags[row!.id] = tags;
      i++;
    }
  }
  log(`Created ${accountRows.length} accounts across ${creatorRows.length} creators.`);
  await db.update(users).set({ creatorScope: [creatorRows[0]!.id] }).where(eq(users.email, "ana@map.agency"));
  await db.update(users).set({ preferences: { pinnedAccountIds: [accountRows[0]!.id, accountRows[13]!.id, accountRows[25]!.id] } }).where(eq(users.id, owner.id));

  // ---- media ----
  const files = await generateAllSamples(SAMPLES_DIR);
  const creatorForSample = (n: number) => (n < 8 ? 0 : n < 14 ? 1 : n < 20 ? 2 : n < 25 ? 3 : n < 29 ? 4 : n < 32 ? 5 : n < 34 ? 6 : 7);
  const assetIds: string[] = [];
  const historyStart = new Date(realNow.getTime() - hours(24 * (opts.historyDays ?? 4)) - hours(6));
  clock.set(historyStart);
  for (let n = 0; n < files.length; n++) {
    clock.set(new Date(historyStart.getTime() + n * minutes(3)));
    const { asset } = await uploadFile(ctx, files[n]!, creatorRows[creatorForSample(n)]!.id, CAPTIONS[n % CAPTIONS.length]!, n % 5 === 0 ? ["hook", "morning"] : n % 3 === 0 ? ["tutorial"] : []);
    assetIds.push(asset.id);
  }
  // Exact duplicate (same bytes, different filename) and invalid files.
  const dupTmp = path.join(SAMPLES_DIR, "sample-07 (1).mp4");
  await fs.copyFile(files[6]!, dupTmp);
  await uploadFile(ctx, dupTmp, creatorRows[0]!.id, CAPTIONS[6]!, []);
  await uploadFile(ctx, path.join(SAMPLES_DIR, "not-a-video.mp4"), creatorRows[3]!.id, "", []);
  await uploadFile(ctx, path.join(SAMPLES_DIR, "truncated-upload.mp4"), creatorRows[4]!.id, "", []);
  // An abandoned, resumable upload.
  const abandoned = await startUpload(ctx, { filename: "b-roll-kitchen-v3.mp4", mime: "video/mp4", sizeBytes: 48_000_000 });
  await appendUploadChunk(ctx, abandoned.uploadId, 0, Buffer.alloc(4 * 1024 * 1024));
  await db.update(uploads).set({ updatedAt: new Date(realNow.getTime() - hours(3)) }).where(eq(uploads.id, abandoned.uploadId));
  // Families with explicit variants.
  const famMorning = await createFamily(ctx, { name: "Morning routine", creatorId: creatorRows[0]!.id, description: "Three cuts of the same routine" });
  const famGym = await createFamily(ctx, { name: "Gym mistakes", creatorId: creatorRows[0]!.id });
  const famMeal = await createFamily(ctx, { name: "Meal prep", creatorId: creatorRows[2]!.id });
  for (const [idx, label] of [[0, "A · wide"], [1, "B · close"], [2, "C · captions"]] as const) await updateAsset(ctx, assetIds[idx]!, { familyId: famMorning.id, variantLabel: label });
  for (const [idx, label] of [[3, "v1"], [4, "v2"]] as const) await updateAsset(ctx, assetIds[idx]!, { familyId: famGym.id, variantLabel: label });
  for (const [idx, label] of [[14, "9 min"], [15, "12 min"], [16, "vertical"]] as const) await updateAsset(ctx, assetIds[idx]!, { familyId: famMeal.id, variantLabel: label });
  log(`Uploaded ${assetIds.length + 3} sample files (incl. 1 duplicate, 2 invalid).`);

  // ---- notification channel (configured, not yet verified) ----
  await db.insert(notificationChannels).values({ orgId: org.id, kind: "discord_webhook", name: "Ops alerts", secretEncrypted: encryptSecret("https://discord.com/api/webhooks/000000000000000000/demo-placeholder-not-real"), destinationLabel: "discord.com/api/webhooks/0000…00/••••••", enabled: false, settings: DEFAULT_CHANNEL_SETTINGS, createdByUserId: owner.id });

  // ---- campaigns ----
  const dateIso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const daysAgo = (n: number) => dateIso(new Date(realNow.getTime() - n * 86_400_000));
  const daysAhead = (n: number) => dateIso(new Date(realNow.getTime() + n * 86_400_000));
  const accountsOf = (c: number) => accountRows.filter((a) => a.creatorId === creatorRows[c]!.id);
  const withWorker = (list: typeof accountRows) => list.filter((a) => a.workerId);

  clock.set(new Date(realNow.getTime() - hours(24 * 4) - hours(2)));
  ctx = await ctxOf(ownerActor);
  const maya = await createCampaign(ctx, { name: "Maya · September launch", creatorId: creatorRows[0]!.id, startDate: daysAgo(4), endDate: daysAhead(2), template: DEMO_TEMPLATE, accountIds: withWorker(accountsOf(0)).map((a) => a.id), assetIds: assetIds.slice(0, 8) });
  await approveCampaign(ctx, maya.id);
  clock.set(new Date(realNow.getTime() - hours(24 * 2) - hours(3)));
  const theo = await createCampaign(ctx, { name: "Theo · meal prep week", creatorId: creatorRows[2]!.id, startDate: daysAgo(2), endDate: daysAhead(2), template: { ...DEMO_TEMPLATE, limits: { maxPostsPerAccount: 10, maxPostsTotal: null } }, accountIds: accountsOf(2).map((a) => a.id), assetIds: assetIds.slice(14, 20) });
  await approveCampaign(ctx, theo.id);
  clock.set(new Date(realNow.getTime() - hours(24 * 1) - hours(4)));
  const nadia = await createCampaign(ctx, { name: "Nadia · relaunch", creatorId: creatorRows[1]!.id, startDate: daysAgo(1), endDate: daysAhead(3), template: DEMO_TEMPLATE, accountIds: withWorker(accountsOf(1)).map((a) => a.id), assetIds: assetIds.slice(8, 14) });
  await approveCampaign(ctx, nadia.id);
  clock.set(new Date(realNow.getTime() - hours(20)));
  const sam = await createCampaign(ctx, { name: "Sam · trial run", creatorId: creatorRows[4]!.id, startDate: daysAhead(1), endDate: daysAhead(3), template: { ...DEMO_TEMPLATE, dayOne: { ...DEMO_TEMPLATE.dayOne, firstTime: "09:00" } }, accountIds: withWorker(accountsOf(4)).slice(0, 4).map((a) => a.id), assetIds: assetIds.slice(25, 29) });
  await approveCampaign(ctx, sam.id);
  await createCampaign(ctx, { name: "Lena · teaser drops", creatorId: creatorRows[3]!.id, startDate: daysAhead(1), endDate: daysAhead(3), template: { ...DEMO_TEMPLATE, dayOne: { ...DEMO_TEMPLATE.dayOne, enabled: false } }, accountIds: withWorker(accountsOf(3)).slice(0, 5).map((a) => a.id), assetIds: assetIds.slice(20, 25), assignment: "unique" });
  log("Created 5 campaigns (4 approved, 1 draft).");

  // ---- simulate history through the real services ----
  const adapter = new SimulatorAdapter({ stepDelayMs: 0, now: () => clock.now(), tagsFor: (id) => scenarioTags[id] ?? [] });
  const workerActors: Record<string, Actor> = { [simWorker!.id]: { type: "worker", id: simWorker!.id, name: simWorker!.name }, [simWorkerB!.id]: { type: "worker", id: simWorkerB!.id, name: simWorkerB!.name } };
  let current: Ctx = ctx;
  const api = localWorkerApi(() => current);
  const start = new Date(realNow.getTime() - hours(24 * 4) - hours(1));
  let processed = 0;
  let analyticsDone = 0;
  const pausedNadiaAt = new Date(realNow.getTime() - hours(5));
  let nadiaPaused = false;
  const samEditedAt = new Date(realNow.getTime() - hours(1));
  let samEdited = false;
  for (let t = start.getTime(); t <= realNow.getTime(); t += minutes(10)) {
    clock.set(new Date(t));
    const sysCtx = await ctxOf(systemActor);
    sysCtx.clock = clock;
    for (const w of [simWorker!, simWorkerB!]) {
      const isB = w.id === simWorkerB!.id;
      if (isB && t > offlineAt.getTime()) continue; // sim-worker-b stops sending heartbeats 2h ago
      await heartbeat(sysCtx, w.id, { version: "seed" });
    }
    await tickOrg(sysCtx, { deliver: false });
    if (!nadiaPaused && t >= pausedNadiaAt.getTime()) {
      const c = await ctxOf(ownerActor);
      await pauseCreator(c, creatorRows[1]!.id, "Client asked to hold this week's posts");
      nadiaPaused = true;
    }
    if (!samEdited && t >= samEditedAt.getTime()) {
      const c = await ctxOf({ type: "user", id: userRows["josh@synthos.dev"]!.id, name: "Josh", role: "operator", creatorScope: null });
      await updateAsset(c, assetIds[25]!, { caption: `${CAPTIONS[9]} (updated wording)` });
      samEdited = true;
    }
    for (const w of [simWorker!, simWorkerB!]) {
      if (w.id === simWorkerB!.id && t > offlineAt.getTime()) continue;
      const wctx = await ctxOf(workerActors[w.id]!);
      current = wctx;
      for (let round = 0; round < 6; round++) {
        const { jobs } = await claimJobs(wctx, { workerId: w.id, max: 2 });
        if (jobs.length === 0) break;
        for (const job of jobs) {
          clock.advance(minutes(1) + Math.floor(rand() * minutes(3)));
          await executeClaimedJob(adapter, job, api);
          processed++;
        }
      }
      await promoteDueAnalytics(wctx);
      const { jobs: aj } = await claimAnalytics(wctx, { workerId: w.id, max: 3 });
      for (const a of aj) {
        clock.advance(minutes(Math.floor(rand() * 4)));
        await executeAnalyticsJob(adapter, a, api);
        analyticsDone++;
      }
      clock.set(new Date(t));
    }
  }
  clock.set(realNow);
  // Worker B stopped 2h ago; make its last heartbeat reflect that so the dashboard shows it offline.
  await db.update(workers).set({ lastHeartbeatAt: offlineAt, status: "offline" }).where(eq(workers.id, simWorkerB!.id));
  await db.update(workers).set({ lastHeartbeatAt: realNow, status: "online" }).where(eq(workers.id, simWorker!.id));
  // One account paused directly by an operator.
  const opCtx = await ctxOf({ type: "user", id: userRows["josh@synthos.dev"]!.id, name: "Josh", role: "operator", creatorScope: null });
  opCtx.clock = clock;
  await pauseAccounts(opCtx, [accountRows[16]!.id], "Creator is travelling; resume Monday");
  await updateAccount(opCtx, accountRows[40]!.id, { tags: ["sim:no_metrics"] });
  const sysCtx = await ctxOf(systemActor);
  sysCtx.clock = clock;
  await tickOrg(sysCtx, { deliver: false });
  const counts = await db.select({ state: postingJobs.state, n: sql<number>`count(*)::int` }).from(postingJobs).where(eq(postingJobs.orgId, org.id)).groupBy(postingJobs.state);
  log(`Simulated ${processed} post attempts and ${analyticsDone} analytics checks. Job states: ${counts.map((c) => `${c.state}=${c.n}`).join(", ")}`);
  const invalid = await db.select({ n: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.orgId, org.id), eq(assets.status, "invalid")));
  log(`Invalid assets: ${invalid[0]?.n}`);
  return { orgId: org.id, workerToken: issued.token, userLogins: userLogins.map((u) => ({ email: u.email, password: u.password, role: u.role })) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, client } = createDb(url, 4);
  (async () => {
    await runMigrations(url);
    const result = await seed(db, { workerToken: process.env.WORKER_TOKEN || undefined });
    console.log("\nDemo logins:");
    for (const u of result.userLogins) console.log(`  ${u.role.padEnd(8)} ${u.email}  /  ${u.password}`);
    console.log(`\nSimulator worker token (WORKER_TOKEN): ${result.workerToken}`);
    const envPath = path.resolve(process.cwd(), "../../.env");
    try {
      let env = await fs.readFile(envPath, "utf8");
      if (/^WORKER_TOKEN=.*$/m.test(env)) env = env.replace(/^WORKER_TOKEN=.*$/m, `WORKER_TOKEN=${result.workerToken}`);
      else env += `\nWORKER_TOKEN=${result.workerToken}\n`;
      await fs.writeFile(envPath, env);
      console.log(`Wrote WORKER_TOKEN to ${envPath}`);
    } catch {
      console.log("(.env not found at repo root; copy the token into your worker environment manually)");
    }
    await client.end();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
