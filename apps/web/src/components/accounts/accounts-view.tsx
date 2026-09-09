"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Pin, Search, Pause, Play, X } from "lucide-react";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox, Input, Select } from "../ui/field";
import { SegmentedTabs } from "../ui/tabs";
import { EmptyState } from "../ui/empty";
import { Dialog } from "../ui/dialog";
import { Field } from "../ui/field";
import { useToast } from "../ui/toast";
import { AccountStatePill, ExecutionLabel } from "../common/chips";
import { fmtDateTime, tzShort } from "@/lib/format";
import { pauseAccountsAction, resumeAccountsAction, pauseCreatorAction, resumeCreatorAction } from "@/actions/accounts";
import { cn } from "../ui/cn";

export type AccountListRow = {
  id: string;
  handle: string;
  displayName: string;
  creatorId: string;
  creatorName: string;
  creatorColor: string;
  creatorPausedAt: Date | null;
  avatarColor: string;
  effectiveState: string;
  stateExplanation: string;
  needsAttention: boolean;
  executionRoute: string;
  workerName: string | null;
  timezone: string;
  nextScheduledAt: string | null;
  lastVerifiedPostAt: string | null;
  approvedRemaining: number;
  heldForContent: number;
  openExceptions: number;
  pausedAt: Date | null;
  pinned: boolean;
};

type Props = {
  rows: AccountListRow[];
  creators: Array<{ id: string; name: string; color: string; paused: boolean; pausedReason: string | null; accountCount: number }>;
  workers: Array<{ id: string; name: string; status: string; kind: string }>;
  stateCounts: Record<string, number>;
  role: string;
  selectedId: string | null;
  filterKey: string;
};

const STATE_OPTIONS = [
  { value: "", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "ready", label: "Ready" },
  { value: "needs_login", label: "Needs login" },
  { value: "needs_review", label: "Needs review" },
  { value: "paused", label: "Paused" },
  { value: "offline", label: "Worker offline" },
  { value: "unassigned", label: "No worker" },
];

export function AccountsView({ rows, creators, workers, stateCounts, role, selectedId, filterKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // Bulk selection is scoped to the filter key: the page remounts this view (key={filterKey}) when filters change,
  // so a selection can never carry an action into a different scope.
  void filterKey;

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    p.delete("account");
    router.push(`${pathname}?${p.toString()}`);
  };
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("q", value || null), 250);
  };

  const stateFilter = params.get("attention") === "1" ? "attention" : (params.get("state") ?? "");
  const grouped = React.useMemo(() => {
    const map = new Map<string, AccountListRow[]>();
    for (const r of rows) map.set(r.creatorId, [...(map.get(r.creatorId) ?? []), r]);
    return [...map.entries()].map(([creatorId, list]) => ({ creator: creators.find((c) => c.id === creatorId), list }));
  }, [rows, creators]);
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const bulk = async (action: "pause" | "resume") => {
    setBusy(true);
    const ids = [...selected].filter((id) => rows.some((r) => r.id === id));
    const r = action === "pause" ? await pauseAccountsAction(ids, reason) : await resumeAccountsAction(ids);
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: `${r.data} account${r.data === 1 ? "" : "s"} ${action === "pause" ? "paused" : "resumed"}`, body: action === "pause" ? "No new posts will start on them. A post already in progress finishes." : "Overdue posts will publish in order with the minimum spacing." });
    setSelected(new Set());
    setPauseOpen(false);
    setReason("");
    router.refresh();
  };
  const creatorToggle = async (c: { id: string; name: string; paused: boolean }) => {
    const r = c.paused ? await resumeCreatorAction(c.id) : await pauseCreatorAction(c.id);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: `${c.name} ${c.paused ? "resumed" : "paused"}` });
    router.refresh();
  };
  const open = (id: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("account", id);
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search @handle, name or creator" className="pl-8" aria-label="Search accounts" />
        </div>
        <SegmentedTabs ariaLabel="Filter by state" size="sm" value={stateFilter} onChange={(v) => { const p = new URLSearchParams(params.toString()); p.delete("attention"); p.delete("state"); p.delete("account"); if (v === "attention") p.set("attention", "1"); else if (v) p.set("state", v); router.push(`${pathname}?${p.toString()}`); }} options={STATE_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: o.value === "attention" ? rows.filter((r) => r.needsAttention).length : o.value ? stateCounts[o.value] : undefined }))} />
        <button onClick={() => setParam("pinned", params.get("pinned") === "1" ? null : "1")} aria-pressed={params.get("pinned") === "1"} className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium", params.get("pinned") === "1" ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong text-ink-2 hover:bg-surface-2")}>
          <Pin size={12} /> Pinned
        </button>
        <Select aria-label="Worker" value={params.get("worker") ?? ""} onChange={(e) => setParam("worker", e.target.value || null)} inline className="h-7 py-0 text-[12px]">
          <option value="">Any worker</option>
          {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Select aria-label="Sort" value={params.get("sort") ?? "creator"} onChange={(e) => setParam("sort", e.target.value)} inline className="h-7 py-0 text-[12px]">
          <option value="creator">By creator</option>
          <option value="handle">By handle</option>
          <option value="state">Attention first</option>
          <option value="next">Next post</option>
        </Select>
      </div>

      {selected.size > 0 && canEdit ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm fade-in" role="region" aria-label="Bulk actions">
          <span className="font-medium text-accent-ink">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setPauseOpen(true)}><Pause size={13} /> Pause</Button>
          <Button size="sm" variant="outline" loading={busy} onClick={() => void bulk("resume")}><Play size={13} /> Resume</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}><X size={13} /> Clear</Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title="No accounts match" body={q ? `Nothing matches “${q}”. Try a handle like @maya.fit or a creator name.` : "Change the filter, or add accounts from Settings."} action={q ? <Button onClick={() => onSearch("")}>Clear search</Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="hidden grid-cols-[28px_minmax(180px,1.6fr)_120px_minmax(150px,1.4fr)_120px_110px_90px] items-center gap-3 border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3 md:grid">
            <span>{canEdit ? <Checkbox aria-label="Select all" checked={allChecked} onChange={toggleAll} /> : null}</span>
            <span>Account</span>
            <span>State</span>
            <span>Why</span>
            <span>Next post</span>
            <span>Approved left</span>
            <span>Route</span>
          </div>
          {grouped.map(({ creator, list }) => (
            <div key={creator?.id ?? "none"}>
              <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: creator?.color }} aria-hidden />
                <span className="text-[12.5px] font-semibold text-ink">{creator?.name}</span>
                <span className="tabular text-[12px] text-ink-4">{list.length}</span>
                {creator?.paused ? <Badge tone="neutral">Creator paused{creator.pausedReason ? ` · ${creator.pausedReason}` : ""}</Badge> : null}
                {canEdit && creator ? <button className="ml-auto text-[12px] text-accent hover:underline" onClick={() => void creatorToggle(creator)}>{creator.paused ? "Resume creator" : "Pause creator"}</button> : null}
              </div>
              <ul>
                {list.map((a) => (
                  <li key={a.id} className={cn("group grid grid-cols-[28px_1fr] items-center gap-3 border-b border-line px-3 py-2 last:border-0 md:grid-cols-[28px_minmax(180px,1.6fr)_120px_minmax(150px,1.4fr)_120px_110px_90px]", selectedId === a.id ? "bg-accent-soft/60" : "hover:bg-surface-2")}>
                    <span>{canEdit ? <Checkbox aria-label={`Select @${a.handle}`} checked={selected.has(a.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} /> : null}</span>
                    <button onClick={() => open(a.id)} className="flex min-w-0 items-center gap-2.5 text-left" aria-label={`Open @${a.handle}`}>
                      <Avatar handle={a.handle} color={a.avatarColor} size={30} />
                      <span className="min-w-0 leading-tight">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-ink">@{a.handle}</span>
                          {a.pinned ? <Pin size={11} className="shrink-0 text-ink-4" /> : null}
                        </span>
                        <span className="block truncate text-[12px] text-ink-3">{a.displayName} · {tzShort(a.timezone)}</span>
                      </span>
                    </button>
                    <div className="col-start-2 flex flex-wrap items-center gap-2 md:col-start-auto md:block">
                      <AccountStatePill state={a.effectiveState} />
                      <span className="text-[12px] text-ink-3 md:hidden">{a.stateExplanation}</span>
                    </div>
                    <span className="hidden truncate text-[12.5px] text-ink-3 md:block" title={a.stateExplanation}>{a.stateExplanation}</span>
                    <span className="hidden text-[12.5px] text-ink-2 md:block">{a.nextScheduledAt ? fmtDateTime(a.nextScheduledAt, a.timezone) : <span className="text-ink-4">—</span>}</span>
                    <span className="hidden text-[12.5px] md:block">
                      <span className={cn("tabular font-medium", a.approvedRemaining === 0 ? "text-ink-4" : "text-ink")}>{a.approvedRemaining}</span>
                      {a.heldForContent ? <span className="ml-1 text-warn">+{a.heldForContent} empty</span> : null}
                    </span>
                    <span className="hidden md:block"><ExecutionLabel route={a.executionRoute} /></span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[12px] text-ink-4">Last verified post and next scheduled post are shown in each account&apos;s own timezone. {rows.length ? <Link href="/schedule" className="text-accent hover:underline">Open the schedule</Link> : null}</p>
      <Dialog open={pauseOpen} onOpenChange={setPauseOpen} title={`Pause ${selected.size} account${selected.size === 1 ? "" : "s"}?`} size="sm" footer={<><Button variant="ghost" onClick={() => setPauseOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => void bulk("pause")}>Pause</Button></>}>
        <p className="mb-3 text-sm text-ink-2">No new posts will start on these accounts. A post already being published finishes and is verified. Nothing already on Instagram is affected.</p>
        <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. creator travelling this week" /></Field>
      </Dialog>
    </div>
  );
}
