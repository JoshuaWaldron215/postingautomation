"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, X } from "lucide-react";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox, Field, Input, Select, Switch } from "../ui/field";
import { useToast } from "../ui/toast";
import { useDirty } from "../shell/dirty-guard";
import { Avatar } from "../ui/avatar";
import { Thumb, AccountStatePill } from "../common/chips";
import { fmtDateTime, durationLabel } from "@/lib/format";
import { createCampaignAction, previewCampaignAction, updateCampaignAction, type CampaignFormInput } from "@/actions/campaigns";
import type { CampaignTemplate } from "@synthos/core/db/schema";
import { cn } from "../ui/cn";

type Props = {
  creators: Array<{ id: string; name: string; paused: boolean }>;
  accounts: Array<{ id: string; handle: string; creatorId: string; creatorName: string; timezone: string; avatarColor: string; state: string; workerName: string | null }>;
  assets: Array<{ id: string; name: string; caption: string; creatorId: string | null; thumbUrl: string | null; sourceOrder: number; durationSeconds: number | null }>;
  initial: { id: string; name: string; creatorId: string | null; startDate: string; endDate: string; template: CampaignTemplate; accountIds: string[]; assetIds: string[]; status: string } | null;
  defaultCreatorId?: string;
  defaultAccountIds: string[];
  closeHref: string;
  todayIso: string;
  minGapMinutes: number;
};

const DEMO_TEMPLATE: CampaignTemplate = { dayOne: { enabled: true, count: 3, spacingMinutes: 5, firstTime: "10:00" }, ongoing: { enabled: true, times: ["11:00", "18:00"] }, limits: { maxPostsPerAccount: null, maxPostsTotal: null } };
type Preview = { slots: Array<{ accountId: string; handle: string; plannedAt: string; timezone: string; isDayOne: boolean; sequence: number; assetId: string | null; assetName: string | null }>; conflicts: Array<{ accountId: string; handle: string; plannedAt: string; message: string; severity: "warning" | "error" }>; coverage: { needed: number; available: number; shortfallByAccount: Record<string, number> }; perAccount: Array<{ accountId: string; handle: string; timezone: string; slots: number; withContent: number; shortfall: number }> };

export function CampaignBuilder({ creators, accounts, assets, initial, defaultCreatorId, defaultAccountIds, closeHref, todayIso, minGapMinutes }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [name, setName] = React.useState(initial?.name ?? "");
  const [creatorId, setCreatorId] = React.useState(initial?.creatorId ?? defaultCreatorId ?? "");
  const [accountIds, setAccountIds] = React.useState<string[]>(initial?.accountIds ?? defaultAccountIds);
  const [assetIds, setAssetIds] = React.useState<string[]>(initial?.assetIds ?? []);
  const [startDate, setStartDate] = React.useState(initial?.startDate ?? todayIso);
  const [endDate, setEndDate] = React.useState(initial?.endDate ?? addDays(todayIso, 6));
  const [template, setTemplate] = React.useState<CampaignTemplate>(initial?.template ?? DEMO_TEMPLATE);
  const [assignment, setAssignment] = React.useState<"shared" | "unique">(((initial?.template as { assignment?: "shared" | "unique" } | undefined)?.assignment) ?? "shared");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [times, setTimes] = React.useState(template.ongoing.times.join(", "));
  const dirty = name !== (initial?.name ?? "") || accountIds.length > 0 || assetIds.length > 0;
  useDirty("campaign-builder", dirty);

  const creatorAccounts = accounts.filter((a) => !creatorId || a.creatorId === creatorId);
  const creatorAssets = assets.filter((a) => !creatorId || a.creatorId === creatorId || a.creatorId === null).sort((a, b) => a.sourceOrder - b.sourceOrder);
  const chosenAssets = assetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const input = (): CampaignFormInput => ({ name, creatorId: creatorId || null, startDate, endDate, template: { ...template, ongoing: { ...template.ongoing, times: times.split(",").map((s) => s.trim()).filter(Boolean) } }, accountIds, assetIds, assignment });

  const loadPreview = async () => {
    setBusy(true);
    setPreviewError(null);
    const r = await previewCampaignAction(input(), initial?.id);
    setBusy(false);
    if (!r.ok) { setPreview(null); setPreviewError(r.error); return; }
    setPreview(r.data as Preview);
  };

  const save = async () => {
    setBusy(true);
    const r = initial ? await updateCampaignAction(initial.id, input()) : await createCampaignAction(input());
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    const id = initial ? initial.id : (r.data as { id: string }).id;
    toast.push({ tone: "ok", title: initial ? "Campaign updated" : "Campaign created", body: "Review it and approve once to start automatic posting." });
    router.push(`/schedule?campaign=${id}`);
    router.refresh();
  };
  const move = (id: string, dir: -1 | 1) => setAssetIds((ids) => { const i = ids.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return ids; const n = [...ids]; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const canNext = step === 1 ? name.trim() && accountIds.length > 0 : step === 2 ? assetIds.length > 0 && startDate && endDate && endDate >= startDate : true;
  const errors = preview?.conflicts.filter((c) => c.severity === "error") ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && router.push(closeHref)} title={initial ? `Edit “${initial.name}”` : "New campaign"} size="xl" description={<span>Step {step} of 3 · {step === 1 ? "Who posts" : step === 2 ? "What and when" : "Review the plan"}</span>}
      footer={<>
        {step > 1 ? <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>Back</Button> : null}
        <Button variant="ghost" onClick={() => router.push(closeHref)}>Cancel</Button>
        {step < 3 ? <Button variant="primary" disabled={!canNext} onClick={() => { const next = (step + 1) as 1 | 2 | 3; setStep(next); if (next === 3) void loadPreview(); }}>Continue</Button> : <Button variant="primary" loading={busy} disabled={!preview || errors.length > 0} onClick={() => void save()}>{initial ? "Save changes" : "Create campaign"}</Button>}
      </>}
    >
      {initial && ["approved", "paused"].includes(initial.status) ? <p className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> This campaign is approved. Saving changes blocks its pending posts until you approve it again.</p> : null}
      {step === 1 ? (
        <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
          <div className="space-y-3">
            <Field label="Campaign name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya · October launch" autoFocus /></Field>
            <Field label="Creator" hint="Filters the accounts and content you can pick.">
              <Select value={creatorId} onChange={(e) => { setCreatorId(e.target.value); setAccountIds([]); setAssetIds([]); }}>
                <option value="">Any creator</option>
                {creators.map((c) => <option key={c.id} value={c.id}>{c.name}{c.paused ? " (paused)" : ""}</option>)}
              </Select>
            </Field>
            <p className="text-[12px] text-ink-3">{accountIds.length} account{accountIds.length === 1 ? "" : "s"} selected. Accounts without a worker or needing a login can be included; their posts wait until they are ready.</p>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between"><span className="text-[12px] font-medium text-ink-2">Accounts</span><button className="text-[12px] text-accent hover:underline" onClick={() => setAccountIds(accountIds.length === creatorAccounts.length ? [] : creatorAccounts.map((a) => a.id))}>{accountIds.length === creatorAccounts.length ? "Clear all" : `Select all ${creatorAccounts.length}`}</button></div>
            <ul className="scroll-thin max-h-[360px] divide-y divide-line overflow-y-auto rounded-md border border-line">
              {creatorAccounts.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 hover:bg-surface-2">
                    <Checkbox checked={accountIds.includes(a.id)} onChange={(e) => setAccountIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))} />
                    <Avatar handle={a.handle} color={a.avatarColor} size={22} />
                    <span className="min-w-0 flex-1 truncate text-[13px]"><span className="font-medium">@{a.handle}</span> <span className="text-ink-3">{a.creatorName} · {a.timezone}</span></span>
                    <AccountStatePill state={a.state} />
                  </label>
                </li>
              ))}
              {creatorAccounts.length === 0 ? <li className="px-3 py-4 text-[13px] text-ink-3">No accounts for this creator.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
              <Field label="End date (finite)" error={endDate < startDate ? "End must be on or after the start." : null}><Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
            </div>
            <div className="rounded-md border border-line p-3">
              <div className="flex items-center justify-between"><span className="text-[13px] font-medium">Day-one template</span><Switch checked={template.dayOne.enabled} onChange={(v) => setTemplate((t) => ({ ...t, dayOne: { ...t.dayOne, enabled: v } }))} label="Day-one posts" /></div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Field label="Posts"><Input type="number" min={1} max={10} value={template.dayOne.count} onChange={(e) => setTemplate((t) => ({ ...t, dayOne: { ...t.dayOne, count: Number(e.target.value) } }))} disabled={!template.dayOne.enabled} /></Field>
                <Field label="Min apart"><Input type="number" min={1} value={template.dayOne.spacingMinutes} onChange={(e) => setTemplate((t) => ({ ...t, dayOne: { ...t.dayOne, spacingMinutes: Number(e.target.value) } }))} disabled={!template.dayOne.enabled} /></Field>
                <Field label="First at"><Input type="time" value={template.dayOne.firstTime} onChange={(e) => setTemplate((t) => ({ ...t, dayOne: { ...t.dayOne, firstTime: e.target.value } }))} disabled={!template.dayOne.enabled} /></Field>
              </div>
              <p className="mt-1 text-[11.5px] text-ink-4">Planned {template.dayOne.spacingMinutes} min apart; actual publications keep at least {minGapMinutes} min between them and show as late if delayed.</p>
            </div>
            <div className="rounded-md border border-line p-3">
              <div className="flex items-center justify-between"><span className="text-[13px] font-medium">Ongoing template</span><Switch checked={template.ongoing.enabled} onChange={(v) => setTemplate((t) => ({ ...t, ongoing: { ...t.ongoing, enabled: v } }))} label="Ongoing posts" /></div>
              <Field label="Daily times (local to each account)" hint="Demo default 11:00, 18:00. Replace with the client's real times before going live." className="mt-2"><Input value={times} onChange={(e) => setTimes(e.target.value)} disabled={!template.ongoing.enabled} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max posts per account" hint="Blank = no cap"><Input type="number" min={1} value={template.limits.maxPostsPerAccount ?? ""} onChange={(e) => setTemplate((t) => ({ ...t, limits: { ...t.limits, maxPostsPerAccount: e.target.value ? Number(e.target.value) : null } }))} /></Field>
              <Field label="Max posts total" hint="Blank = no cap"><Input type="number" min={1} value={template.limits.maxPostsTotal ?? ""} onChange={(e) => setTemplate((t) => ({ ...t, limits: { ...t.limits, maxPostsTotal: e.target.value ? Number(e.target.value) : null } }))} /></Field>
            </div>
            <Field label="How content is dealt out">
              <Select value={assignment} onChange={(e) => setAssignment(e.target.value as "shared" | "unique")}>
                <option value="shared">Every account posts the same list in order</option>
                <option value="unique">Each video is posted once, dealt across accounts</option>
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-2">Videos, in posting order ({assetIds.length} chosen)</p>
            {chosenAssets.length ? (
              <ol className="mb-3 divide-y divide-line rounded-md border border-line">
                {chosenAssets.map((a, i) => (
                  <li key={a.id} className="flex items-center gap-2 px-2 py-1.5 text-[12.5px]">
                    <span className="tabular w-5 text-ink-4">{i + 1}</span>
                    <Thumb src={a.thumbUrl} alt="" className="w-6" />
                    <span className="min-w-0 flex-1 truncate">{a.name}{!a.caption.trim() ? <span className="ml-1 text-warn">· no caption</span> : null}</span>
                    <Button size="icon" variant="ghost" aria-label="Move up" onClick={() => move(a.id, -1)} disabled={i === 0}><ArrowUp size={13} /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" onClick={() => move(a.id, 1)} disabled={i === chosenAssets.length - 1}><ArrowDown size={13} /></Button>
                    <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setAssetIds((ids) => ids.filter((x) => x !== a.id))}><X size={13} /></Button>
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="mb-1.5 text-[12px] text-ink-3">Ready videos {creatorId ? "for this creator (and unassigned)" : ""}</p>
            <ul className="scroll-thin grid max-h-[300px] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {creatorAssets.filter((a) => !assetIds.includes(a.id)).map((a) => (
                <li key={a.id}>
                  <button onClick={() => setAssetIds((ids) => [...ids, a.id])} className="block w-full rounded-md border border-line p-1 text-left hover:border-accent">
                    <span className="relative block"><Thumb src={a.thumbUrl} alt="" className="w-full" /><span className="tabular absolute bottom-1 right-1 rounded bg-ink/70 px-1 text-[10px] text-white">{durationLabel(a.durationSeconds)}</span></span>
                    <span className="mt-1 block truncate text-[11px]">{a.name}</span>
                  </button>
                </li>
              ))}
              {creatorAssets.length === 0 ? <li className="col-span-full text-[12.5px] text-ink-3">No ready videos yet. Upload some in Content first.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
      {step === 3 ? (
        <div>
          {busy && !preview ? <p className="text-sm text-ink-3">Building the plan…</p> : null}
          {previewError ? <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{previewError}</p> : null}
          {preview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3 text-[13px]">
                <div className="rounded-md border border-line p-3"><p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Planned posts</p><p className="mt-1 text-xl font-semibold tabular">{preview.slots.length}</p><p className="text-ink-3">{accountIds.length} account{accountIds.length === 1 ? "" : "s"}, {startDate} → {endDate}</p></div>
                <div className={cn("rounded-md border p-3", preview.coverage.needed > 0 && Object.keys(preview.coverage.shortfallByAccount).length ? "border-warn/40 bg-warn-soft" : "border-line")}><p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Content coverage</p><p className="mt-1 text-xl font-semibold tabular">{preview.slots.filter((s) => s.assetId).length} <span className="text-sm font-normal text-ink-3">of {preview.slots.length} slots have a video</span></p>{Object.keys(preview.coverage.shortfallByAccount).length ? <p className="text-warn">{Object.keys(preview.coverage.shortfallByAccount).length} account(s) run out; those slots are held, never recycled.</p> : <p className="text-ink-3">Every slot has content.</p>}</div>
                <div className={cn("rounded-md border p-3", errors.length ? "border-danger/40 bg-danger-soft" : preview.conflicts.length ? "border-warn/40 bg-warn-soft" : "border-line")}><p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Conflicts</p><p className="mt-1 text-xl font-semibold tabular">{preview.conflicts.length}</p><p className="text-ink-3">{errors.length ? `${errors.length} collide with existing scheduled posts` : preview.conflicts.length ? "Only spacing warnings" : "None"}</p></div>
              </div>
              {preview.conflicts.length ? <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-[12.5px]">{preview.conflicts.slice(0, 20).map((c, i) => <li key={i} className={c.severity === "error" ? "text-danger" : "text-warn"}>@{c.handle} · {fmtDateTime(c.plannedAt)}: {c.message}</li>)}</ul> : null}
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full min-w-[640px] text-[12.5px]">
                  <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3"><tr><th className="px-2 py-1.5">Account</th><th className="px-2 py-1.5">Timezone</th><th className="px-2 py-1.5 text-right">Slots</th><th className="px-2 py-1.5 text-right">With video</th><th className="px-2 py-1.5">First post</th><th className="px-2 py-1.5">Last post</th></tr></thead>
                  <tbody>
                    {preview.perAccount.map((p) => { const mine = preview.slots.filter((s) => s.accountId === p.accountId); return (
                      <tr key={p.accountId} className="border-t border-line"><td className="px-2 py-1.5 font-medium">@{p.handle}</td><td className="px-2 py-1.5 text-ink-3">{p.timezone}</td><td className="tabular px-2 py-1.5 text-right">{p.slots}</td><td className={cn("tabular px-2 py-1.5 text-right", p.shortfall ? "text-warn" : "")}>{p.withContent}{p.shortfall ? ` (${p.shortfall} short)` : ""}</td><td className="px-2 py-1.5">{mine[0] ? fmtDateTime(mine[0].plannedAt, p.timezone) : "—"}</td><td className="px-2 py-1.5">{mine.length ? fmtDateTime(mine[mine.length - 1]!.plannedAt, p.timezone) : "—"}</td></tr>
                    ); })}
                  </tbody>
                </table>
              </div>
              <p className="text-[12px] text-ink-3">Creating the campaign does not post anything. Next you review it and approve once; that approval authorizes the worker to publish these posts automatically.</p>
              <Badge tone="neutral">Times are planned times. Actual publication keeps at least {minGapMinutes} min between posts on the same account.</Badge>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
