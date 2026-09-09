import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createHarness, type Harness } from "../test/harness";
import { listAccounts, updateAccount } from "./accounts";
import { listAssets, updateAsset, completeUpload, startUpload, appendUploadChunk, deleteAsset } from "./content";
import { listCampaigns, createCampaign, DEMO_TEMPLATE } from "./campaigns";
import { listActivity, exportActivityCsv } from "./audit";
import { createWorker, authenticateWorker } from "./workers";
import { createDiscordChannel, emitNotification, listChannels, processDeliveries, testChannel, updateChannel, type DeliveryTransport } from "./notifications";
import { redact } from "../lib/redact";
import { closeDb, getDb } from "../db";
import fs from "node:fs/promises";
import { resolveKey } from "./media";
import { users, assets } from "../db/schema";

let a: Harness;
let b: Harness;
beforeAll(async () => {
  a = await createHarness({ slug: "org-a", accountCount: 3, assetCount: 2 });
  b = await createHarness({ slug: "org-b", accountCount: 1, assetCount: 1 });
});
afterAll(async () => {
  await closeDb();
});

describe("organization and role isolation", () => {
  it("never returns another organization's accounts, assets, campaigns or activity", async () => {
    const ctxB = await b.ownerCtx();
    const accs = await listAccounts(ctxB);
    expect(accs.every((x) => x.orgId === b.orgId)).toBe(true);
    expect(accs.find((x) => x.id === a.accounts[0]!.id)).toBeUndefined();
    const { rows } = await listAssets(ctxB);
    expect(rows.find((x) => x.id === a.assetIds[0])).toBeUndefined();
    await expect(updateAsset(ctxB, a.assetIds[0]!, { caption: "hijack" })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateAccount(ctxB, a.accounts[0]!.id, { displayName: "hijack" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createCampaign(ctxB, { name: "x", startDate: "2026-03-07", endDate: "2026-03-07", template: DEMO_TEMPLATE, accountIds: [a.accounts[0]!.id], assetIds: [] })).rejects.toMatchObject({ code: "validation" });
    const camps = await listCampaigns(ctxB);
    expect(camps.every((c) => c.orgId === b.orgId)).toBe(true);
    const act = await listActivity(ctxB);
    expect(act.rows.every((r) => r.orgId === b.orgId)).toBe(true);
  });

  it("limits creator-scoped operators to their creators", async () => {
    const [scoped] = await a.db.insert(users).values({ orgId: a.orgId, email: `scoped-${a.orgId}@test.local`, name: "Scoped", passwordHash: "x", role: "operator", creatorScope: [a.creatorB.id] }).returning();
    const ctx = await a.ctxFor({ type: "user", id: scoped!.id, name: "Scoped", role: "operator", creatorScope: [a.creatorB.id] });
    const accs = await listAccounts(ctx);
    expect(accs.every((x) => x.creatorId === a.creatorB.id)).toBe(true);
    await expect(updateAccount(ctx, a.accounts[0]!.id, { displayName: "nope" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateAsset(ctx, a.assetIds[0]!, { caption: "nope" })).rejects.toMatchObject({ code: "forbidden" });
    const { rows } = await listAssets(ctx);
    expect(rows.every((r) => r.creatorId === null || r.creatorId === a.creatorB.id)).toBe(true);
  });

  it("viewers are read-only and only owners manage workers", async () => {
    const v = await a.viewerCtx();
    await expect(updateAsset(v, a.assetIds[0]!, { caption: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteAsset(v, a.assetIds[0]!)).rejects.toMatchObject({ code: "forbidden" });
    await expect(exportActivityCsv(v, {})).rejects.toMatchObject({ code: "forbidden" });
    const op = await a.operatorCtx();
    await expect(createWorker(op, { name: "w", kind: "simulator" })).rejects.toMatchObject({ code: "forbidden" });
    const { token, worker } = await createWorker(await a.ownerCtx(), { name: "w", kind: "hermes_mac" });
    expect(token).toMatch(/^wk_[0-9a-f]{12}\./);
    const auth = await authenticateWorker(getDb(), `Bearer ${token}`);
    expect(auth?.id).toBe(worker.id);
    expect(await authenticateWorker(getDb(), `Bearer ${token.slice(0, -2)}xx`)).toBeNull();
    expect(await authenticateWorker(getDb(), "Bearer nonsense")).toBeNull();
  });
});

describe("content", () => {
  it("detects exact duplicates by hash, rejects undecodable files and enforces size/type limits", async () => {
    const op = await a.operatorCtx();
    const first = await a.db.query.assets.findFirst({ where: eq(assets.id, a.assetIds[0]!) });
    const buf = await fs.readFile(resolveKey(first!.storageKey));
    const up = await startUpload(op, { filename: "renamed-copy.mp4", mime: "video/mp4", sizeBytes: buf.length });
    await appendUploadChunk(op, up.uploadId, 0, buf);
    const r = await completeUpload(op, up.uploadId, {});
    expect(r.duplicateOf?.id).toBe(first!.id);
    expect(r.asset.sha256).toBe(first!.sha256);
    // Same filename, different bytes is NOT a duplicate.
    const other = await a.db.query.assets.findFirst({ where: eq(assets.id, a.assetIds[1]!) });
    const buf2 = await fs.readFile(resolveKey(other!.storageKey));
    const up2 = await startUpload(op, { filename: first!.originalFilename, mime: "video/mp4", sizeBytes: buf2.length });
    await appendUploadChunk(op, up2.uploadId, 0, buf2);
    const r2 = await completeUpload(op, up2.uploadId, {});
    expect(r2.duplicateOf?.id).toBe(other!.id);
    // Undecodable bytes with a video extension → invalid, not crash.
    const junk = Buffer.from("definitely not a video ".repeat(100));
    const up3 = await startUpload(op, { filename: "junk.mp4", mime: "video/mp4", sizeBytes: junk.length });
    await appendUploadChunk(op, up3.uploadId, 0, junk);
    const r3 = await completeUpload(op, up3.uploadId, {});
    expect(r3.asset.status).toBe("invalid");
    expect(r3.asset.validationError).toMatch(/video/i);
    await expect(startUpload(op, { filename: "x.exe", mime: "application/x-msdownload", sizeBytes: 10 })).rejects.toMatchObject({ code: "validation" });
    await expect(startUpload(op, { filename: "x.mp4", mime: "video/mp4", sizeBytes: 10 * 1024 * 1024 * 1024 })).rejects.toMatchObject({ code: "validation" });
    // Resumable: wrong offset reports the expected one.
    const up4 = await startUpload(op, { filename: "resume.mp4", mime: "video/mp4", sizeBytes: 10 });
    await appendUploadChunk(op, up4.uploadId, 0, Buffer.alloc(4));
    await expect(appendUploadChunk(op, up4.uploadId, 0, Buffer.alloc(4))).rejects.toMatchObject({ code: "conflict", details: { expectedOffset: 4 } });
  });
});

describe("notifications", () => {
  it("deduplicates by event id, keeps delivery separate from publishing, records delivery failures, and never exposes the webhook", async () => {
    const owner = await a.ownerCtx();
    const ch = await createDiscordChannel(owner, { name: "ops", webhookUrl: "https://discord.com/api/webhooks/123456789/secret-token-value" });
    expect(JSON.stringify(ch)).not.toContain("secret-token-value");
    expect(ch.destinationLabel).toMatch(/discord\.com\/api\/webhooks\/1234…89\//);
    await expect(createDiscordChannel(owner, { name: "bad", webhookUrl: "https://evil.example/hook" })).rejects.toMatchObject({ code: "validation" });
    await expect(updateChannel(owner, ch.id, { enabled: true })).rejects.toMatchObject({ code: "validation" }); // not tested yet
    const sent: string[] = [];
    let fail = false;
    const transport: DeliveryTransport = { async sendDiscord(url, payload) { sent.push(`${url}|${payload.content}`); return fail ? { ok: false, error: "boom", retryable: true } : { ok: true }; } };
    const t = await testChannel(owner, ch.id, transport);
    expect(t.ok).toBe(true);
    expect(sent[0]).toContain("Test message");
    await updateChannel(owner, ch.id, { enabled: true });
    const e1 = await emitNotification(owner, { eventId: "evt:1", kind: "login_required", severity: "critical", title: "T", body: "B" });
    const e2 = await emitNotification(owner, { eventId: "evt:1", kind: "login_required", severity: "critical", title: "T", body: "B" });
    expect(e1.created).toBe(true);
    expect(e2.created).toBe(false);
    expect(e2.notification.id).toBe(e1.notification.id);
    fail = true;
    let r = await processDeliveries(owner, transport);
    expect(r.failed).toBe(1);
    const d = await a.db.query.notificationDeliveries.findMany({ where: (x, { eq }) => eq(x.notificationId, e1.notification.id) });
    expect(d[0]!.state).toBe("queued");
    expect(d[0]!.attempts).toBe(1);
    expect(d[0]!.lastError).toBe("boom");
    fail = false;
    a.clock.advance(60_000);
    r = await processDeliveries(owner, transport);
    expect(r.sent).toBe(1);
    // Success notifications are not delivered unless enabled per channel.
    await emitNotification(owner, { eventId: "evt:2", kind: "post_verified", severity: "info", title: "T", body: "B" });
    const d2 = await a.db.query.notificationDeliveries.findMany({ where: (x, { eq }) => eq(x.channelId, ch.id) });
    expect(d2).toHaveLength(1);
    const chans = await listChannels(await a.operatorCtx());
    expect(JSON.stringify(chans)).not.toContain("secret-token-value");
  });

  it("redacts secrets from audit metadata", () => {
    const out = redact({ password: "p", nested: { token: "wk_abcdefabcdef.xyz", note: "Bearer abc.def" }, url: "https://discord.com/api/webhooks/1/abc" });
    expect(JSON.stringify(out)).not.toMatch(/abcdefabcdef|Bearer abc|webhooks\/1\/abc/);
  });
});
