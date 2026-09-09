"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, CalendarDays, List } from "lucide-react";
import { Button } from "../ui/button";
import { Badge, CAMPAIGN_LABEL, CAMPAIGN_TONE } from "../ui/badge";
import { SegmentedTabs } from "../ui/tabs";
import { EmptyState } from "../ui/empty";
import { Checkbox } from "../ui/field";
import { useToast } from "../ui/toast";
import { AccountChip, JobStatePill, Thumb } from "../common/chips";
import { fmtTime, fmtDateTime, relTime } from "@/lib/format";
import { cancelJobAction, holdJobAction } from "@/actions/jobs";
import { cn } from "../ui/cn";

export type JobLite = { id: string; state: string; plannedAt: string; plannedTimezone: string; notBefore: string | null; publishedAt: string | null; stateReason: string | null; errorCategory: string | null; errorMessage: string | null; attemptCount: number; maxAttempts: number; handle: string; avatarColor: string; creatorId: string; creatorName: string; campaignId: string; campaignName: string; assetName: string | null; thumbUrl: string | null; postUrl: string | null; isDayOne: boolean; sequence: number; approved: boolean; accountId: string; workerName: string | null; assetId: string | null };
export type CampaignLite = { id: string; name: string; status: string; creatorName: string | null; startDate: string; endDate: string; accountCount: number; jobCounts: Record<string, number>; approvedByName: string | null; approvedAt: string | null; reapprovalReason: string | null; pausedReason: string | null };

type Props = { jobs: JobLite[]; campaigns: CampaignLite[]; view: "calendar" | "list"; anchorIso: string; nowIso: string; displayTz: string; role: string; selectedJobId: string | null; selectedCampaignId: string | null; filterKey: string; minGapMinutes: number };

const STATE_FILTERS = [
  { value: "", label: "All" },
  { value: "exceptions", label: "Needs a decision" },
  { value: "READY", label: "Ready" },
  { value: "QUEUED", label: "Scheduled" },
  { value: "HELD", label: "On hold" },
  { value: "VERIFIED_PUBLISHED", label: "Verified" },
];

function dayKey(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function ScheduleView({ jobs, campaigns, view, anchorIso, nowIso, displayTz, role, selectedJobId, selectedCampaignId, filterKey, minGapMinutes }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  void filterKey; // remounted by the page with key={filterKey}
  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    p.delete("job");
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const openJob = (id: string) => { const p = new URLSearchParams(params.toString()); p.set("job", id); router.push(`${pathname}?${p.toString()}`, { scroll: false }); };
  const now = React.useMemo(() => new Date(nowIso), [nowIso]);
  const anchor = React.useMemo(() => new Date(anchorIso), [anchorIso]);
  const todayKey = dayKey(nowIso, displayTz);
  const stateFilter = params.get("state") ?? "";

  // Calendar: 14 days starting from the Monday before the anchor.
  const days = React.useMemo(() => {
    const start = new Date(anchor);
    start.setUTCHours(12, 0, 0, 0);
    const dow = new Date(dayKey(start.toISOString(), displayTz) + "T12:00:00Z").getUTCDay();
    start.setUTCDate(start.getUTCDate() - ((dow + 6) % 7));
    return Array.from({ length: 14 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return dayKey(d.toISOString(), displayTz); });
  }, [anchor, displayTz]);
  const byDay = React.useMemo(() => {
    const m = new Map<string, JobLite[]>();
    for (const j of jobs) { const k = dayKey(j.plannedAt, displayTz); m.set(k, [...(m.get(k) ?? []), j]); }
    for (const list of m.values()) list.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));
    return m;
  }, [jobs, displayTz]);
  const shift = (daysDelta: number) => { const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + daysDelta); setParam({ date: d.toISOString().slice(0, 10) }); };

  const bulk = async (action: "hold" | "cancel") => {
    setBusy(action);
    const ids = [...selected].filter((id) => jobs.some((j) => j.id === id));
    let ok = 0; let firstError: string | null = null;
    for (const id of ids) { const r = action === "hold" ? await holdJobAction(id, "Held in bulk") : await cancelJobAction(id); if (r.ok) ok++; else firstError ??= r.error; }
    setBusy(null);
    toast.push({ tone: firstError ? "danger" : "ok", title: `${ok} post${ok === 1 ? "" : "s"} ${action === "hold" ? "held" : "cancelled"}`, body: firstError ?? undefined });
    setSelected(new Set());
    router.refresh();
  };
  const activeCampaigns = campaigns.filter((c) => !["completed", "cancelled"].includes(c.status));
  const pendingApproval = campaigns.filter((c) => c.status === "draft" || c.status === "needs_reapproval");
  const sortedList = [...jobs].sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));

  return (
    <div>
      {/* Campaign strip */}
      <div className="mb-4 rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">Campaigns {pendingApproval.length ? <Badge tone="warn" className="ml-1">{pendingApproval.length} awaiting approval</Badge> : null}</h2>
          <div className="flex items-center gap-2">
            {selectedCampaignId ? <button className="text-[12px] text-accent hover:underline" onClick={() => setParam({ campaign: null })}>Show all campaigns</button> : null}
            {canEdit ? <Button size="sm" variant="primary" onClick={() => setParam({ new: "1" })}><Plus size={14} /> New campaign</Button> : null}
          </div>
        </div>
        {activeCampaigns.length === 0 ? <div className="p-4"><EmptyState compact title="No active campaigns" body="A campaign defines which accounts post which videos on which schedule. Approve it once and the worker publishes automatically." action={canEdit ? <Button variant="primary" onClick={() => setParam({ new: "1" })}><Plus size={14} /> New campaign</Button> : undefined} /></div> : (
          <ul className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {activeCampaigns.map((c) => {
              const total = Object.values(c.jobCounts).reduce((s, n) => s + n, 0);
              const done = c.jobCounts.VERIFIED_PUBLISHED ?? 0;
              const exceptions = (c.jobCounts.BLOCKED ?? 0) + (c.jobCounts.FAILED ?? 0) + (c.jobCounts.UNKNOWN_OUTCOME ?? 0);
              const held = c.jobCounts.HELD ?? 0;
              return (
                <li key={c.id} className={cn("bg-surface p-3", selectedCampaignId === c.id && "bg-accent-soft/50")}>
                  <div className="flex items-start justify-between gap-2">
                    <button className="min-w-0 text-left" onClick={() => setParam({ campaign: selectedCampaignId === c.id ? null : c.id })}>
                      <p className="truncate text-[13.5px] font-semibold hover:underline">{c.name}</p>
                      <p className="text-[12px] text-ink-3">{c.creatorName ?? "Multiple creators"} · {c.accountCount} account{c.accountCount === 1 ? "" : "s"} · {c.startDate} → {c.endDate}</p>
                    </button>
                    <Badge tone={CAMPAIGN_TONE[c.status] ?? "neutral"}>{CAMPAIGN_LABEL[c.status] ?? c.status}</Badge>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full bg-ok" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
                  <p className="mt-1 text-[12px] text-ink-3 tabular">{done} of {total} verified{exceptions ? <span className="text-danger"> · {exceptions} need a decision</span> : null}{held ? <span className="text-warn"> · {held} held</span> : null}</p>
                  {c.status === "needs_reapproval" && c.reapprovalReason ? <p className="mt-1 text-[12px] text-danger">Blocked because {c.reapprovalReason}.</p> : null}
                  {c.status === "paused" && c.pausedReason ? <p className="mt-1 text-[12px] text-ink-3">Paused: {c.pausedReason}</p> : null}
                  {(c.status === "draft" || c.status === "needs_reapproval") && canEdit ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="primary" loading={busy === c.id} onClick={() => setParam({ campaign: c.id })}>Review &amp; approve</Button>
                      <button className="text-[12px] text-accent hover:underline" onClick={() => setParam({ edit: c.id })}>Edit</button>
                    </div>
                  ) : c.approvedByName ? <p className="mt-1 text-[11.5px] text-ink-4">Approved by {c.approvedByName} {c.approvedAt ? relTime(c.approvedAt, now) : ""}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs ariaLabel="View" size="sm" value={view} onChange={(v) => setParam({ view: v === "list" ? "list" : null })} options={[{ value: "calendar", label: <span className="inline-flex items-center gap-1"><CalendarDays size={13} /> Calendar</span> }, { value: "list", label: <span className="inline-flex items-center gap-1"><List size={13} /> List</span> }]} />
        <SegmentedTabs ariaLabel="State" size="sm" value={stateFilter} onChange={(v) => setParam({ state: v || null, category: null })} options={STATE_FILTERS.map((s) => ({ value: s.value, label: s.label }))} />
        {params.get("category") ? <Badge tone="danger">{params.get("category")} <button className="ml-1" onClick={() => setParam({ category: null })} aria-label="Clear category filter">×</button></Badge> : null}
        {view === "calendar" ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Previous week" onClick={() => shift(-7)}><ChevronLeft size={16} /></Button>
            <Button size="sm" variant="ghost" onClick={() => setParam({ date: null })}>Today</Button>
            <Button size="icon" variant="ghost" aria-label="Next week" onClick={() => shift(7)}><ChevronRight size={16} /></Button>
          </div>
        ) : null}
      </div>

      {selected.size > 0 && canEdit ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm fade-in" role="region" aria-label="Bulk actions">
          <span className="font-medium text-accent-ink">{selected.size} selected</span>
          <Button size="sm" variant="outline" loading={busy === "hold"} onClick={() => void bulk("hold")}>Put on hold</Button>
          <Button size="sm" variant="outline" loading={busy === "cancel"} onClick={() => void bulk("cancel")}>Cancel posts</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}

      {view === "calendar" ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <div className="grid min-w-[980px] grid-cols-7 gap-px bg-line">
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const isToday = d === todayKey;
              const past = d < todayKey;
              const label = new Date(`${d}T12:00:00Z`);
              const verified = list.filter((j) => j.state === "VERIFIED_PUBLISHED").length;
              const trouble = list.filter((j) => ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"].includes(j.state)).length;
              const held = list.filter((j) => j.state === "HELD").length;
              return (
                <div key={d} className={cn("min-h-[150px] bg-surface p-1.5", past && "bg-surface-2/60")}>
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span className={cn("text-[12px] font-semibold", isToday ? "rounded bg-accent px-1.5 text-white" : "text-ink-2")}>{new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(label)}</span>
                    {list.length ? <span className="tabular text-[11px] text-ink-4">{list.length}</span> : null}
                  </div>
                  {list.length ? (
                    <div className="mb-1 flex flex-wrap gap-1 px-1 text-[10.5px]">
                      {verified ? <span className="rounded bg-ok-soft px-1 text-ok">{verified} live</span> : null}
                      {trouble ? <span className="rounded bg-danger-soft px-1 text-danger">{trouble} need decision</span> : null}
                      {held ? <span className="rounded bg-warn-soft px-1 text-warn">{held} held</span> : null}
                    </div>
                  ) : null}
                  <ul className="space-y-0.5">
                    {list.slice(0, 7).map((j) => (
                      <li key={j.id}>
                        <button onClick={() => openJob(j.id)} className={cn("flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-surface-3", selectedJobId === j.id && "bg-accent-soft")} title={`@${j.handle} · ${j.state}${j.stateReason ? ` · ${j.stateReason}` : ""}`}>
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(j.state))} aria-hidden />
                          <span className="tabular w-[52px] shrink-0 text-ink-3">{fmtTime(j.plannedAt, j.plannedTimezone)}</span>
                          <span className="truncate">@{j.handle}</span>
                        </button>
                      </li>
                    ))}
                    {list.length > 7 ? <li><button className="px-1 text-[11px] text-accent hover:underline" onClick={() => setParam({ view: "list", date: d })}>+{list.length - 7} more</button></li> : null}
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="border-t border-line px-3 py-2 text-[11.5px] text-ink-4">Dots: <span className="text-ok">●</span> verified · <span className="text-info">●</span> ready/posting · <span className="text-ink-3">●</span> scheduled · <span className="text-warn">●</span> held · <span className="text-danger">●</span> needs a decision. Day-one posts are planned {minGapMinutes} min apart and always publish at least {minGapMinutes} min apart; a delayed post shows as late rather than being squeezed into a burst.</p>
        </div>
      ) : sortedList.length === 0 ? (
        <EmptyState title="No posts match this filter" body="Change the state filter or scope, or create a campaign." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-8 px-3 py-2">{canEdit ? <Checkbox aria-label="Select all" checked={sortedList.every((j) => selected.has(j.id))} onChange={(e) => setSelected(e.target.checked ? new Set(sortedList.map((j) => j.id)) : new Set())} /> : null}</th>
                <th className="px-2 py-2">Planned</th><th className="px-2 py-2">Account</th><th className="px-2 py-2">Video</th><th className="px-2 py-2">State</th><th className="px-2 py-2">Detail</th><th className="px-2 py-2">Campaign</th>
              </tr>
            </thead>
            <tbody>
              {sortedList.map((j) => (
                <tr key={j.id} className={cn("border-t border-line hover:bg-surface-2", selectedJobId === j.id && "bg-accent-soft/60")}>
                  <td className="px-3 py-1.5">{canEdit && !["VERIFIED_PUBLISHED", "CANCELLED", "PREPARING", "SUBMITTING"].includes(j.state) ? <Checkbox aria-label="Select post" checked={selected.has(j.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(j.id); else n.delete(j.id); return n; })} /> : null}</td>
                  <td className="whitespace-nowrap px-2 py-1.5"><button onClick={() => openJob(j.id)} className="text-left hover:underline"><span className="block">{fmtDateTime(j.plannedAt, j.plannedTimezone)}</span><span className="text-[11px] text-ink-4">{j.plannedTimezone.split("/").pop()?.replace("_", " ")}{j.isDayOne ? " · day one" : ""}</span></button></td>
                  <td className="px-2 py-1.5"><AccountChip handle={j.handle} color={j.avatarColor} size="sm" subtitle={j.creatorName} /></td>
                  <td className="px-2 py-1.5"><span className="flex items-center gap-2"><Thumb src={j.thumbUrl} alt="" className="w-6" /><span className="max-w-[160px] truncate">{j.assetName ?? <span className="text-warn">No video</span>}</span></span></td>
                  <td className="px-2 py-1.5"><JobStatePill state={j.state} /></td>
                  <td className="max-w-[300px] px-2 py-1.5 text-[12.5px] text-ink-3"><span className="line-clamp-2">{j.publishedAt ? `Published ${fmtDateTime(j.publishedAt, j.plannedTimezone)}${Math.abs(new Date(j.publishedAt).getTime() - new Date(j.plannedAt).getTime()) > 10 * 60000 ? ` (${relTime(j.publishedAt, new Date(j.plannedAt)).replace("in ", "").replace(" ago", "")} after plan)` : ""}` : j.notBefore && new Date(j.notBefore) > now && j.state === "READY" ? `Waiting until ${fmtTime(j.notBefore, j.plannedTimezone)} to keep spacing` : (j.stateReason ?? "")}</span></td>
                  <td className="px-2 py-1.5 text-[12.5px]"><Link href={`/schedule?campaign=${j.campaignId}`} className="hover:underline">{j.campaignName}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dotClass(state: string) {
  switch (state) {
    case "VERIFIED_PUBLISHED": return "bg-ok";
    case "READY": case "PREPARING": case "SUBMITTING": return "bg-info";
    case "HELD": return "bg-warn";
    case "BLOCKED": case "FAILED": case "UNKNOWN_OUTCOME": return "bg-danger";
    case "CANCELLED": return "bg-line-strong";
    default: return "bg-ink-4";
  }
}
