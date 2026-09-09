import { analytics } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope } from "@/lib/scope";
import { DISPLAY_TZ } from "@/lib/display";
import { thumbUrl, evidenceUrl } from "@/lib/media";
import { PageHeader } from "@/components/common/page-header";
import { ResultsView } from "@/components/results/results-view";
import { ResultPanel } from "@/components/results/result-panel";
import { AutoRefresh } from "@/components/common/auto-refresh";
import { startOfDayInTz } from "@synthos/core/services/today";

export const metadata = { title: "Results" };

export default async function ResultsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const now = ctx.clock.now();
  const range = one("range") ?? "7d";
  const from = range === "today" ? startOfDayInTz(now, DISPLAY_TZ) : range === "30d" ? new Date(now.getTime() - 30 * 86_400_000) : range === "all" ? undefined : new Date(now.getTime() - 7 * 86_400_000);
  const rows = await analytics.listResults(ctx, { from, onlyProblems: one("problems") === "1", limit: 500, ...(scope.kind === "account" ? { accountId: scope.accountId } : scope.kind === "creator" ? { creatorId: scope.creatorId } : {}) });
  const threshold = ctx.settings.analytics.threshold;
  const selectedJobId = one("job");
  const index = selectedJobId ? rows.findIndex((r) => r.post.jobId === selectedJobId) : -1;
  const selected = index >= 0 ? rows[index]! : null;
  const comparison = selected ? await analytics.similarAgeComparison(ctx, selected.post.id) : null;
  const siblings = selected?.observation?.recommendations.length ? await Promise.all(selected.observation.recommendations.map(async (r) => { const { content } = await import("@synthos/core"); const a = await content.getAsset(ctx, r.assetId).catch(() => null); return a ? { assetId: a.id, name: a.originalFilename, thumbUrl: thumbUrl(ctx.orgId, a.thumbnailKey), reason: r.reason, variantLabel: a.variantLabel } : null; })).then((x) => x.filter((v): v is NonNullable<typeof v> => Boolean(v))) : [];
  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "job" && typeof v === "string" && v) baseParams.set(k, v);
  const hrefFor = (jobId?: string) => { const p = new URLSearchParams(baseParams); if (jobId) p.set("job", jobId); const q = p.toString(); return q ? `/results?${q}` : "/results"; };
  const serialize = (r: (typeof rows)[number]) => ({
    id: r.post.id, jobId: r.post.jobId, accountId: r.post.accountId, handle: r.handle, avatarColor: r.avatarColor, creatorName: r.creatorName, assetName: r.assetName, thumbUrl: thumbUrl(ctx.orgId, r.thumbnailKey), postUrl: r.post.postUrl, publishedAt: r.post.publishedAt.toISOString(), publishedAtSource: r.post.publishedAtSource, executionRoute: r.post.executionRoute, caption: r.post.caption, workerName: r.workerName, evidenceUrl: evidenceUrl(ctx.orgId, r.post.evidenceKey),
    analytics: r.analytics ? { id: r.analytics.id, state: r.analytics.state, dueAt: r.analytics.dueAt.toISOString(), attemptCount: r.analytics.attemptCount, lastError: r.analytics.lastErrorMessage, lastErrorCategory: r.analytics.lastErrorCategory } : null,
    observation: r.observation ? { observedAt: r.observation.observedAt.toISOString(), postAgeMinutes: r.observation.postAgeMinutes, targetAgeMinutes: r.observation.targetAgeMinutes, latenessMinutes: r.observation.latenessMinutes, isLate: r.observation.isLate, metrics: r.observation.metrics, source: r.observation.source, threshold: r.observation.threshold, evidenceUrl: evidenceUrl(ctx.orgId, r.observation.evidenceKey) } : null,
  });
  return (
    <div className="mx-auto max-w-[1280px]">
      <AutoRefresh seconds={30} />
      <PageHeader title="Results" description={`Verified posts and their ${ctx.settings.analytics.delayHours}-hour reports · threshold ${threshold.metric} ${threshold.comparator === "gt" ? ">" : "≥"} ${threshold.value.toLocaleString()} (provisional, configurable in Settings)`} />
      <ResultsView rows={rows.map(serialize)} nowIso={now.toISOString()} range={range} problemsOnly={one("problems") === "1"} threshold={threshold} selectedJobId={selectedJobId ?? null} delayHours={ctx.settings.analytics.delayHours} />
      {selected ? (
        <ResultPanel
          row={serialize(rows[index]!)}
          comparison={comparison ? { scope: comparison.scope, rows: comparison.rows.map((c) => ({ verifiedPostId: c.verifiedPostId, handle: c.handle, postAgeMinutes: c.postAgeMinutes, metrics: c.metrics, publishedAt: c.publishedAt.toISOString() })) } : null}
          siblings={siblings}
          threshold={threshold}
          role={ctx.user.role}
          nowIso={now.toISOString()}
          closeHref={hrefFor()}
          prevHref={index > 0 ? hrefFor(rows[index - 1]!.post.jobId) : null}
          nextHref={index >= 0 && index < rows.length - 1 ? hrefFor(rows[index + 1]!.post.jobId) : null}
          position={{ index, total: rows.length }}
        />
      ) : null}
    </div>
  );
}
