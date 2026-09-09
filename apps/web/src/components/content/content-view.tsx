"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, Upload, X, LayoutGrid, List, Copy, AlertCircle } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox, Input, Select } from "../ui/field";
import { SegmentedTabs } from "../ui/tabs";
import { EmptyState } from "../ui/empty";
import { useToast } from "../ui/toast";
import { Thumb } from "../common/chips";
import { Uploader } from "./uploader";
import { bulkUpdateAssetsAction } from "@/actions/content";
import { durationLabel, relTime, bytesLabel } from "@/lib/format";
import { cn } from "../ui/cn";

export type AssetCard = {
  id: string; originalFilename: string; caption: string; status: string; validationError: string | null; durationSeconds: number | null; width: number | null; height: number | null; sizeBytes: number; sha256: string; tags: string[]; sourceOrder: number; version: number; creatorId: string | null; creatorName: string | null; familyId: string | null; familyName: string | null; variantLabel: string | null; duplicateCount: number; approvedJobCount: number; activeJobCount: number; publishedCount: number; invalidatedJobCount: number; createdAt: string; lockedAt: string | null; thumbUrl: string | null;
};

type Props = {
  rows: AssetCard[];
  creators: Array<{ id: string; name: string; color: string; readyAssets: number }>;
  families: Array<{ id: string; name: string; creatorId: string | null; assetCount: number }>;
  tags: string[];
  openUploads: Array<{ id: string; filename: string; sizeBytes: number; receivedBytes: number; updatedAt: string }>;
  role: string;
  selectedId: string | null;
  filterKey: string;
  openUploader: boolean;
  defaultCreatorId?: string;
};

export function approvalLabel(a: AssetCard): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (a.status === "invalid") return { label: "Invalid", tone: "danger" };
  if (a.status !== "ready") return { label: "Processing", tone: "neutral" };
  if (a.invalidatedJobCount > 0) return { label: "Needs re-approval", tone: "danger" };
  if (a.approvedJobCount > 0) return { label: `Approved · ${a.approvedJobCount} upcoming`, tone: "ok" };
  if (a.publishedCount > 0 && a.activeJobCount === 0) return { label: `Posted ${a.publishedCount}×`, tone: "neutral" };
  if (!a.caption.trim()) return { label: "Needs caption", tone: "warn" };
  return { label: "Not scheduled", tone: "neutral" };
}

export function ContentView({ rows, creators, families, tags, openUploads, role, selectedId, filterKey, openUploader, defaultCreatorId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [uploader, setUploader] = React.useState(openUploader);
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [busy, setBusy] = React.useState(false);
  void filterKey; // the page remounts this view with key={filterKey}; selection never leaks across scopes
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v); else p.delete(k);
    p.delete("asset"); p.delete("upload");
    router.push(`${pathname}?${p.toString()}`);
  };
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("q", value || null), 250);
  };
  const open = (id: string) => { const p = new URLSearchParams(params.toString()); p.set("asset", id); p.delete("upload"); router.push(`${pathname}?${p.toString()}`, { scroll: false }); };
  const bulk = async (patch: { creatorId?: string | null; familyId?: string | null; tags?: string[] }) => {
    setBusy(true);
    const ids = [...selected].filter((id) => rows.some((r) => r.id === id));
    const r = await bulkUpdateAssetsAction(ids, patch);
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: `Updated ${r.data.updated} video${r.data.updated === 1 ? "" : "s"}`, body: r.data.invalidatedJobs ? `${r.data.invalidatedJobs} approved post(s) now need re-approval.` : undefined });
    setSelected(new Set());
    router.refresh();
  };
  const approval = params.get("approval") ?? "all";
  const status = params.get("status") ?? "all";
  const coverage = creators.map((c) => ({ ...c }));
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {canEdit ? <Button variant="primary" onClick={() => setUploader(true)}><Upload size={15} /> Upload Reels</Button> : null}
        <div className="relative w-full sm:w-60">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search filename, caption or tag" className="pl-8" aria-label="Search content" />
        </div>
        <Select aria-label="Creator" value={params.get("scope")?.startsWith("creator:") ? params.get("scope")!.slice(8) : (params.get("creator") ?? "")} onChange={(e) => setParam("creator", e.target.value || null)} inline className="h-8 py-0 text-[12.5px]" disabled={Boolean(params.get("scope")?.startsWith("creator:"))}>
          <option value="">All creators</option>
          <option value="none">Unassigned</option>
          {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select aria-label="Family" value={params.get("family") ?? ""} onChange={(e) => setParam("family", e.target.value || null)} inline className="h-8 py-0 text-[12.5px]">
          <option value="">Any family</option>
          {families.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.assetCount})</option>)}
        </Select>
        {tags.length ? (
          <Select aria-label="Tag" value={params.get("tag") ?? ""} onChange={(e) => setParam("tag", e.target.value || null)} inline className="h-8 py-0 text-[12.5px]">
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </Select>
        ) : null}
        <Select aria-label="Sort" value={params.get("sort") ?? "newest"} onChange={(e) => setParam("sort", e.target.value)} inline className="h-8 py-0 text-[12.5px]">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="source_order">Source order</option>
          <option value="name">Filename</option>
          <option value="duration">Longest</option>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={15} /></Button>
          <Button variant={view === "list" ? "secondary" : "ghost"} size="icon" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={15} /></Button>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs ariaLabel="Approval" size="sm" value={approval} onChange={(v) => setParam("approval", v === "all" ? null : v)} options={[{ value: "all", label: "All" }, { value: "approved", label: "Approved" }, { value: "unapproved", label: "Not scheduled" }, { value: "invalidated", label: "Needs re-approval" }]} />
        <SegmentedTabs ariaLabel="File status" size="sm" value={status} onChange={(v) => setParam("status", v === "all" ? null : v)} options={[{ value: "all", label: "Any file" }, { value: "ready", label: "Ready" }, { value: "invalid", label: "Invalid" }]} />
      </div>

      {uploader && canEdit ? <div className="mb-4"><Uploader creators={creators} defaultCreatorId={defaultCreatorId} onClose={() => { setUploader(false); if (params.get("upload")) setParam("upload", null); }} resume={openUploads[0] ?? null} /></div> : null}

      {openUploads.length && !uploader ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <AlertCircle size={14} />
          <span>{openUploads.length} unfinished upload{openUploads.length === 1 ? "" : "s"}: {openUploads.map((u) => `${u.filename} (${Math.round((u.receivedBytes / u.sizeBytes) * 100)}%, ${relTime(u.updatedAt)})`).join(", ")}.</span>
          {canEdit ? <button className="font-medium underline" onClick={() => setUploader(true)}>Resume by dropping the file again</button> : null}
        </div>
      ) : null}

      {selected.size > 0 && canEdit ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm fade-in" role="region" aria-label="Bulk actions">
          <span className="font-medium text-accent-ink">{selected.size} selected</span>
          <Select aria-label="Assign creator" inline className="h-8 py-0 text-[12.5px]" value="" disabled={busy} onChange={(e) => e.target.value && void bulk({ creatorId: e.target.value === "none" ? null : e.target.value })}>
            <option value="">Assign to creator…</option>
            <option value="none">Unassign</option>
            {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select aria-label="Assign family" inline className="h-8 py-0 text-[12.5px]" value="" disabled={busy} onChange={(e) => e.target.value && void bulk({ familyId: e.target.value === "none" ? null : e.target.value })}>
            <option value="">Put in family…</option>
            <option value="none">Remove from family</option>
            {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}><X size={13} /> Clear</Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title={q ? "No videos match" : "No videos here yet"} body={q ? `Nothing matches “${q}”.` : "Upload finished Reels, assign them to a creator and write captions. Approved campaigns pull from this library in source order."} action={canEdit ? <Button variant="primary" onClick={() => setUploader(true)}><Upload size={15} /> Upload Reels</Button> : undefined} />
      ) : view === "grid" ? (
        <div>
          {canEdit ? <label className="mb-2 inline-flex items-center gap-2 text-[12.5px] text-ink-3"><Checkbox checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} /> Select all {rows.length}</label> : null}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {rows.map((a) => {
              const ap = approvalLabel(a);
              return (
                <li key={a.id} className={cn("group relative rounded-lg border bg-surface p-1.5 transition-shadow hover:shadow-pop", selectedId === a.id ? "border-accent ring-2 ring-accent/30" : "border-line", selected.has(a.id) && "border-accent/60")}>
                  {canEdit ? <span className="absolute left-2.5 top-2.5 z-10"><Checkbox aria-label={`Select ${a.originalFilename}`} checked={selected.has(a.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} className="bg-surface" /></span> : null}
                  <button onClick={() => open(a.id)} className="block w-full text-left" aria-label={`Open ${a.originalFilename}`}>
                    <div className="relative">
                      <Thumb src={a.thumbUrl} alt="" className="w-full" />
                      {a.status === "invalid" ? <span className="absolute inset-0 flex items-center justify-center rounded-[6px] bg-danger/80 px-2 text-center text-[12px] font-medium text-white">Invalid file</span> : null}
                      <span className="tabular absolute bottom-1.5 right-1.5 rounded bg-ink/75 px-1.5 py-0.5 text-[11px] font-medium text-white">{durationLabel(a.durationSeconds)}</span>
                      {a.duplicateCount > 0 ? <span className="absolute left-1.5 bottom-1.5 inline-flex items-center gap-1 rounded bg-warn px-1.5 py-0.5 text-[11px] font-medium text-white"><Copy size={10} /> duplicate</span> : null}
                    </div>
                    <div className="px-1 pb-1 pt-2">
                      <p className="truncate text-[12.5px] font-medium text-ink" title={a.originalFilename}>{a.originalFilename}</p>
                      <p className="truncate text-[11.5px] text-ink-3">{a.creatorName ?? <span className="text-warn">Unassigned</span>}{a.familyName ? ` · ${a.familyName}${a.variantLabel ? ` / ${a.variantLabel}` : ""}` : ""}</p>
                      <div className="mt-1.5"><Badge tone={ap.tone}>{ap.label}</Badge></div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-8 px-3 py-2">{canEdit ? <Checkbox aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} /> : null}</th>
                <th className="px-2 py-2">Video</th><th className="px-2 py-2">Creator</th><th className="px-2 py-2">Caption</th><th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Order</th><th className="px-2 py-2 text-right">Posted</th><th className="px-2 py-2">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => { const ap = approvalLabel(a); return (
                <tr key={a.id} className={cn("border-t border-line hover:bg-surface-2", selectedId === a.id && "bg-accent-soft/60")}>
                  <td className="px-3 py-1.5">{canEdit ? <Checkbox aria-label={`Select ${a.originalFilename}`} checked={selected.has(a.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} /> : null}</td>
                  <td className="px-2 py-1.5"><button onClick={() => open(a.id)} className="flex items-center gap-2 text-left"><Thumb src={a.thumbUrl} alt="" className="w-7" /><span><span className="block font-medium">{a.originalFilename}</span><span className="text-[11.5px] text-ink-3">{durationLabel(a.durationSeconds)} · {a.width}×{a.height} · {bytesLabel(a.sizeBytes)}</span></span></button></td>
                  <td className="px-2 py-1.5">{a.creatorName ?? <span className="text-warn">Unassigned</span>}</td>
                  <td className="max-w-[260px] truncate px-2 py-1.5 text-ink-2">{a.caption || <span className="text-warn">No caption</span>}</td>
                  <td className="px-2 py-1.5"><Badge tone={ap.tone}>{ap.label}</Badge></td>
                  <td className="tabular px-2 py-1.5 text-right">{a.sourceOrder}</td>
                  <td className="tabular px-2 py-1.5 text-right">{a.publishedCount}</td>
                  <td className="px-2 py-1.5 text-ink-3">{relTime(a.createdAt)}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 rounded-lg border border-line bg-surface-2 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Ready content per creator</p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {coverage.map((c) => <button key={c.id} onClick={() => setParam("creator", c.id)} className="inline-flex items-center gap-1.5 hover:underline"><span className="h-2 w-2 rounded-full" style={{ background: c.color }} aria-hidden />{c.name} <span className={cn("tabular font-medium", c.readyAssets === 0 ? "text-warn" : "text-ink")}>{c.readyAssets}</span></button>)}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-4">Telegram and Google Drive intake are future integrations; upload directly here for now. Matching filenames are not treated as the same video, and hash matching only finds byte-identical files.</p>
      </div>
    </div>
  );
}
