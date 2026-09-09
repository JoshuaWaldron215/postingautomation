"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2, RotateCcw, ExternalLink, Lock } from "lucide-react";
import { SidePanel, PanelSection, KV } from "../ui/panel";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { ConfirmDialog } from "../ui/dialog";
import { Field, Input, Select, Textarea } from "../ui/field";
import { useToast } from "../ui/toast";
import { useDirty } from "../shell/dirty-guard";
import { JobStatePill, Thumb } from "../common/chips";
import { approvalLabel, type AssetCard } from "./content-view";
import { deleteAssetAction, retryProcessingAction, updateAssetAction, createFamilyAction } from "@/actions/content";
import { bytesLabel, durationLabel, fmtDateTime } from "@/lib/format";

type Props = {
  asset: AssetCard & { videoUrl: string | null };
  creators: Array<{ id: string; name: string }>;
  families: Array<{ id: string; name: string; creatorId: string | null }>;
  history: { posts: Array<{ id: string; handle: string; publishedAt: string; postUrl: string | null; jobId: string }>; jobs: Array<{ id: string; handle: string; state: string; plannedAt: string; stateReason: string | null }> };
  siblings: Array<{ id: string; name: string; variantLabel: string | null; thumbUrl: string | null }>;
  role: string;
  closeHref: string; prevHref: string | null; nextHref: string | null; position?: { index: number; total: number };
};

const CAPTION_STARTERS = ["Save this for later 👇", "POV: ", "Three things nobody tells you about ", "Try this before you ", "The 10-second fix for "];

export function AssetPanel({ asset, creators, families, history, siblings, role, closeHref, prevHref, nextHref, position }: Props) {
  return <AssetPanelInner key={asset.id} {...{ asset, creators, families, history, siblings, role, closeHref, prevHref, nextHref, position }} />;
}

function AssetPanelInner({ asset, creators, families, history, siblings, role, closeHref, prevHref, nextHref, position }: Props) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const initial = React.useMemo(() => ({ caption: asset.caption, creatorId: asset.creatorId ?? "", familyId: asset.familyId ?? "", variantLabel: asset.variantLabel ?? "", tags: asset.tags.join(", "), sourceOrder: String(asset.sourceOrder) }), [asset]);
  const [form, setForm] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [newFamily, setNewFamily] = React.useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirty(`asset-${asset.id}`, dirty);
  const ap = approvalLabel(asset);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const captionChanged = form.caption !== initial.caption;
  const willInvalidate = (captionChanged || form.creatorId !== initial.creatorId) && asset.approvedJobCount > 0;

  const save = async () => {
    setBusy("save");
    const r = await updateAssetAction(asset.id, { caption: form.caption, creatorId: form.creatorId || null, familyId: form.familyId || null, variantLabel: form.variantLabel || null, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean), sourceOrder: Number(form.sourceOrder) || asset.sourceOrder });
    setBusy(null);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: "Saved", body: r.data.invalidatedJobs ? `${r.data.invalidatedJobs} approved post(s) were blocked and need re-approval because the approved caption changed.` : undefined });
    router.refresh();
  };
  const del = async () => {
    setBusy("delete");
    const r = await deleteAssetAction(asset.id);
    setBusy(null);
    setConfirmDelete(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: "Removed from the library", body: "Posts already on Instagram are untouched." });
    router.push(closeHref);
    router.refresh();
  };
  const addFamily = async () => {
    if (!newFamily.trim()) return;
    const r = await createFamilyAction({ name: newFamily.trim(), creatorId: form.creatorId || null });
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    setForm((f) => ({ ...f, familyId: r.data.id }));
    setNewFamily("");
    router.refresh();
  };

  return (
    <SidePanel title={asset.originalFilename} subtitle={<span>{asset.creatorName ?? "Unassigned"} · {durationLabel(asset.durationSeconds)} · {asset.width}×{asset.height} · {bytesLabel(asset.sizeBytes)}</span>} onCloseHref={closeHref} prevHref={prevHref} nextHref={nextHref} position={position} width="lg">
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
        <div>
          {asset.videoUrl && asset.status === "ready" ? (
            <video controls preload="metadata" poster={asset.thumbUrl ?? undefined} className="aspect-[9/16] w-full rounded-md bg-ink object-contain" src={asset.videoUrl} />
          ) : (
            <Thumb src={asset.thumbUrl} alt="" className="w-full" />
          )}
        </div>
        <div className="space-y-2 text-[12.5px]">
          <div className="flex flex-wrap gap-1.5"><Badge tone={ap.tone}>{ap.label}</Badge>{asset.lockedAt ? <Badge tone="neutral"><Lock size={10} /> v{asset.version} approved</Badge> : null}{asset.duplicateCount ? <Badge tone="warn">{asset.duplicateCount} exact duplicate{asset.duplicateCount === 1 ? "" : "s"}</Badge> : null}</div>
          {asset.status === "invalid" ? (
            <div className="rounded-md border border-danger/40 bg-danger-soft p-2.5 text-danger">
              <p className="font-medium">This file cannot be posted</p>
              <p className="mt-0.5">{asset.validationError}</p>
              {canEdit ? <Button size="sm" variant="outline" className="mt-2" loading={busy === "retry"} onClick={() => void (async () => { setBusy("retry"); const r = await retryProcessingAction(asset.id); setBusy(null); if (!r.ok) toast.push({ tone: "danger", title: r.error }); router.refresh(); })()}><RotateCcw size={13} /> Re-check file</Button> : null}
            </div>
          ) : null}
          <KV rows={[["Added", fmtDateTime(asset.createdAt)], ["Codec", asset.status === "ready" ? "ready to post" : "—"], ["Hash", <code key="h" className="break-all rounded bg-surface-3 px-1 text-[11px]">{asset.sha256.slice(0, 16)}…</code>], ["Version", `v${asset.version}`]]} />
          <p className="text-[11.5px] text-ink-4">Hash matching finds byte-identical files only; visually similar videos are not detected.</p>
        </div>
      </div>

      <PanelSection title="Caption & assignment">
        <div className="space-y-3">
          <Field label={`Caption (${form.caption.length}/2200)`} hint={asset.approvedJobCount ? "This caption is bound to an approval. Editing it blocks the approved posts until the campaign is re-approved." : undefined}>
            <Textarea rows={5} value={form.caption} onChange={set("caption")} disabled={!canEdit} maxLength={2200} placeholder="Write the caption exactly as it should be posted." />
          </Field>
          {canEdit && !form.caption ? <div className="flex flex-wrap gap-1.5">{CAPTION_STARTERS.map((s) => <button key={s} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11.5px] hover:border-line-strong" onClick={() => setForm((f) => ({ ...f, caption: s }))}>{s}</button>)}<span className="text-[11px] text-ink-4">Starters only — write the real caption yourself.</span></div> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Creator"><Select value={form.creatorId} onChange={set("creatorId")} disabled={!canEdit}><option value="">Unassigned</option>{creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Source order" hint="Campaigns pull content in this order."><Input type="number" value={form.sourceOrder} onChange={set("sourceOrder")} disabled={!canEdit} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Content family" hint="Explicit grouping for variants of the same idea.">
              <Select value={form.familyId} onChange={set("familyId")} disabled={!canEdit}><option value="">None</option>{families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
            </Field>
            <Field label="Variant label"><Input value={form.variantLabel} onChange={set("variantLabel")} placeholder="e.g. B · close-up" disabled={!canEdit} /></Field>
          </div>
          {canEdit ? <div className="flex items-center gap-2"><Input value={newFamily} onChange={(e) => setNewFamily(e.target.value)} placeholder="New family name" className="h-8" /><Button size="sm" variant="outline" onClick={() => void addFamily()} disabled={!newFamily.trim()}>Create family</Button></div> : null}
          <Field label="Tags" hint="Comma separated."><Input value={form.tags} onChange={set("tags")} disabled={!canEdit} /></Field>
          {willInvalidate ? <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">Saving will block {asset.approvedJobCount} approved post{asset.approvedJobCount === 1 ? "" : "s"} until the campaign is approved again with the new caption.</p> : null}
          {canEdit ? (
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={!dirty} loading={busy === "save"} onClick={() => void save()}>Save</Button>
              {dirty ? <Button variant="ghost" onClick={() => setForm(initial)}>Discard</Button> : null}
              {dirty ? <span className="text-[12px] text-warn">Unsaved changes</span> : null}
              <Button variant="ghost" className="ml-auto text-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete from library</Button>
            </div>
          ) : null}
        </div>
      </PanelSection>

      {siblings.length ? (
        <PanelSection title={`Family siblings (${asset.familyName})`}>
          <ul className="flex gap-2 overflow-x-auto">
            {siblings.map((s) => (
              <li key={s.id} className="w-20 shrink-0"><Link href={`/content?asset=${s.id}`} className="block"><Thumb src={s.thumbUrl} alt="" className="w-full" /><span className="mt-1 block truncate text-[11px] text-ink-2">{s.variantLabel ?? s.name}</span></Link></li>
            ))}
          </ul>
        </PanelSection>
      ) : null}

      <PanelSection title="Posting history">
        {history.posts.length === 0 && history.jobs.length === 0 ? <p className="text-[13px] text-ink-3">Not used in any campaign yet.</p> : (
          <ul className="divide-y divide-line">
            {history.jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <span className="tabular w-[92px] text-ink-3">{fmtDateTime(j.plannedAt)}</span>
                <Link href={`/schedule?job=${j.id}`} className="font-medium hover:underline">@{j.handle}</Link>
                <JobStatePill state={j.state} />
                {history.posts.find((p) => p.jobId === j.id)?.postUrl ? <a href={history.posts.find((p) => p.jobId === j.id)!.postUrl!} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-accent hover:underline">link <ExternalLink size={11} /></a> : null}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this video from the library?" body={<>This removes the internal file after the retention window and blocks any approved posts that use it. <strong>It does not delete anything already published on Instagram.</strong></>} confirmLabel="Delete from library" tone="danger" loading={busy === "delete"} onConfirm={del} />
    </SidePanel>
  );
}
