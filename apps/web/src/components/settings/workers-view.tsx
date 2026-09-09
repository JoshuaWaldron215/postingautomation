"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, Plus, RotateCcw, Ban } from "lucide-react";
import { Card } from "../common/page-header";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog, ConfirmDialog } from "../ui/dialog";
import { Field, Input, Select } from "../ui/field";
import { useToast } from "../ui/toast";
import { relTime } from "@/lib/format";
import { createWorkerAction, revokeWorkerAction, rotateWorkerTokenAction } from "@/actions/settings";

type W = { id: string; name: string; kind: string; status: string; lastHeartbeatAt: string | null; tokenPrefix: string; maxConcurrency: number; version: string | null; capabilities: Record<string, unknown>; hostInfo: Record<string, unknown>; accountCount: number; createdAt: string; revokedAt: string | null };

export function WorkersView({ workers, accounts, role, demoMode, appUrl }: { workers: W[]; accounts: Array<{ id: string; handle: string; workerId: string | null; effectiveState: string }>; role: string; demoMode: boolean; appUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role === "owner";
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", kind: "hermes_mac" as "simulator" | "hermes_mac", maxConcurrency: "1" });
  const [token, setToken] = React.useState<{ name: string; token: string; kind: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [revoke, setRevoke] = React.useState<W | null>(null);
  const create = async () => { setBusy("create"); const r = await createWorkerAction({ name: form.name, kind: form.kind, maxConcurrency: Number(form.maxConcurrency) || 1 }); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); setOpen(false); setToken({ name: r.data.worker.name, token: r.data.token, kind: r.data.worker.kind }); setForm({ name: "", kind: "hermes_mac", maxConcurrency: "1" }); router.refresh(); };
  const rotate = async (w: W) => { setBusy(w.id); const r = await rotateWorkerTokenAction(w.id); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); setToken({ name: w.name, token: r.data.token, kind: w.kind }); router.refresh(); };
  const doRevoke = async () => { if (!revoke) return; setBusy("revoke"); const r = await revokeWorkerAction(revoke.id); setBusy(null); setRevoke(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); toast.push({ tone: "ok", title: "Worker revoked" }); router.refresh(); };
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast.push({ tone: "ok", title: "Copied" }); } catch { toast.push({ tone: "danger", title: "Could not copy; select the text manually." }); } };
  return (
    <div className="space-y-4">
      <Card title="Execution workers" action={canEdit ? <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add worker</Button> : null}>
        <ul className="divide-y divide-line">
          {workers.map((w) => {
            const caps = w.capabilities as { notes?: string[]; live?: boolean; adapter?: string };
            const assigned = accounts.filter((a) => a.workerId === w.id);
            return (
              <li key={w.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${w.status === "online" ? "bg-ok" : w.status === "offline" ? "bg-danger" : w.status === "revoked" ? "bg-line-strong" : "bg-warn"}`} aria-hidden />
                  <span className="text-[14px] font-semibold">{w.name}</span>
                  <Badge tone={w.kind === "simulator" ? "warn" : "neutral"}>{w.kind === "simulator" ? "Simulator" : w.kind === "hermes_mac" ? "Mac · Hermes browser" : w.kind}</Badge>
                  <Badge tone={w.status === "online" ? "ok" : w.status === "revoked" ? "neutral" : "danger"}>{w.status === "never_connected" ? "never connected" : w.status}</Badge>
                  <span className="text-[12px] text-ink-3">{w.status === "online" ? `heartbeat ${relTime(w.lastHeartbeatAt)}` : w.lastHeartbeatAt ? `last seen ${relTime(w.lastHeartbeatAt)}` : "no heartbeat yet"} · token wk_{w.tokenPrefix}… · concurrency {w.maxConcurrency}{w.version ? ` · v${w.version}` : ""}</span>
                  {canEdit && w.status !== "revoked" ? <span className="ml-auto flex gap-1"><Button size="sm" variant="ghost" loading={busy === w.id} onClick={() => void rotate(w)}><RotateCcw size={13} /> Rotate token</Button><Button size="sm" variant="ghost" className="text-danger" onClick={() => setRevoke(w)}><Ban size={13} /> Revoke</Button></span> : null}
                </div>
                <p className="mt-1 text-[12.5px] text-ink-3">{assigned.length} account{assigned.length === 1 ? "" : "s"} assigned{assigned.length ? `: ${assigned.slice(0, 6).map((a) => `@${a.handle}`).join(", ")}${assigned.length > 6 ? ` +${assigned.length - 6}` : ""}` : ""}.{typeof w.hostInfo.hostname === "string" ? ` Host ${String(w.hostInfo.hostname)} (${String(w.hostInfo.platform ?? "")}).` : ""}</p>
                {caps.notes?.length ? <ul className="mt-1 list-disc pl-5 text-[12px] text-ink-3">{caps.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
              </li>
            );
          })}
          {workers.length === 0 ? <li className="px-4 py-6 text-[13px] text-ink-3">No workers yet. Add one to get a token for the Mac mini or a local simulator.</li> : null}
        </ul>
      </Card>
      <Card title="How workers connect">
        <div className="space-y-2 p-4 text-[13px] text-ink-2">
          <p>Workers make <strong>outbound</strong> HTTPS calls to <code className="rounded bg-surface-3 px-1">{appUrl}/api/worker/v1/*</code> with a scoped bearer token. No browser-debugging port or terminal is exposed to the internet. Tokens are shown once and stored hashed; revoke or rotate them here at any time.</p>
          <p>Each account has its own browser profile on the execution host (one profile per account) so sessions never mix. Before every post the worker reads the logged-in handle and Instagram user id and the server compares them with the approved account; a profile name alone never counts.</p>
          <p>{demoMode ? <span className="text-warn">Demo mode is on: only simulator workers receive jobs. Browser workers can connect and heartbeat but are refused jobs until DEMO_MODE=false.</span> : "Live mode: browser workers receive approved jobs."}</p>
          <p className="text-ink-3">Setup guide for the Mac mini: <code className="rounded bg-surface-3 px-1">docs/mac-worker.md</code> in the repository.</p>
        </div>
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="Add a worker" size="sm" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === "create"} disabled={!form.name.trim()} onClick={() => void create()}>Create and show token</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. mac-mini-office" autoFocus /></Field>
          <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}><option value="hermes_mac">Mac · Hermes browser (live, unverified until exercised)</option><option value="simulator">Simulator (demo only)</option></Select></Field>
          <Field label="Max concurrent posts" hint="Browser posting is sequential per account; keep this at 1 unless the host runs several browsers."><Input type="number" min={1} max={20} value={form.maxConcurrency} onChange={(e) => setForm({ ...form, maxConcurrency: e.target.value })} /></Field>
        </div>
      </Dialog>
      <Dialog open={token !== null} onOpenChange={(o) => !o && setToken(null)} title={`Token for “${token?.name}”`} size="md" footer={<Button variant="primary" onClick={() => setToken(null)}>I saved it</Button>}>
        <p className="mb-2 text-sm text-ink-2">Copy this now. It is shown once and only its hash is stored.</p>
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 p-2"><code className="min-w-0 flex-1 break-all text-[12px]">{token?.token}</code><Button size="icon" variant="ghost" aria-label="Copy token" onClick={() => token && void copy(token.token)}><Copy size={14} /></Button></div>
        <pre className="mt-3 overflow-x-auto rounded-md bg-ink p-3 text-[11.5px] text-canvas">{`# on the worker host (.env or environment)
APP_URL=${appUrl}
WORKER_TOKEN=${token?.token ?? ""}
WORKER_ADAPTER=${token?.kind === "simulator" ? "simulator" : "hermes"}
pnpm --filter @synthos/worker start`}</pre>
      </Dialog>
      <ConfirmDialog open={revoke !== null} onOpenChange={(o) => !o && setRevoke(null)} title={`Revoke “${revoke?.name}”?`} body="Its token stops working immediately. Any lease it holds expires and the jobs are handled by the scheduler (preparing → retried; submitting → marked unclear)." confirmLabel="Revoke" tone="danger" loading={busy === "revoke"} onConfirm={doRevoke} />
    </div>
  );
}
