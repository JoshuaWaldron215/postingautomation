"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, RotateCcw } from "lucide-react";
import { SidePanel, PanelSection, KV } from "../ui/panel";
import { Button } from "../ui/button";
import { Badge, ANALYTICS_LABEL, ANALYTICS_TONE } from "../ui/badge";
import { useToast } from "../ui/toast";
import { AccountChip, Thumb, ExecutionLabel } from "../common/chips";
import { fmtDateTime, ageLabel, relTime } from "@/lib/format";
import { retryAnalyticsAction } from "@/actions/jobs";
import { type ResultRowLite, fmtMetric } from "./results-view";
import { ERROR_CATEGORY_LABEL } from "@synthos/core/lib/states";

type Props = {
  row: ResultRowLite;
  comparison: { scope: "account" | "creator"; rows: Array<{ verifiedPostId: string; handle: string; postAgeMinutes: number; metrics: Array<{ name: string; value: number | null }>; publishedAt: string }> } | null;
  siblings: Array<{ assetId: string; name: string; thumbUrl: string | null; reason: string; variantLabel: string | null }>;
  threshold: { metric: string; value: number; comparator: "gt" | "gte" };
  role: string;
  nowIso: string;
  closeHref: string; prevHref: string | null; nextHref: string | null; position?: { index: number; total: number };
};

export function ResultPanel({ row, comparison, siblings, threshold, role, nowIso, closeHref, prevHref, nextHref, position }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const now = new Date(nowIso);
  const o = row.observation;
  const a = row.analytics;
  const retry = async () => {
    if (!a) return;
    setBusy(true);
    const r = await retryAnalyticsAction(a.id);
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: "Analytics check queued" });
    router.refresh();
  };
  const cmpMetric = (m: Array<{ name: string; value: number | null }>, name: string) => m.find((x) => x.name === name)?.value;
  return (
    <SidePanel ariaLabel={`Report for @${row.handle}`} title={<span className="flex items-center gap-2">Report for @{row.handle}</span>} subtitle={<span>{row.assetName ?? "video"} · published {fmtDateTime(row.publishedAt)}</span>} onCloseHref={closeHref} prevHref={prevHref} nextHref={nextHref} position={position}>
      <div className="mb-4 flex gap-3">
        <Thumb src={row.thumbUrl} alt="" className="w-20 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          <AccountChip handle={row.handle} color={row.avatarColor} subtitle={row.creatorName} href={`/accounts?account=${row.accountId}`} />
          <div className="mt-2 flex flex-wrap gap-1.5"><ExecutionLabel route={row.executionRoute} />{o ? <Badge tone={o.isLate ? "warn" : "ok"}>{o.isLate ? "Late report" : "On-time report"}</Badge> : a ? <Badge tone={ANALYTICS_TONE[a.state]}>{ANALYTICS_LABEL[a.state]}</Badge> : null}</div>
          <p className="mt-1.5 line-clamp-3 text-[12.5px] text-ink-2">{row.caption || <span className="text-ink-4">(no caption)</span>}</p>
        </div>
      </div>

      <PanelSection title="Publication">
        <KV rows={[
          ["Post", row.postUrl ? <a key="u" href={row.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{row.postUrl.replace("https://www.instagram.com/", "")} <ExternalLink size={12} /></a> : <span className="text-ink-3">URL not captured</span>],
          ["Published", <span key="p">{fmtDateTime(row.publishedAt)} <span className="text-ink-3">· source: {row.publishedAtSource.replace(/_/g, " ")}{row.publishedAtSource === "estimated" ? " (uncertain)" : ""}</span></span>],
          ["Verified by", row.workerName ?? "operator"],
          ["Evidence", row.evidenceUrl ? <a key="e" href={row.evidenceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">open</a> : "—"],
          ["Job", <Link key="j" href={`/schedule?job=${row.jobId}`} className="text-accent hover:underline">open in schedule →</Link>],
        ]} />
      </PanelSection>

      <PanelSection title="Analytics observation">
        {o ? (
          <>
            <KV rows={[
              ["Observed", `${fmtDateTime(o.observedAt)} (${relTime(o.observedAt, now)})`],
              ["Post age", <span key="age">{ageLabel(o.postAgeMinutes)} <span className="text-ink-3">· target {ageLabel(o.targetAgeMinutes)}</span>{o.isLate ? <span className="text-warn"> · {o.latenessMinutes} min late; this is not a {Math.round(o.targetAgeMinutes / 60)}-hour observation</span> : null}</span>],
              ["Source", o.source],
              ["Evidence", o.evidenceUrl ? <a key="e" href={o.evidenceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">open</a> : "—"],
            ]} />
            <table className="mt-3 w-full text-[13px]">
              <thead className="text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3"><tr><th className="py-1">Metric</th><th className="py-1 text-right">Value</th><th className="py-1 pl-3">Exact source</th></tr></thead>
              <tbody>{o.metrics.map((m) => <tr key={m.name} className="border-t border-line"><td className="py-1 capitalize">{m.name}</td><td className={"tabular py-1 text-right " + (m.value === null ? "text-ink-4" : "font-medium")}>{fmtMetric(m.value)}</td><td className="py-1 pl-3 text-[12px] text-ink-3"><code className="rounded bg-surface-3 px-1">{m.source}</code>{m.note ? <span className="block">{m.note}</span> : null}</td></tr>)}</tbody>
            </table>
            {o.threshold ? <p className={"mt-3 rounded-md px-3 py-2 text-[13px] " + (o.threshold.result === "met" ? "bg-ok-soft text-ok" : o.threshold.result === "unknown" ? "bg-muted-soft text-ink-2" : "bg-warn-soft text-warn")}>Threshold {o.threshold.metric} {o.threshold.comparator === "gt" ? ">" : "≥"} {o.threshold.threshold.toLocaleString()}: <strong>{o.threshold.result === "met" ? "met" : o.threshold.result === "unknown" ? "unknown (metric unavailable)" : "not met"}</strong>{o.threshold.observed != null ? ` with ${o.threshold.observed.toLocaleString()}` : ""}.</p> : null}
          </>
        ) : a ? (
          <div className="text-[13px]">
            <p className="text-ink-2">{a.state === "FAILED" ? `Failed after ${a.attemptCount} attempts: ${a.lastError}` : a.state === "BLOCKED" ? `Blocked: ${a.lastErrorCategory ? ERROR_CATEGORY_LABEL[a.lastErrorCategory] ?? a.lastErrorCategory : ""} — ${a.lastError}` : `${ANALYTICS_LABEL[a.state]} · due ${fmtDateTime(a.dueAt)} (${relTime(a.dueAt, now)})`}{a.state !== "COMPLETE" && new Date(a.dueAt) < now && !["FAILED", "BLOCKED"].includes(a.state) ? <span className="text-warn"> · overdue; when it runs the report is labeled late.</span> : null}</p>
            {a.lastError && a.state === "READY" ? <p className="mt-1 text-ink-3">Last attempt: {a.lastError} · attempt {a.attemptCount}</p> : null}
            {role !== "viewer" && ["FAILED", "BLOCKED"].includes(a.state) ? <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" loading={busy} onClick={() => void retry()}><RotateCcw size={13} /> Try again</Button>{a.state === "BLOCKED" ? <Link href={`/accounts?account=${row.accountId}`} className="inline-flex h-8 items-center rounded-[8px] border border-line-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">Log the account in</Link> : null}</div> : null}
          </div>
        ) : <p className="text-[13px] text-danger">No analytics job exists for this post. This should not happen; check the activity log.</p>}
      </PanelSection>

      <PanelSection title={`Similar post age (${comparison?.scope === "creator" ? "same creator" : "same account"})`}>
        {comparison?.rows.length ? (
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3"><tr><th className="py-1 pr-2">Post</th><th className="py-1 pl-2 text-right">Age</th><th className="py-1 pl-2 text-right">Plays</th><th className="py-1 pl-2 text-right">Reach</th><th className="py-1 pl-2 text-right">Likes</th></tr></thead>
            <tbody>{comparison.rows.map((c) => <tr key={c.verifiedPostId} className="border-t border-line"><td className="py-1 pr-2">@{c.handle} <span className="block text-[11px] text-ink-4">{fmtDateTime(c.publishedAt)}</span></td><td className="tabular py-1 pl-2 text-right">{ageLabel(c.postAgeMinutes)}</td><td className="tabular py-1 pl-2 text-right">{fmtMetric(cmpMetric(c.metrics, "plays"))}</td><td className="tabular py-1 pl-2 text-right">{fmtMetric(cmpMetric(c.metrics, "reach"))}</td><td className="tabular py-1 pl-2 text-right">{fmtMetric(cmpMetric(c.metrics, "likes"))}</td></tr>)}</tbody>
          </table>
        ) : <p className="text-[13px] text-ink-3">No other observations within ±90 minutes of this post age yet.</p>}
      </PanelSection>

      <PanelSection title="Related content">
        {siblings.length ? (
          <>
            <ul className="flex gap-2 overflow-x-auto pb-1">{siblings.map((s) => <li key={s.assetId} className="w-20 shrink-0"><Link href={`/content?asset=${s.assetId}`} className="block"><Thumb src={s.thumbUrl} alt="" className="w-full" /><span className="mt-1 block truncate text-[11px] text-ink-2">{s.variantLabel ?? s.name}</span></Link></li>)}</ul>
            <p className="mt-1.5 text-[11.5px] text-ink-4">{siblings[0]?.reason}. These are siblings in the same explicit content family. Nothing is scheduled automatically; add them to a campaign if you want to post them.</p>
          </>
        ) : <p className="text-[13px] text-ink-3">No recommendations: either the threshold was not met, the post has no content family, or every sibling is already used.</p>}
      </PanelSection>
      <p className="text-[11px] text-ink-4">Threshold {threshold.metric} {threshold.comparator === "gt" ? ">" : "≥"} {threshold.value.toLocaleString()} is a provisional operating rule, not a claim about what causes reach.</p>
    </SidePanel>
  );
}
