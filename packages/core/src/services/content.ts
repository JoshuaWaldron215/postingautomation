import { type SQL, and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { accounts, assets, contentFamilies, postingJobs, uploads, verifiedPosts, type Asset, type ContentFamily } from "../db/schema";
import { maxUploadBytes } from "../lib/env";
import { AppError, conflict, notFound, validation } from "../lib/errors";
import { shortId } from "../lib/ids";
import { recordAudit } from "./audit";
import { uuidArray } from "../lib/sqlutil";
import { invalidateApprovalsForAsset } from "./campaigns";
import { assertCreatorAccess, creatorScopeOf, requireRole, type Ctx } from "./context";
import { ACCEPTED_CONTAINERS, ACCEPTED_VIDEO_MIME, appendFileKey, deleteKey, generateThumbnail, moveKey, probeVideo, sha256OfKey, statKey } from "./media";

// ---------- resumable uploads ----------
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export async function startUpload(ctx: Ctx, input: { filename: string; mime: string; sizeBytes: number }) {
  requireRole(ctx, "operator", "upload content");
  if (!input.filename.trim()) throw validation("A filename is required.");
  if (input.sizeBytes <= 0) throw validation("The file is empty.");
  if (input.sizeBytes > maxUploadBytes()) throw validation(`Files must be under ${Math.round(maxUploadBytes() / 1024 / 1024)} MB.`);
  if (!ACCEPTED_VIDEO_MIME.has(input.mime)) throw validation("Only video files (MP4, MOV, WebM) can be uploaded.");
  const tmpKey = `uploads/${ctx.orgId}/${shortId()}.part`;
  const [row] = await ctx.db
    .insert(uploads)
    .values({ orgId: ctx.orgId, userId: ctx.actor.type === "user" ? ctx.actor.id : ctx.orgId, filename: input.filename, declaredMime: input.mime, sizeBytes: input.sizeBytes, tmpKey })
    .returning();
  return { uploadId: row!.id, chunkBytes: UPLOAD_CHUNK_BYTES, receivedBytes: 0 };
}

export async function uploadStatus(ctx: Ctx, uploadId: string) {
  const row = await ctx.db.query.uploads.findFirst({ where: and(eq(uploads.id, uploadId), eq(uploads.orgId, ctx.orgId)) });
  if (!row) throw notFound("Upload");
  const st = await statKey(row.tmpKey);
  const receivedBytes = st?.size ?? 0;
  if (receivedBytes !== row.receivedBytes) await ctx.db.update(uploads).set({ receivedBytes }).where(eq(uploads.id, uploadId));
  return { uploadId, status: row.status, receivedBytes, sizeBytes: row.sizeBytes, chunkBytes: UPLOAD_CHUNK_BYTES, assetId: row.assetId };
}

/** Appends a chunk at `offset`. Chunks must arrive in order; a mismatched offset returns the expected one for resumption. */
export async function appendUploadChunk(ctx: Ctx, uploadId: string, offset: number, chunk: Buffer) {
  requireRole(ctx, "operator", "upload content");
  const row = await ctx.db.query.uploads.findFirst({ where: and(eq(uploads.id, uploadId), eq(uploads.orgId, ctx.orgId)) });
  if (!row) throw notFound("Upload");
  if (row.status !== "open") throw conflict("This upload is already finished.");
  const st = await statKey(row.tmpKey);
  const current = st?.size ?? 0;
  if (offset !== current) throw new AppError("conflict", "Chunk offset mismatch; resume from the expected offset.", { expectedOffset: current });
  if (current + chunk.length > row.sizeBytes) throw validation("Upload exceeds the declared file size.");
  const received = await appendFileKey(row.tmpKey, chunk);
  await ctx.db.update(uploads).set({ receivedBytes: received, updatedAt: new Date() }).where(eq(uploads.id, uploadId));
  return { receivedBytes: received, complete: received === row.sizeBytes };
}

/** Finalizes the upload: hashes, probes, thumbnails, and creates the asset (or reports an exact duplicate). */
export async function completeUpload(ctx: Ctx, uploadId: string, input: { creatorId?: string | null; caption?: string; tags?: string[] }): Promise<{ asset: Asset; duplicateOf: Asset | null }> {
  requireRole(ctx, "operator", "upload content");
  const row = await ctx.db.query.uploads.findFirst({ where: and(eq(uploads.id, uploadId), eq(uploads.orgId, ctx.orgId)) });
  if (!row) throw notFound("Upload");
  if (row.status === "complete" && row.assetId) {
    const existing = await ctx.db.query.assets.findFirst({ where: eq(assets.id, row.assetId) });
    return { asset: existing!, duplicateOf: null };
  }
  const st = await statKey(row.tmpKey);
  if (!st || st.size !== row.sizeBytes) throw validation(`Upload is incomplete (${st?.size ?? 0} of ${row.sizeBytes} bytes received).`);
  if (input.creatorId) assertCreatorAccess(ctx, input.creatorId);

  const sha256 = await sha256OfKey(row.tmpKey);
  const duplicateOf = await ctx.db.query.assets.findFirst({ where: and(eq(assets.orgId, ctx.orgId), eq(assets.sha256, sha256), isNull(assets.deletedAt)) });
  const storageKey = `assets/${ctx.orgId}/${shortId()}.bin`;
  await moveKey(row.tmpKey, storageKey);

  const maxOrder = await ctx.db.select({ m: sql<number>`coalesce(max(${assets.sourceOrder}), 0)::int` }).from(assets).where(eq(assets.orgId, ctx.orgId));
  const [asset] = await ctx.db
    .insert(assets)
    .values({
      orgId: ctx.orgId,
      creatorId: input.creatorId ?? null,
      uploadedByUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      originalFilename: row.filename,
      storageKey,
      sha256,
      sizeBytes: row.sizeBytes,
      mime: row.declaredMime,
      status: "processing",
      caption: input.caption ?? "",
      tags: input.tags ?? [],
      sourceOrder: (maxOrder[0]?.m ?? 0) + 1,
    })
    .returning();
  await ctx.db.update(uploads).set({ status: "complete", assetId: asset!.id }).where(eq(uploads.id, uploadId));
  const processed = await processAsset(ctx, asset!.id);
  await recordAudit(ctx, {
    eventType: "asset.uploaded",
    message: duplicateOf ? `Uploaded “${row.filename}” — exact duplicate of “${duplicateOf.originalFilename}” (same SHA-256).` : `Uploaded “${row.filename}” (${(row.sizeBytes / 1024 / 1024).toFixed(1)} MB).`,
    creatorId: input.creatorId ?? null,
    metadata: { assetId: asset!.id, sha256, duplicateOfAssetId: duplicateOf?.id ?? null },
  });
  return { asset: processed, duplicateOf: duplicateOf ?? null };
}

/** Server-side validation: probe decodability, extract metadata, generate a thumbnail. Never trusts the extension. */
export async function processAsset(ctx: Ctx, assetId: string): Promise<Asset> {
  const asset = await ctx.db.query.assets.findFirst({ where: and(eq(assets.id, assetId), eq(assets.orgId, ctx.orgId)) });
  if (!asset) throw notFound("Asset");
  const probe = await probeVideo(asset.storageKey);
  if (!probe.ok) {
    const [row] = await ctx.db.update(assets).set({ status: "invalid", validationError: probe.error, updatedAt: ctx.clock.now() }).where(eq(assets.id, assetId)).returning();
    return row!;
  }
  let validationError: string | null = null;
  if (!ACCEPTED_CONTAINERS.test(probe.container)) validationError = `Container “${probe.container}” is not supported for Reels. Use MP4 or MOV.`;
  else if (probe.durationSeconds < 1) validationError = "Reels must be at least 1 second long.";
  else if (probe.durationSeconds > 15 * 60) validationError = "Reels must be 15 minutes or shorter.";
  else if (probe.width < 320 || probe.height < 320) validationError = "The video resolution is too small (minimum 320px).";
  const thumbnailKey = `thumbs/${ctx.orgId}/${assetId}.jpg`;
  const thumbOk = await generateThumbnail(asset.storageKey, thumbnailKey, Math.min(1, probe.durationSeconds / 2));
  const [row] = await ctx.db
    .update(assets)
    .set({
      status: validationError ? "invalid" : "ready",
      validationError,
      durationSeconds: Math.round(probe.durationSeconds),
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      thumbnailKey: thumbOk ? thumbnailKey : null,
      updatedAt: ctx.clock.now(),
    })
    .where(eq(assets.id, assetId))
    .returning();
  return row!;
}

export async function retryProcessing(ctx: Ctx, assetId: string): Promise<Asset> {
  requireRole(ctx, "operator", "retry processing");
  return processAsset(ctx, assetId);
}

// ---------- listing ----------
export type AssetFilter = {
  q?: string;
  creatorId?: string | null;
  familyId?: string;
  status?: Asset["status"] | "all";
  approval?: "approved" | "unapproved" | "invalidated" | "all";
  tag?: string;
  sort?: "newest" | "oldest" | "source_order" | "name" | "duration";
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
};

export type AssetRow = Asset & {
  creatorName: string | null;
  familyName: string | null;
  duplicateCount: number;
  approvedJobCount: number;
  activeJobCount: number;
  publishedCount: number;
  invalidatedJobCount: number;
};

export async function listAssets(ctx: Ctx, f: AssetFilter = {}): Promise<{ rows: AssetRow[]; total: number }> {
  const where: SQL[] = [eq(assets.orgId, ctx.orgId)];
  if (!f.includeDeleted) where.push(isNull(assets.deletedAt));
  const scope = creatorScopeOf(ctx);
  if (scope) where.push(sql`(${assets.creatorId} IS NULL OR ${assets.creatorId} = ANY(${uuidArray(scope)}))`);
  if (f.creatorId) where.push(eq(assets.creatorId, f.creatorId));
  if (f.creatorId === null) where.push(isNull(assets.creatorId));
  if (f.familyId) where.push(eq(assets.familyId, f.familyId));
  if (f.status && f.status !== "all") where.push(eq(assets.status, f.status));
  if (f.tag) where.push(sql`${f.tag} = ANY(${assets.tags})`);
  if (f.q) where.push(or(ilike(assets.originalFilename, `%${f.q}%`), ilike(assets.caption, `%${f.q}%`), sql`${f.q} = ANY(${assets.tags})`)!);
  const approvedJobs = sql<number>`(select count(*)::int from ${postingJobs} j where j.asset_id = ${assets.id} and j.approval_id is not null and j.state in ('QUEUED','READY','PREPARING','SUBMITTING','HELD'))`;
  const activeJobs = sql<number>`(select count(*)::int from ${postingJobs} j where j.asset_id = ${assets.id} and j.state in ('QUEUED','READY','PREPARING','SUBMITTING','HELD','BLOCKED','FAILED','UNKNOWN_OUTCOME'))`;
  const invalidatedJobs = sql<number>`(select count(*)::int from ${postingJobs} j where j.asset_id = ${assets.id} and j.state = 'BLOCKED' and j.error_category = 'approval_changed')`;
  const published = sql<number>`(select count(*)::int from ${verifiedPosts} v where v.asset_id = ${assets.id})`;
  const dupes = sql<number>`(select count(*)::int from ${assets} a2 where a2.org_id = ${assets.orgId} and a2.sha256 = ${assets.sha256} and a2.id <> ${assets.id} and a2.deleted_at is null)`;
  if (f.approval === "approved") where.push(sql`${approvedJobs} > 0`);
  if (f.approval === "unapproved") where.push(sql`${approvedJobs} = 0 and ${invalidatedJobs} = 0`);
  if (f.approval === "invalidated") where.push(sql`${invalidatedJobs} > 0`);
  const order =
    f.sort === "oldest" ? asc(assets.createdAt) : f.sort === "source_order" ? asc(assets.sourceOrder) : f.sort === "name" ? asc(assets.originalFilename) : f.sort === "duration" ? desc(assets.durationSeconds) : desc(assets.createdAt);
  const rows = await ctx.db
    .select({ a: assets, creatorName: sql<string | null>`(select name from creators c where c.id = ${assets.creatorId})`, familyName: contentFamilies.name, duplicateCount: dupes, approvedJobCount: approvedJobs, activeJobCount: activeJobs, publishedCount: published, invalidatedJobCount: invalidatedJobs })
    .from(assets)
    .leftJoin(contentFamilies, eq(contentFamilies.id, assets.familyId))
    .where(and(...where))
    .orderBy(order, asc(assets.id))
    .limit(Math.min(f.limit ?? 200, 1000))
    .offset(f.offset ?? 0);
  const totalRows = await ctx.db.select({ c: sql<number>`count(*)::int` }).from(assets).where(and(...where));
  return { rows: rows.map((r) => ({ ...r.a, creatorName: r.creatorName, familyName: r.familyName ?? null, duplicateCount: r.duplicateCount, approvedJobCount: r.approvedJobCount, activeJobCount: r.activeJobCount, publishedCount: r.publishedCount, invalidatedJobCount: r.invalidatedJobCount })), total: totalRows[0]?.c ?? 0 };
}

export async function getAsset(ctx: Ctx, id: string): Promise<AssetRow> {
  const { rows } = await listAssets(ctx, { includeDeleted: true, limit: 1000 });
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFound("Asset");
  return row;
}

export async function assetHistory(ctx: Ctx, assetId: string) {
  const posts = await ctx.db
    .select({ v: verifiedPosts, handle: accounts.handle })
    .from(verifiedPosts)
    .innerJoin(accounts, eq(accounts.id, verifiedPosts.accountId))
    .where(and(eq(verifiedPosts.orgId, ctx.orgId), eq(verifiedPosts.assetId, assetId)))
    .orderBy(desc(verifiedPosts.publishedAt));
  const jobs = await ctx.db
    .select({ j: postingJobs, handle: accounts.handle })
    .from(postingJobs)
    .innerJoin(accounts, eq(accounts.id, postingJobs.accountId))
    .where(and(eq(postingJobs.orgId, ctx.orgId), eq(postingJobs.assetId, assetId)))
    .orderBy(desc(postingJobs.plannedAt));
  return { posts: posts.map((p) => ({ ...p.v, handle: p.handle })), jobs: jobs.map((j) => ({ ...j.j, handle: j.handle })) };
}

// ---------- edits (with approval invalidation) ----------
export type AssetPatch = { caption?: string; creatorId?: string | null; familyId?: string | null; variantLabel?: string | null; tags?: string[]; sourceOrder?: number };

export async function updateAsset(ctx: Ctx, id: string, patch: AssetPatch): Promise<{ asset: Asset; invalidatedJobs: number }> {
  requireRole(ctx, "operator", "edit content");
  const current = await ctx.db.query.assets.findFirst({ where: and(eq(assets.id, id), eq(assets.orgId, ctx.orgId), isNull(assets.deletedAt)) });
  if (!current) throw notFound("Asset");
  assertCreatorAccess(ctx, current.creatorId);
  if (patch.creatorId !== undefined && patch.creatorId !== null) assertCreatorAccess(ctx, patch.creatorId);
  if (patch.caption !== undefined && patch.caption.length > 2200) throw validation("Instagram captions are limited to 2,200 characters.");
  const bindingChanged = (patch.caption !== undefined && patch.caption !== current.caption) || (patch.creatorId !== undefined && patch.creatorId !== current.creatorId);
  const values: Partial<typeof assets.$inferInsert> = { updatedAt: ctx.clock.now() };
  if (patch.caption !== undefined) values.caption = patch.caption;
  if (patch.creatorId !== undefined) values.creatorId = patch.creatorId;
  if (patch.familyId !== undefined) values.familyId = patch.familyId;
  if (patch.variantLabel !== undefined) values.variantLabel = patch.variantLabel;
  if (patch.tags !== undefined) values.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
  if (patch.sourceOrder !== undefined) values.sourceOrder = patch.sourceOrder;
  if (bindingChanged) values.version = current.version + 1;
  const [row] = await ctx.db.update(assets).set(values).where(eq(assets.id, id)).returning();
  let invalidatedJobs = 0;
  if (bindingChanged) {
    invalidatedJobs = await invalidateApprovalsForAsset(ctx, id, patch.caption !== undefined && patch.caption !== current.caption ? "caption edited" : "creator assignment changed");
  }
  const changes = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  await recordAudit(ctx, {
    eventType: "asset.updated",
    message: `Edited ${changes.join(", ")} on “${current.originalFilename}”${invalidatedJobs ? ` — ${invalidatedJobs} approved job${invalidatedJobs === 1 ? "" : "s"} now need re-approval.` : "."}`,
    creatorId: row!.creatorId,
    metadata: { assetId: id, version: row!.version, invalidatedJobs },
  });
  return { asset: row!, invalidatedJobs };
}

export async function bulkUpdateAssets(ctx: Ctx, ids: string[], patch: Pick<AssetPatch, "creatorId" | "familyId" | "tags">): Promise<{ updated: number; invalidatedJobs: number }> {
  let invalidatedJobs = 0;
  let updated = 0;
  for (const id of ids) {
    const r = await updateAsset(ctx, id, patch);
    invalidatedJobs += r.invalidatedJobs;
    updated++;
  }
  return { updated, invalidatedJobs };
}

export async function reorderAssets(ctx: Ctx, orderedIds: string[]): Promise<void> {
  requireRole(ctx, "operator", "reorder content");
  let i = 1;
  for (const id of orderedIds) {
    await ctx.db.update(assets).set({ sourceOrder: i++ }).where(and(eq(assets.id, id), eq(assets.orgId, ctx.orgId)));
  }
  await recordAudit(ctx, { eventType: "asset.reordered", message: `Changed the source order of ${orderedIds.length} items.` });
}

/** Soft-deletes an internal asset. This never touches anything already published on Instagram. */
export async function deleteAsset(ctx: Ctx, id: string): Promise<{ invalidatedJobs: number }> {
  requireRole(ctx, "operator", "delete content");
  const current = await ctx.db.query.assets.findFirst({ where: and(eq(assets.id, id), eq(assets.orgId, ctx.orgId), isNull(assets.deletedAt)) });
  if (!current) throw notFound("Asset");
  assertCreatorAccess(ctx, current.creatorId);
  const invalidatedJobs = await invalidateApprovalsForAsset(ctx, id, "media file deleted");
  await ctx.db.update(assets).set({ deletedAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(assets.id, id));
  await ctx.db
    .update(postingJobs)
    .set({ state: "HELD", stateReason: "Media file was deleted; assign different content", errorCategory: "content_missing", updatedAt: ctx.clock.now() })
    .where(and(eq(postingJobs.assetId, id), inArray(postingJobs.state, ["QUEUED", "READY"])));
  await recordAudit(ctx, { eventType: "asset.deleted", message: `Deleted “${current.originalFilename}” from the library. Any Instagram post made from it is unaffected.`, creatorId: current.creatorId, metadata: { assetId: id, invalidatedJobs } });
  return { invalidatedJobs };
}

/** Removes files for assets deleted longer ago than the retention window. Returns count purged. */
export async function purgeDeletedAssets(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - ctx.settings.retention.deletedAssetDays * 86_400_000);
  const rows = await ctx.db.select().from(assets).where(and(eq(assets.orgId, ctx.orgId), lt(assets.deletedAt, cutoff), ne(assets.storageKey, "")));
  for (const a of rows) {
    await deleteKey(a.storageKey);
    if (a.thumbnailKey) await deleteKey(a.thumbnailKey);
    await ctx.db.update(assets).set({ storageKey: "", thumbnailKey: null }).where(eq(assets.id, a.id));
  }
  return rows.length;
}

// ---------- families ----------
export async function listFamilies(ctx: Ctx): Promise<Array<ContentFamily & { assetCount: number }>> {
  const rows = await ctx.db
    .select({ f: contentFamilies, assetCount: sql<number>`(select count(*)::int from ${assets} a where a.family_id = ${contentFamilies.id} and a.deleted_at is null)` })
    .from(contentFamilies)
    .where(eq(contentFamilies.orgId, ctx.orgId))
    .orderBy(asc(contentFamilies.name));
  return rows.map((r) => ({ ...r.f, assetCount: r.assetCount }));
}

export async function createFamily(ctx: Ctx, input: { name: string; creatorId?: string | null; description?: string }): Promise<ContentFamily> {
  requireRole(ctx, "operator", "create content families");
  if (!input.name.trim()) throw validation("Family name is required.");
  const [row] = await ctx.db.insert(contentFamilies).values({ orgId: ctx.orgId, name: input.name.trim(), creatorId: input.creatorId ?? null, description: input.description ?? null }).returning();
  await recordAudit(ctx, { eventType: "family.created", message: `Created content family “${row!.name}”.` });
  return row!;
}

/** Siblings: other ready assets in the same explicit family. Never based on filename similarity. */
export async function familySiblings(ctx: Ctx, assetId: string): Promise<Asset[]> {
  const a = await ctx.db.query.assets.findFirst({ where: and(eq(assets.id, assetId), eq(assets.orgId, ctx.orgId)) });
  if (!a?.familyId) return [];
  return ctx.db.query.assets.findMany({ where: and(eq(assets.familyId, a.familyId), ne(assets.id, assetId), isNull(assets.deletedAt), eq(assets.status, "ready")), orderBy: asc(assets.sourceOrder) });
}
