"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload, X, RotateCcw, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "../ui/button";
import { Field, Select, Textarea } from "../ui/field";
import { bytesLabel } from "@/lib/format";
import { cn } from "../ui/cn";

type Item = { id: string; file: File; status: "queued" | "uploading" | "processing" | "done" | "error" | "duplicate"; progress: number; error?: string; uploadId?: string; assetId?: string; duplicateOf?: string };
const ACCEPT = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"];

/**
 * Bulk drag-and-drop uploader with per-file progress, chunked (resumable) transfer and retry.
 * Server-side validation happens on completion; invalid files show their reason inline.
 */
export function Uploader({ creators, defaultCreatorId, onClose, resume }: { creators: Array<{ id: string; name: string }>; defaultCreatorId?: string; onClose: () => void; resume?: { id: string; filename: string; sizeBytes: number; receivedBytes: number } | null }) {
  const router = useRouter();
  const [items, setItems] = React.useState<Item[]>([]);
  const [creatorId, setCreatorId] = React.useState(defaultCreatorId ?? "");
  const [caption, setCaption] = React.useState("");
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const update = (id: string, patch: Partial<Item>) => setItems((s) => s.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const add = (files: FileList | File[]) => {
    const next: Item[] = [];
    for (const f of Array.from(files)) {
      const okType = ACCEPT.includes(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name);
      next.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`, file: f, status: okType ? "queued" : "error", progress: 0, error: okType ? undefined : "Not a video file (MP4, MOV or WebM)." });
    }
    setItems((s) => [...s, ...next]);
  };

  const uploadOne = React.useCallback(async (item: Item) => {
    update(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      let uploadId = item.uploadId;
      let received = 0;
      let chunkBytes = 4 * 1024 * 1024;
      if (uploadId) {
        const st = await fetch(`/api/uploads/${uploadId}`).then((r) => r.json());
        received = st.receivedBytes ?? 0;
        chunkBytes = st.chunkBytes ?? chunkBytes;
      } else {
        const res = await fetch("/api/uploads/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: item.file.name, mime: item.file.type || "application/octet-stream", sizeBytes: item.file.size }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message ?? "Could not start upload");
        uploadId = json.uploadId as string;
        chunkBytes = json.chunkBytes;
        update(item.id, { uploadId });
      }
      while (received < item.file.size) {
        const chunk = item.file.slice(received, Math.min(item.file.size, received + chunkBytes));
        const res = await fetch(`/api/uploads/${uploadId}/chunk?offset=${received}`, { method: "POST", body: chunk });
        const json = await res.json();
        if (!res.ok) {
          if (json.error?.code === "conflict" && typeof json.error?.details?.expectedOffset === "number") {
            received = json.error.details.expectedOffset;
            continue;
          }
          throw new Error(json.error?.message ?? "Chunk upload failed");
        }
        received = json.receivedBytes;
        update(item.id, { progress: received / item.file.size });
      }
      update(item.id, { status: "processing", progress: 1 });
      const res = await fetch(`/api/uploads/${uploadId}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creatorId: creatorId || null, caption }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? "Processing failed");
      if (json.asset.status === "invalid") update(item.id, { status: "error", assetId: json.asset.id, error: json.asset.validationError ?? "The file is not a valid video." });
      else if (json.duplicateOf) update(item.id, { status: "duplicate", assetId: json.asset.id, duplicateOf: json.duplicateOf.originalFilename });
      else update(item.id, { status: "done", assetId: json.asset.id });
      router.refresh();
    } catch (err) {
      update(item.id, { status: "error", error: err instanceof Error ? (err.message === "Failed to fetch" ? "Connection lost. Retry resumes from the last received chunk." : err.message) : "Upload failed" });
    }
  }, [caption, creatorId, router]);

  React.useEffect(() => {
    const running = items.filter((i) => i.status === "uploading" || i.status === "processing").length;
    const next = items.find((i) => i.status === "queued");
    if (!next || running >= 2) return;
    const t = setTimeout(() => void uploadOne(next), 0);
    return () => clearTimeout(t);
  }, [items, uploadOne]);

  const done = items.filter((i) => i.status === "done" || i.status === "duplicate").length;
  const failed = items.filter((i) => i.status === "error").length;
  const busy = items.some((i) => i.status === "uploading" || i.status === "processing" || i.status === "queued");

  return (
    <div className="fade-in rounded-lg border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(31,27,22,0.05)]" role="region" aria-label="Upload Reels">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Upload Reels</h2>
        <Button variant="ghost" size="icon" aria-label="Close uploader" onClick={onClose} disabled={busy}><X size={16} /></Button>
      </div>
      {resume ? <p className="mb-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">An earlier upload of <strong>{resume.filename}</strong> stopped at {Math.round((resume.receivedBytes / resume.sizeBytes) * 100)}%. Drop the same file again to resume from where it left off.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assign to creator" hint="You can change this per video afterwards.">
          <Select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} disabled={busy}>
            <option value="">Unassigned</option>
            {creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Caption for this batch (optional)"><Textarea rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Edit per video later" disabled={busy} /></Field>
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop video files here or press Enter to choose files"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        className={cn("mt-3 flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors", drag ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2 hover:border-accent/60")}
      >
        <Upload size={22} className="mb-2 text-ink-3" />
        <p className="text-sm font-medium">Drop finished Reels here, or click to choose</p>
        <p className="mt-0.5 text-[12px] text-ink-3">MP4 or MOV, up to 1 GB each. Uploads are chunked and can be retried; exact duplicates are detected by file hash.</p>
        <input ref={inputRef} type="file" accept="video/*,.mp4,.mov,.webm,.m4v" multiple className="sr-only" onChange={(e) => e.target.files && add(e.target.files)} />
      </div>
      {items.length ? (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <span className="w-5 shrink-0">
                {i.status === "done" ? <CheckCircle2 size={16} className="text-ok" /> : i.status === "duplicate" ? <AlertCircle size={16} className="text-warn" /> : i.status === "error" ? <AlertCircle size={16} className="text-danger" /> : <span className="block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.file.name} <span className="font-normal text-ink-4">{bytesLabel(i.file.size)}</span></span>
                {i.status === "uploading" ? <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-3"><span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(i.progress * 100)}%` }} /></span> : null}
                {i.status === "processing" ? <span className="text-[12px] text-ink-3">Checking the file and making a thumbnail…</span> : null}
                {i.status === "error" ? <span className="text-[12px] text-danger">{i.error}</span> : null}
                {i.status === "duplicate" ? <span className="text-[12px] text-warn">Exact duplicate of “{i.duplicateOf}” (same file hash). Kept as a separate entry so you can delete it.</span> : null}
                {i.status === "done" ? <span className="text-[12px] text-ok">Ready</span> : null}
              </span>
              {i.status === "error" && !i.assetId ? <Button size="sm" variant="ghost" onClick={() => update(i.id, { status: "queued" })}><RotateCcw size={13} /> Retry</Button> : null}
              {i.status === "error" && i.assetId ? <a href={`/content?asset=${i.assetId}`} className="text-[12px] text-accent hover:underline">Details</a> : null}
              {i.status === "queued" || i.status === "error" ? <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setItems((s) => s.filter((x) => x.id !== i.id))}><X size={13} /></Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {items.length ? <p className="mt-2 text-[12px] text-ink-3">{done} ready · {failed} failed · {items.length - done - failed} in progress</p> : null}
    </div>
  );
}
