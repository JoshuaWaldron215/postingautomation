import { accountsService, workersService, type AccountState } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope } from "@/lib/scope";
import { PageHeader } from "@/components/common/page-header";
import { AccountsView } from "@/components/accounts/accounts-view";
import { AccountPanel } from "@/components/accounts/account-panel";
import { evidenceUrl } from "@/lib/media";

export const metadata = { title: "Accounts" };
const STATES: AccountState[] = ["ready", "posting", "needs_login", "needs_review", "paused", "offline", "unassigned"];

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const state = one("state");
  const filter = {
    q: one("q"),
    creatorId: scope.kind === "creator" ? scope.creatorId : one("creator"),
    states: state && STATES.includes(state as AccountState) ? [state as AccountState] : undefined,
    needsAttention: one("attention") === "1",
    onlyPinned: one("pinned") === "1",
    pinnedIds: ctx.user.preferences.pinnedAccountIds,
    workerId: one("worker"),
    sort: (one("sort") as "handle" | "creator" | "state" | "next" | undefined) ?? "creator",
  };
  const [rows, creators, workers] = await Promise.all([accountsService.listAccounts(ctx, filter), accountsService.listCreators(ctx), workersService.listWorkers(ctx)]);
  const list = scope.kind === "account" ? rows.filter((r) => r.id === scope.accountId) : rows;
  const selectedId = one("account");
  const index = selectedId ? list.findIndex((a) => a.id === selectedId) : -1;
  const selected = selectedId ? (list[index] ?? (await accountsService.getAccount(ctx, selectedId).catch(() => null))) : null;
  const detail = selected
    ? await Promise.all([accountsService.accountActivity(ctx, selected.id, 40), accountsService.accountJobs(ctx, selected.id), accountsService.accountAnalyticsSummary(ctx, selected.id)]).then(([activity, jobs, analytics]) => ({ activity, jobs, analytics }))
    : null;
  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "account" && typeof v === "string" && v) baseParams.set(k, v);
  const hrefFor = (id?: string) => {
    const p = new URLSearchParams(baseParams);
    if (id) p.set("account", id);
    const q = p.toString();
    return q ? `/accounts?${q}` : "/accounts";
  };
  const counts = { total: rows.length, attention: rows.filter((r) => r.needsAttention).length };
  const stateCounts = Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.effectiveState === s).length]));

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Accounts" description={`${counts.total} in view · ${counts.attention} need attention`} />
      <AccountsView
        key={baseParams.toString()}
        rows={list.map((a) => ({ ...a, nextScheduledAt: a.nextScheduledAt?.toISOString() ?? null, lastVerifiedPostAt: a.lastVerifiedPostAt?.toISOString() ?? null, pinned: ctx.user.preferences.pinnedAccountIds.includes(a.id) }))}
        creators={creators.map((c) => ({ id: c.id, name: c.name, color: c.color, paused: Boolean(c.pausedAt), pausedReason: c.pausedReason, accountCount: c.accountCount }))}
        workers={workers.map((w) => ({ id: w.id, name: w.name, status: w.status, kind: w.kind }))}
        stateCounts={stateCounts}
        role={ctx.user.role}
        selectedId={selected?.id ?? null}
        filterKey={baseParams.toString()}
      />
      {selected ? (
        <AccountPanel
          key={selected.id}
          account={{ ...selected, nextScheduledAt: selected.nextScheduledAt?.toISOString() ?? null, lastVerifiedPostAt: selected.lastVerifiedPostAt?.toISOString() ?? null, sessionCheckedAt: selected.sessionCheckedAt?.toISOString() ?? null, stateSince: selected.stateSince.toISOString(), pausedAt: selected.pausedAt?.toISOString() ?? null, handoffExpiresAt: selected.handoffExpiresAt?.toISOString() ?? null, lockExpiresAt: selected.lockExpiresAt?.toISOString() ?? null, pinned: ctx.user.preferences.pinnedAccountIds.includes(selected.id) }}
          creators={creators.map((c) => ({ id: c.id, name: c.name }))}
          workers={workers.map((w) => ({ id: w.id, name: w.name, status: w.status, kind: w.kind }))}
          activity={detail!.activity.map((e) => ({ id: e.id, at: e.at.toISOString(), actorLabel: e.actorLabel, actorType: e.actorType, eventType: e.eventType, message: e.message, errorCategory: e.errorCategory, jobId: e.jobId, evidenceUrl: evidenceUrl(ctx.orgId, (e.evidence as { screenshotKey?: string } | null)?.screenshotKey), isHuman: e.isHumanIntervention }))}
          jobs={detail!.jobs.map((j) => ({ id: j.id, state: j.state, plannedAt: j.plannedAt.toISOString(), stateReason: j.stateReason, errorCategory: j.errorCategory, postUrl: j.postUrl, attemptCount: j.attemptCount }))}
          analytics={detail!.analytics}
          role={ctx.user.role}
          closeHref={hrefFor()}
          prevHref={index > 0 ? hrefFor(list[index - 1]!.id) : null}
          nextHref={index >= 0 && index < list.length - 1 ? hrefFor(list[index + 1]!.id) : null}
          position={index >= 0 ? { index, total: list.length } : undefined}
        />
      ) : null}
    </div>
  );
}
