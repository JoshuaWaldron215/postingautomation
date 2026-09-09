"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Send, Trash2 } from "lucide-react";
import { Card } from "../common/page-header";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog, ConfirmDialog } from "../ui/dialog";
import { Field, Input, Select, Switch } from "../ui/field";
import { useToast } from "../ui/toast";
import { relTime } from "@/lib/format";
import { createChannelAction, deleteChannelAction, testChannelAction, updateChannelAction } from "@/actions/notifications";

type Ch = { id: string; name: string; destinationLabel: string; enabled: boolean; verifiedAt: string | null; lastTestAt: string | null; lastTestResult: string | null; settings: { exceptionsImmediate: boolean; successIndividual: boolean; analyticsIndividual: boolean; digest: "off" | "daily"; digestTime: string } };

export function ChannelsView({ channels, role }: { channels: Ch[]; role: string }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role === "owner";
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", webhookUrl: "" });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [del, setDel] = React.useState<Ch | null>(null);
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, title: string) => { setBusy(key); const r = await fn(); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error ?? "Failed" }); toast.push({ tone: "ok", title }); router.refresh(); return r; };
  const test = async (c: Ch) => { setBusy(`test-${c.id}`); const r = await testChannelAction(c.id); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); if (r.data.ok) toast.push({ tone: "ok", title: "Test message delivered", body: "You can now enable delivery." }); else toast.push({ tone: "danger", title: "Test failed", body: r.data.error }); router.refresh(); };
  if (role === "viewer") return <Card><p className="p-4 text-[13px] text-ink-3">Only owners and operators can see notification destinations.</p></Card>;
  return (
    <div className="space-y-4">
      <Card title="In-app notifications">
        <p className="p-4 text-[13px] text-ink-2">Every event is stored in the app and shown under the bell: post verified live, 10-hour report complete, login required, unclear result, content shortage, worker offline and missed schedule or analytics checkpoints. Events are deduplicated by a stable id, so a retry never creates a second alert.</p>
      </Card>
      <Card title="Discord delivery" action={canEdit ? <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add webhook</Button> : null}>
        {channels.length === 0 ? <p className="p-4 text-[13px] text-ink-3">No destinations. External delivery stays off until an owner adds a webhook and a labeled test succeeds.</p> : (
          <ul className="divide-y divide-line">
            {channels.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold">{c.name}</span>
                  <code className="rounded bg-surface-3 px-1 text-[11.5px]">{c.destinationLabel}</code>
                  {c.verifiedAt ? <Badge tone="ok">Test passed {relTime(c.verifiedAt)}</Badge> : <Badge tone="warn">Not tested</Badge>}
                  <Badge tone={c.enabled ? "ok" : "neutral"}>{c.enabled ? "Delivering" : "Delivery off"}</Badge>
                  {canEdit ? <span className="ml-auto flex items-center gap-2"><Button size="sm" variant="outline" loading={busy === `test-${c.id}`} onClick={() => void test(c)}><Send size={13} /> Send test</Button><span className="flex items-center gap-1.5 text-[12.5px]"><Switch checked={c.enabled} disabled={!c.verifiedAt || busy === `en-${c.id}`} onChange={(v) => void run(`en-${c.id}`, () => updateChannelAction(c.id, { enabled: v }), v ? "Delivery enabled" : "Delivery disabled")} label="Enable delivery" />Enabled</span><Button size="icon" variant="ghost" aria-label="Remove destination" className="text-danger" onClick={() => setDel(c)}><Trash2 size={14} /></Button></span> : null}
                </div>
                {c.lastTestAt ? <p className="mt-1 text-[12px] text-ink-3">Last test {relTime(c.lastTestAt)}: {c.lastTestResult === "ok" ? "delivered" : c.lastTestResult}</p> : null}
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <Toggle label="Exceptions immediately" checked={c.settings.exceptionsImmediate} disabled={!canEdit} onChange={(v) => void run(`s-${c.id}`, () => updateChannelAction(c.id, { settings: { exceptionsImmediate: v } }), "Saved")} />
                  <Toggle label="Each verified post" checked={c.settings.successIndividual} disabled={!canEdit} onChange={(v) => void run(`s-${c.id}`, () => updateChannelAction(c.id, { settings: { successIndividual: v } }), "Saved")} />
                  <Toggle label="Each 10-hour report" checked={c.settings.analyticsIndividual} disabled={!canEdit} onChange={(v) => void run(`s-${c.id}`, () => updateChannelAction(c.id, { settings: { analyticsIndividual: v } }), "Saved")} />
                  <div className="flex items-center gap-2 text-[12.5px]"><span>Daily digest</span><Select inline className="h-7 py-0 text-[12px]" value={c.settings.digest} disabled={!canEdit} onChange={(e) => void run(`s-${c.id}`, () => updateChannelAction(c.id, { settings: { digest: e.target.value as "off" | "daily" } }), "Saved")}><option value="off">off</option><option value="daily">daily {c.settings.digestTime}</option></Select></div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3">Webhook URLs are encrypted at rest and never logged or returned to the browser. “Queued” is not “delivered”: each delivery attempt and its error are recorded, with bounded retries. A failed delivery never retries a post.</p>
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="Add a Discord webhook" size="sm" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === "create"} disabled={!form.name.trim() || !form.webhookUrl.trim()} onClick={() => void run("create", () => createChannelAction(form), "Destination added — send a test next").then((r) => { if (r?.ok) { setOpen(false); setForm({ name: "", webhookUrl: "" }); } })}>Add</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. #ops-alerts" autoFocus /></Field>
          <Field label="Webhook URL" hint="Only https://discord.com/api/webhooks/… is accepted."><Input value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" type="url" /></Field>
        </div>
      </Dialog>
      <ConfirmDialog open={del !== null} onOpenChange={(o) => !o && setDel(null)} title={`Remove “${del?.name}”?`} body="Pending deliveries to it are dropped." confirmLabel="Remove" tone="danger" loading={busy === "del"} onConfirm={() => void run("del", () => deleteChannelAction(del!.id), "Destination removed").then(() => setDel(null))} />
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="flex items-center gap-2 text-[12.5px]"><Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />{label}</label>;
}
