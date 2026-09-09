import { content, accountsService, type Asset } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope } from "@/lib/scope";
import { PageHeader } from "@/components/common/page-header";
import { ContentView } from "@/components/content/content-view";
import { AssetPanel } from "@/components/content/asset-panel";
import { assetUrl, thumbUrl } from "@/lib/media";

export const metadata = { title: "Content" };

export default async function ContentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const creatorParam = one("creator");
  const filter: content.AssetFilter = {
    q: one("q"),
    creatorId: scope.kind === "creator" ? scope.creatorId : creatorParam === "none" ? null : creatorParam || undefined,
    familyId: one("family"),
    status: (one("status") as Asset["status"] | "all" | undefined) ?? "all",
    approval: (one("approval") as "approved" | "unapproved" | "invalidated" | "all" | undefined) ?? "all",
    tag: one("tag"),
    sort: (one("sort") as content.AssetFilter["sort"]) ?? "newest",
    limit: 400,
  };
  const [{ rows, total }, creators, families, uploadsOpen] = await Promise.all([content.listAssets(ctx, filter), accountsService.listCreators(ctx), content.listFamilies(ctx), listOpenUploads(ctx)]);
  const selectedId = one("asset");
  const index = selectedId ? rows.findIndex((a) => a.id === selectedId) : -1;
  const selected = selectedId ? (rows[index] ?? (await content.getAsset(ctx, selectedId).catch(() => null))) : null;
  const history = selected ? await content.assetHistory(ctx, selected.id) : null;
  const siblings = selected ? await content.familySiblings(ctx, selected.id) : [];
  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "asset" && typeof v === "string" && v) baseParams.set(k, v);
  const hrefFor = (id?: string) => {
    const p = new URLSearchParams(baseParams);
    if (id) p.set("asset", id);
    const q = p.toString();
    return q ? `/content?${q}` : "/content";
  };
  const serialize = (a: (typeof rows)[number]) => ({ ...a, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(), lockedAt: a.lockedAt?.toISOString() ?? null, deletedAt: a.deletedAt?.toISOString() ?? null, thumbUrl: thumbUrl(ctx.orgId, a.thumbnailKey) });
  const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Content" description={`${total} video${total === 1 ? "" : "s"} in view · ${rows.filter((r) => r.status === "ready").length} ready · ${rows.filter((r) => r.status === "invalid").length} invalid`} />
      <ContentView
        key={`${baseParams.toString()}|${one("upload") ?? ""}`}
        rows={rows.map(serialize)}
        creators={creators.map((c) => ({ id: c.id, name: c.name, color: c.color, readyAssets: c.readyAssets }))}
        families={families.map((f) => ({ id: f.id, name: f.name, creatorId: f.creatorId, assetCount: f.assetCount }))}
        tags={tags}
        openUploads={uploadsOpen}
        role={ctx.user.role}
        selectedId={selected?.id ?? null}
        filterKey={baseParams.toString()}
        openUploader={one("upload") === "1"}
        defaultCreatorId={scope.kind === "creator" ? scope.creatorId : creatorParam && creatorParam !== "none" ? creatorParam : undefined}
      />
      {selected ? (
        <AssetPanel
          asset={{ ...serialize(selected), videoUrl: assetUrl(ctx.orgId, selected.storageKey) }}
          creators={creators.map((c) => ({ id: c.id, name: c.name }))}
          families={families.map((f) => ({ id: f.id, name: f.name, creatorId: f.creatorId }))}
          history={{ posts: history!.posts.map((p) => ({ id: p.id, handle: p.handle, publishedAt: p.publishedAt.toISOString(), postUrl: p.postUrl, jobId: p.jobId })), jobs: history!.jobs.map((j) => ({ id: j.id, handle: j.handle, state: j.state, plannedAt: j.plannedAt.toISOString(), stateReason: j.stateReason })) }}
          siblings={siblings.map((s) => ({ id: s.id, name: s.originalFilename, variantLabel: s.variantLabel, thumbUrl: thumbUrl(ctx.orgId, s.thumbnailKey) }))}
          role={ctx.user.role}
          closeHref={hrefFor()}
          prevHref={index > 0 ? hrefFor(rows[index - 1]!.id) : null}
          nextHref={index >= 0 && index < rows.length - 1 ? hrefFor(rows[index + 1]!.id) : null}
          position={index >= 0 ? { index, total: rows.length } : undefined}
        />
      ) : null}
    </div>
  );
}

async function listOpenUploads(ctx: Awaited<ReturnType<typeof getUserCtx>>) {
  const { uploads } = await import("@synthos/core");
  const { and, eq, desc } = await import("drizzle-orm");
  const rows = await ctx.db.select().from(uploads).where(and(eq(uploads.orgId, ctx.orgId), eq(uploads.status, "open"))).orderBy(desc(uploads.updatedAt)).limit(20);
  return rows.map((u) => ({ id: u.id, filename: u.filename, sizeBytes: u.sizeBytes, receivedBytes: u.receivedBytes, updatedAt: u.updatedAt.toISOString() }));
}
