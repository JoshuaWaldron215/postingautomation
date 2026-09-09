"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Search } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input, Select } from "../ui/field";
import { SegmentedTabs } from "../ui/tabs";
import { EmptyState } from "../ui/empty";
import { useToast } from "../ui/toast";
import { fmtDateTime } from "@/lib/format";
import { exportActivityAction } from "@/actions/settings";
import { ERROR_CATEGORY_LABEL } from "@synthos/core/lib/states";
import { cn } from "../ui/cn";

type Row = { id: string; at: string; actorType: string; actorLabel: string; eventType: string; message: string; accountId: string | null; handle: string | null; campaignId: string | null; jobId: string | null; approvalId: string | null; attemptNo: number | null; fromState: string | null; toState: string | null; errorCategory: string | null; evidenceUrl: string | null; notificationId: string | null; isHuman: boolean };

export function ActivityView({ rows, total, page, role }: { rows: Row[]; total: number; page: number; role: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [busy, setBusy] = React.useState(false);
  const setParam = (k: string, v: string | null) => { const p = new URLSearchParams(params.toString()); if (v) p.set(k, v); else p.delete(k); p.delete("page"); router.push(`${pathname}?${p.toString()}`); };
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (value: string) => { setQ(value); if (debounce.current) clearTimeout(debounce.current); debounce.current = setTimeout(() => setParam("q", value || null), 300); };
  const kind = params.get("humanOnly") === "1" ? "human" : params.get("errorsOnly") === "1" ? "errors" : "all";
  const exportCsv = async () => {
    setBusy(true);
    const r = await exportActivityAction(Object.fromEntries(params.entries()));
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    const blob = new Blob([r.data], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.push({ tone: "ok", title: "Export downloaded", body: "Secrets are never included in the log." });
  };
  const chips = [["accountId", "account"], ["campaignId", "campaign"], ["jobId", "job"], ["eventType", "event"]].filter(([k]) => params.get(k!));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64"><Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" /><Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search messages, events, actors" className="pl-8" aria-label="Search activity" /></div>
        <SegmentedTabs ariaLabel="Kind" size="sm" value={kind} onChange={(v) => { const p = new URLSearchParams(params.toString()); p.delete("humanOnly"); p.delete("errorsOnly"); p.delete("page"); if (v === "human") p.set("humanOnly", "1"); if (v === "errors") p.set("errorsOnly", "1"); router.push(`${pathname}?${p.toString()}`); }} options={[{ value: "all", label: "Everything" }, { value: "human", label: "Human interventions" }, { value: "errors", label: "Errors" }]} />
        <Select inline aria-label="Actor" value={params.get("actor") ?? ""} onChange={(e) => setParam("actor", e.target.value || null)} className="h-8 py-0 text-[12.5px]"><option value="">Any actor</option><option value="user">People</option><option value="worker">Workers</option><option value="scheduler">Scheduler</option><option value="system">System</option></Select>
        {chips.map(([k, label]) => <Badge key={k} tone="accent">{label}: {params.get(k!)!.slice(0, 8)}… <button className="ml-1" aria-label={`Clear ${label} filter`} onClick={() => setParam(k!, null)}>×</button></Badge>)}
        {role !== "viewer" ? <Button size="sm" variant="outline" className="ml-auto" loading={busy} onClick={() => void exportCsv()}><Download size={13} /> Export CSV</Button> : null}
      </div>
      {rows.length === 0 ? <EmptyState title="No activity matches" body="Try a broader search or clear the filters." /> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[900px] text-[12.5px]">
            <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3"><tr><th className="px-3 py-2">Time</th><th className="px-2 py-2">Actor</th><th className="px-2 py-2">Event</th><th className="px-2 py-2">What happened</th><th className="px-2 py-2">Account</th><th className="px-2 py-2">Refs</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={cn("border-t border-line align-top", e.errorCategory && "bg-danger-soft/30")}>
                  <td className="tabular whitespace-nowrap px-3 py-1.5 text-ink-3">{fmtDateTime(e.at, undefined, { second: "2-digit" })}</td>
                  <td className="px-2 py-1.5"><span className={cn(e.isHuman ? "font-medium text-accent-ink" : "text-ink-2")}>{e.actorLabel}</span><span className="block text-[11px] text-ink-4">{e.actorType}</span></td>
                  <td className="whitespace-nowrap px-2 py-1.5"><button className="font-mono text-[11.5px] text-ink-2 hover:underline" onClick={() => setParam("eventType", e.eventType)}>{e.eventType}</button>{e.fromState || e.toState ? <span className="block text-[11px] text-ink-4">{e.fromState ?? "—"} → {e.toState ?? "—"}</span> : null}</td>
                  <td className="max-w-[460px] px-2 py-1.5"><span className="text-ink">{e.message}</span>{e.errorCategory ? <Badge tone="danger" className="ml-1.5">{ERROR_CATEGORY_LABEL[e.errorCategory] ?? e.errorCategory}</Badge> : null}{e.evidenceUrl ? <a href={e.evidenceUrl} target="_blank" rel="noreferrer" className="ml-1.5 text-accent hover:underline">evidence</a> : null}</td>
                  <td className="px-2 py-1.5">{e.handle ? <Link href={`/accounts?account=${e.accountId}`} className="hover:underline">@{e.handle}</Link> : <span className="text-ink-4">—</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-ink-4">
                    {e.jobId ? <Link href={`/schedule?job=${e.jobId}`} className="mr-1.5 text-accent hover:underline">job {e.jobId.slice(0, 6)}</Link> : null}
                    {e.campaignId ? <Link href={`/schedule?campaign=${e.campaignId}`} className="mr-1.5 text-accent hover:underline">campaign {e.campaignId.slice(0, 6)}</Link> : null}
                    {e.approvalId ? <span className="mr-1.5">approval {e.approvalId.slice(0, 6)}</span> : null}
                    {e.attemptNo ? <span className="mr-1.5">attempt {e.attemptNo}</span> : null}
                    {e.notificationId ? <span>notified</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between text-[12.5px] text-ink-3">
        <span>Showing {page * 100 + 1}–{Math.min(total, (page + 1) * 100)} of {total.toLocaleString()}</span>
        <div className="flex gap-1"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => { const p = new URLSearchParams(params.toString()); p.set("page", String(page - 1)); router.push(`${pathname}?${p.toString()}`); }}>Newer</Button><Button size="sm" variant="ghost" disabled={(page + 1) * 100 >= total} onClick={() => { const p = new URLSearchParams(params.toString()); p.set("page", String(page + 1)); router.push(`${pathname}?${p.toString()}`); }}>Older</Button></div>
      </div>
    </div>
  );
}
