"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { SegmentedTabs } from "../ui/tabs";
import { Badge, ANALYTICS_LABEL, ANALYTICS_TONE } from "../ui/badge";
import { EmptyState } from "../ui/empty";
import { AccountChip, Thumb, ExecutionLabel } from "../common/chips";
import { fmtDateTime, relTime, ageLabel } from "@/lib/format";
import { cn } from "../ui/cn";

export type ResultRowLite = {
  id: string; jobId: string; accountId: string; handle: string; avatarColor: string; creatorName: string; assetName: string | null; thumbUrl: string | null; postUrl: string | null; publishedAt: string; publishedAtSource: string; executionRoute: string; caption: string; workerName: string | null; evidenceUrl: string | null;
  analytics: { id: string; state: string; dueAt: string; attemptCount: number; lastError: string | null; lastErrorCategory: string | null } | null;
  observation: { observedAt: string; postAgeMinutes: number; targetAgeMinutes: number; latenessMinutes: number; isLate: boolean; metrics: Array<{ name: string; value: number | null; source: string; note?: string }>; source: string; threshold: { metric: string; comparator: string; threshold: number; observed: number | null; result: string } | null; evidenceUrl: string | null } | null;
};
type Threshold = { metric: string; value: number; comparator: "gt" | "gte" };

export function metricValue(o: ResultRowLite["observation"], name: string): number | null | undefined {
  const m = o?.metrics.find((x) => x.name === name);
  return m ? m.value : undefined;
}
export function fmtMetric(v: number | null | undefined): string {
  if (v === undefined) return "—";
  if (v === null) return "unknown";
  return v.toLocaleString();
}

export function ResultsView({ rows, nowIso, range, problemsOnly, threshold, selectedJobId, delayHours }: { rows: ResultRowLite[]; nowIso: string; range: string; problemsOnly: boolean; threshold: Threshold; selectedJobId: string | null; delayHours: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = new Date(nowIso);
  const setParam = (k: string, v: string | null) => { const p = new URLSearchParams(params.toString()); if (v) p.set(k, v); else p.delete(k); p.delete("job"); router.push(`${pathname}?${p.toString()}`); };
  const open = (jobId: string) => { const p = new URLSearchParams(params.toString()); p.set("job", jobId); router.push(`${pathname}?${p.toString()}`, { scroll: false }); };
  const complete = rows.filter((r) => r.observation).length;
  const met = rows.filter((r) => r.observation?.threshold?.result === "met").length;
  const late = rows.filter((r) => r.observation?.isLate).length;
  const problems = rows.filter((r) => !r.analytics || ["FAILED", "BLOCKED"].includes(r.analytics.state) || (r.analytics.state !== "COMPLETE" && new Date(r.analytics.dueAt) < now)).length;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs ariaLabel="Range" size="sm" value={range} onChange={(v) => setParam("range", v === "7d" ? null : v)} options={[{ value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "all", label: "All" }]} />
        <SegmentedTabs ariaLabel="Problems" size="sm" value={problemsOnly ? "problems" : "all"} onChange={(v) => setParam("problems", v === "problems" ? "1" : null)} options={[{ value: "all", label: "All posts" }, { value: "problems", label: "Late or failed reports", count: problems }]} />
        <p className="ml-auto text-[12.5px] text-ink-3 tabular">{rows.length} verified · {complete} reports · {met} met threshold · {late} late</p>
      </div>
      {rows.length === 0 ? <EmptyState title="No verified posts in this range" body="Posts appear here once the worker confirms them live. Reports follow about 10 hours after actual publication." /> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2">Post</th><th className="px-2 py-2">Published</th><th className="px-2 py-2">Report</th>
                <th className="px-2 py-2 text-right">Plays</th><th className="px-2 py-2 text-right">Reach</th><th className="px-2 py-2 text-right">Likes</th><th className="px-2 py-2 text-right">Comments</th>
                <th className="px-2 py-2">Threshold</th><th className="px-2 py-2">Execution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const o = r.observation;
                const a = r.analytics;
                const overdue = a && a.state !== "COMPLETE" && new Date(a.dueAt) < now;
                return (
                  <tr key={r.id} className={cn("border-t border-line hover:bg-surface-2", selectedJobId === r.jobId && "bg-accent-soft/60")}>
                    <td className="px-3 py-2">
                      <button onClick={() => open(r.jobId)} className="flex items-center gap-2.5 text-left">
                        <Thumb src={r.thumbUrl} alt="" className="w-8" />
                        <span className="min-w-0"><AccountChip handle={r.handle} color={r.avatarColor} size="sm" subtitle={r.assetName ?? undefined} /></span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2"><span className="block">{fmtDateTime(r.publishedAt)}</span><span className="text-[11px] text-ink-4">{r.publishedAtSource.replace(/_/g, " ")}{r.postUrl ? <> · <a href={r.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">link <ExternalLink size={10} /></a></> : " · no URL"}</span></td>
                    <td className="px-2 py-2">
                      {o ? <span className="block"><Badge tone={o.isLate ? "warn" : "ok"}>{o.isLate ? `Late · age ${ageLabel(o.postAgeMinutes)}` : `Age ${ageLabel(o.postAgeMinutes)}`}</Badge><span className="mt-0.5 block text-[11px] text-ink-4">observed {relTime(o.observedAt, now)}</span></span>
                        : a ? <span className="block"><Badge tone={overdue ? "warn" : ANALYTICS_TONE[a.state]}>{overdue && !["FAILED", "BLOCKED"].includes(a.state) ? `Overdue ${ageLabel(Math.round((now.getTime() - new Date(a.dueAt).getTime()) / 60000))}` : ANALYTICS_LABEL[a.state]}</Badge><span className="mt-0.5 block text-[11px] text-ink-4">{a.state === "COMPLETE" ? "" : `due ${relTime(a.dueAt, now)}`}</span></span>
                        : <Badge tone="danger">No report scheduled</Badge>}
                    </td>
                    <td className={cn("tabular px-2 py-2 text-right", metricValue(o, "plays") === null && "text-ink-4")}>{fmtMetric(metricValue(o, "plays"))}</td>
                    <td className={cn("tabular px-2 py-2 text-right", metricValue(o, "reach") === null && "text-ink-4")}>{fmtMetric(metricValue(o, "reach"))}</td>
                    <td className="tabular px-2 py-2 text-right">{fmtMetric(metricValue(o, "likes"))}</td>
                    <td className="tabular px-2 py-2 text-right">{fmtMetric(metricValue(o, "comments"))}</td>
                    <td className="px-2 py-2">{o?.threshold ? <Badge tone={o.threshold.result === "met" ? "ok" : o.threshold.result === "unknown" ? "neutral" : "warn"}>{o.threshold.result === "met" ? "Met" : o.threshold.result === "unknown" ? "Unknown" : "Not met"}</Badge> : <span className="text-ink-4">—</span>}</td>
                    <td className="px-2 py-2"><ExecutionLabel route={r.executionRoute} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[12px] text-ink-4">Plays, views and reach are different metrics and are never substituted for each other. “unknown” means the value was not available at observation time, not zero. Threshold: {threshold.metric} {threshold.comparator === "gt" ? "strictly greater than" : "greater than or equal to"} {threshold.value.toLocaleString()} at about {delayHours} hours.</p>
    </div>
  );
}
