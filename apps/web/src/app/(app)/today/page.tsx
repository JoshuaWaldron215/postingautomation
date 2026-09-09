import Link from "next/link";
import { AlertTriangle, ArrowRight, Upload } from "lucide-react";
import { today, accountsService, ACCOUNT_STATE_LABEL, ERROR_CATEGORY_LABEL } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope, withScope } from "@/lib/scope";
import { DISPLAY_TZ } from "@/lib/display";
import { thumbUrl } from "@/lib/media";
import { fmtTime, fmtDateTime, relTime, ageLabel, tzShort } from "@/lib/format";
import { PageHeader, Card } from "@/components/common/page-header";
import { AccountChip, JobStatePill, Thumb } from "@/components/common/chips";
import { AutoRefresh } from "@/components/common/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";

export const metadata = { title: "Today" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const data = await today.todayOverview(ctx, scope, DISPLAY_TZ);
  const scopeLabel = scope.kind === "account" ? `@${(await accountsService.getAccount(ctx, scope.accountId)).handle}` : scope.kind === "creator" ? (await accountsService.listCreators(ctx)).find((c) => c.id === scope.creatorId)?.name ?? "creator" : "all accounts";
  const now = data.now;
  const link = (path: string, extra: Record<string, string | undefined> = {}) => withScope(path, scope, extra);

  const attentionByReason = groupBy(data.accountsNeedingAttention, (a) => a.effectiveState);
  const exceptionsByCategory = groupBy(data.exceptions, (j) => j.errorCategory ?? "other");
  const offlineWorkers = data.workers.filter((w) => w.status === "offline" || w.status === "never_connected");
  const attentionCount = data.exceptions.length + data.accountsNeedingAttention.length + data.contentShortages.length + data.analyticsProblems.length + offlineWorkers.length;
  const simulated = ctx.settings.simClockOffsetMs > 0;

  return (
    <div className="mx-auto max-w-[1280px]">
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Today"
        description={<>{new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: DISPLAY_TZ }).format(now)} · {tzShort(DISPLAY_TZ)} · {scopeLabel}{simulated ? <span className="ml-1 text-warn"> · simulated clock {fmtDateTime(now, DISPLAY_TZ)}</span> : null}</>}
        actions={
          <>
            <Link href={link("/schedule", { new: "1" })} className="inline-flex h-9 items-center rounded-[8px] border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2">New campaign</Link>
            <Link href={link("/content", { upload: "1" })} className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent-strong"><Upload size={15} /> Upload Reels</Link>
          </>
        }
      />

      {data.globalPause.active ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-sm">
            <p className="font-semibold text-danger">All posting is paused{data.globalPause.reason ? `: ${data.globalPause.reason}` : ""}</p>
            <p className="text-ink-2">No new submissions will start. Posts already sent to Instagram before the pause are unaffected. Resume from the top bar.</p>
          </div>
        </div>
      ) : null}

      {/* Progress strip */}
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(31,27,22,0.04)] md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Verified today</p>
            <Link href={link("/results", { range: "today" })} className="text-[12px] text-accent hover:underline">See results</Link>
          </div>
          <p className="mt-1 text-[28px] font-semibold leading-none tracking-tight tabular">
            {data.planned.verified} <span className="text-[15px] font-normal text-ink-3">of {data.planned.total} planned</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={data.planned.verified} aria-valuemax={Math.max(1, data.planned.total)}>
            <div className="h-full rounded-full bg-ok" style={{ width: `${data.planned.total ? Math.min(100, (data.planned.verified / data.planned.total) * 100) : 0}%` }} />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {Object.entries(data.planned.byState).filter(([s]) => s !== "VERIFIED_PUBLISHED").map(([s, n]) => `${n} ${labelForState(s).toLowerCase()}`).join(" · ") || "Nothing else planned today"}
          </p>
        </div>
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Posting now</p>
          {data.inProgress.length === 0 ? <p className="mt-1 text-sm text-ink-3">Nothing in progress</p> : (
            <ul className="mt-1 space-y-1">
              {data.inProgress.map((j) => (
                <li key={j.id} className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-info pulse-dot" aria-hidden />
                  <Link href={link("/schedule", { job: j.id })} className="truncate hover:underline">@{j.handle}</Link>
                  <JobStatePill state={j.state} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Next up</p>
            <Link href={link("/schedule")} className="text-[12px] text-accent hover:underline">Schedule</Link>
          </div>
          {data.upcoming.filter((j) => j.state !== "SUBMITTING").slice(0, 3).length === 0 ? <p className="mt-1 text-sm text-ink-3">No approved posts queued{scope.kind === "all" ? ". Create or approve a campaign." : "."}</p> : (
            <ul className="mt-1 space-y-1">
              {data.upcoming.slice(0, 3).map((j) => (
                <li key={j.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="tabular w-[72px] shrink-0 whitespace-nowrap text-ink-3">{fmtTime(j.plannedAt, DISPLAY_TZ)}</span>
                  <Link href={link("/schedule", { job: j.id })} className="truncate hover:underline">@{j.handle}</Link>
                  {j.plannedAt < now && j.state === "READY" ? <Badge tone="warn">late {relTime(j.plannedAt, now).replace(" ago", "")}</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {data.analyticsDueToday ? <p className="mt-1.5 text-[12px] text-ink-3">{data.analyticsDueToday} analytics check{data.analyticsDueToday === 1 ? "" : "s"} due later today</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card title={<span className="flex items-center gap-2">What needs attention {attentionCount ? <Badge tone="danger">{attentionCount}</Badge> : <Badge tone="ok">clear</Badge>}</span>}>
            {attentionCount === 0 ? (
              <div className="p-4"><EmptyState compact title="Nothing needs you right now" body="Exceptions, login requests, content shortages and late analytics show up here as soon as they happen." /></div>
            ) : (
              <ul className="divide-y divide-line">
                {offlineWorkers.map((w) => (
                  <AttentionRow key={w.id} tone="danger" title={`Worker “${w.name}” is ${w.status === "never_connected" ? "not connected yet" : "offline"}`} body={w.status === "never_connected" ? "It has never sent a heartbeat. Accounts assigned to it cannot post." : `Last heartbeat ${relTime(w.lastHeartbeatAt, now)}. Its accounts are held, not skipped.`} href="/settings/workers" cta="Workers" />
                ))}
                {Object.entries(exceptionsByCategory).map(([cat, list]) => (
                  <AttentionRow key={cat} tone={cat === "unclear_publication" || cat === "login_required" || cat === "account_mismatch" ? "danger" : "warn"} title={`${list.length} post${list.length === 1 ? "" : "s"}: ${ERROR_CATEGORY_LABEL[cat] ?? "need a decision"}`} body={list.slice(0, 4).map((j) => `@${j.handle}`).join(", ") + (list.length > 4 ? ` +${list.length - 4} more` : "")} href={link("/schedule", { view: "list", state: "exceptions", category: cat })} cta="Review" items={list.slice(0, 3).map((j) => ({ key: j.id, href: link("/schedule", { job: j.id }), label: `@${j.handle}`, extra: <JobStatePill state={j.state} /> }))} />
                ))}
                {Object.entries(attentionByReason).filter(([s]) => s !== "ready").map(([state, list]) => (
                  <AttentionRow key={state} tone={state === "needs_login" || state === "needs_review" ? "danger" : "warn"} title={`${list.length} account${list.length === 1 ? "" : "s"}: ${ACCOUNT_STATE_LABEL[state as keyof typeof ACCOUNT_STATE_LABEL] ?? state}`} body={list[0]?.stateExplanation ?? ""} href={link("/accounts", { state })} cta="Open accounts" items={list.slice(0, 3).map((a) => ({ key: a.id, href: `/accounts?account=${a.id}${scope.kind !== "all" ? `&scope=${sp.scope}` : ""}`, label: `@${a.handle}` }))} />
                ))}
                {data.contentShortages.length ? (
                  <AttentionRow tone="warn" title={`${data.contentShortages.length} account${data.contentShortages.length === 1 ? "" : "s"} running out of approved content`} body={`${data.contentShortages.reduce((s, a) => s + a.heldForContent, 0)} upcoming slots have no video. Nothing is recycled automatically.`} href={link("/content", { upload: "1" })} cta="Upload Reels" items={data.contentShortages.slice(0, 3).map((a) => ({ key: a.id, href: `/accounts?account=${a.id}`, label: `@${a.handle}`, extra: <span className="text-[12px] text-ink-3">{a.heldForContent} slots</span> }))} />
                ) : null}
                {data.analyticsProblems.length ? (
                  <AttentionRow tone="warn" title={`${data.analyticsProblems.length} analytics check${data.analyticsProblems.length === 1 ? "" : "s"} late or failed`} body="A late check is recorded with its real post age, never presented as an on-time 10-hour report." href={link("/results", { problems: "1" })} cta="Open results" items={data.analyticsProblems.slice(0, 3).map((a) => ({ key: a.id, href: link("/results", { job: a.jobId }), label: `@${a.handle}`, extra: <span className="text-[12px] text-ink-3">{a.state === "FAILED" ? "failed" : a.state === "BLOCKED" ? "needs login" : `${ageLabel(a.overdueMinutes)} overdue`}</span> }))} />
                ) : null}
              </ul>
            )}
          </Card>

          {data.held.length ? (
            <Card title={`On hold (${data.held.length})`} action={<Link href={link("/schedule", { view: "list", state: "HELD" })} className="text-[12px] text-accent hover:underline">All held</Link>}>
              <ul className="divide-y divide-line">
                {data.held.slice(0, 5).map((j) => (
                  <li key={j.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="tabular w-24 shrink-0 text-ink-3">{fmtDateTime(j.plannedAt, DISPLAY_TZ)}</span>
                    <AccountChip handle={j.handle} color={j.avatarColor} size="sm" href={link("/schedule", { job: j.id })} />
                    <span className="min-w-0 flex-1 truncate text-ink-3">{j.stateReason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Recent verified posts" action={<Link href={link("/results")} className="text-[12px] text-accent hover:underline">All results</Link>}>
            {data.recentVerified.length === 0 ? <div className="p-4"><EmptyState compact title="No verified posts yet" body="Once the worker confirms a post is live it appears here with its link." /></div> : (
              <ul className="divide-y divide-line">
                {data.recentVerified.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Thumb src={thumbUrl(ctx.orgId, v.thumbnailKey)} alt="" className="w-9 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link href={link("/results", { job: v.jobId })} className="truncate text-[13px] font-medium hover:underline">@{v.handle}</Link>
                        <span className="text-[12px] text-ink-3">{relTime(v.publishedAt, now)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
                        {v.postUrl ? <a href={v.postUrl} target="_blank" rel="noreferrer" className="truncate text-accent hover:underline">{v.postUrl.replace("https://www.instagram.com/", "")}</a> : <span>URL not captured</span>}
                        <span>·</span>
                        <span>{v.analyticsState === "COMPLETE" ? "report ready" : v.analyticsDueAt ? `report ${relTime(v.analyticsDueAt, now)}` : "no report scheduled"}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Workers" action={<Link href="/settings/workers" className="text-[12px] text-accent hover:underline">Manage</Link>}>
            <ul className="divide-y divide-line">
              {data.workers.map((w) => (
                <li key={w.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${w.status === "online" ? "bg-ok" : w.status === "offline" ? "bg-danger" : "bg-line-strong"}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                  <span className="text-[12px] text-ink-3">{w.kind === "simulator" ? "Simulated" : w.kind === "hermes_mac" ? "Mac · Hermes" : w.kind}</span>
                  <span className="tabular w-20 text-right text-[12px] text-ink-3">{w.status === "online" ? "online" : w.status === "never_connected" ? "never seen" : relTime(w.lastHeartbeatAt, now)}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Accounts in this view">
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
              <span><span className="font-semibold tabular">{data.totalAccounts}</span> total</span>
              <Link href={link("/accounts", { attention: "1" })} className="hover:underline"><span className="font-semibold tabular">{data.accountsNeedingAttention.length}</span> need attention</Link>
              <Link href={link("/accounts", { state: "ready" })} className="hover:underline"><span className="font-semibold tabular">{data.accountsNeedingAttention.length ? data.totalAccounts - data.accountsNeedingAttention.length : data.totalAccounts}</span> fine</Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function labelForState(s: string) {
  return ({ QUEUED: "scheduled", READY: "ready", PREPARING: "preparing", SUBMITTING: "posting", BLOCKED: "blocked", FAILED: "failed", UNKNOWN_OUTCOME: "unclear", HELD: "held", CANCELLED: "cancelled" } as Record<string, string>)[s] ?? s;
}

function groupBy<T>(list: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of list) (out[key(item)] ??= []).push(item);
  return out;
}

function AttentionRow({ tone, title, body, href, cta, items }: { tone: "danger" | "warn"; title: string; body: string; href: string; cta: string; items?: Array<{ key: string; href: string; label: string; extra?: React.ReactNode }> }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone === "danger" ? "bg-danger" : "bg-warn"}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-ink-3">{body}</p>
        {items?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {items.map((it) => (
              <Link key={it.key} href={it.href} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[12px] hover:border-line-strong">{it.label}{it.extra}</Link>
            ))}
          </div>
        ) : null}
      </div>
      <Link href={href} className="inline-flex h-8 shrink-0 items-center gap-1 self-center rounded-[7px] px-2 text-[12.5px] font-medium text-accent hover:bg-accent-soft">{cta} <ArrowRight size={13} /></Link>
    </li>
  );
}
