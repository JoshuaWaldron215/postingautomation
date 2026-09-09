import { audit, accountsService } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope } from "@/lib/scope";
import { PageHeader } from "@/components/common/page-header";
import { ActivityView } from "@/components/activity/activity-view";
import { evidenceUrl } from "@/lib/media";

export const metadata = { title: "Activity" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const page = Math.max(0, Number(one("page") ?? 0));
  const filter: audit.ActivityFilter = {
    q: one("q"),
    accountId: scope.kind === "account" ? scope.accountId : one("accountId"),
    creatorId: scope.kind === "creator" ? scope.creatorId : undefined,
    campaignId: one("campaignId"),
    jobId: one("jobId"),
    actorType: one("actor") as audit.ActivityFilter["actorType"],
    eventType: one("eventType"),
    humanOnly: one("humanOnly") === "1",
    errorsOnly: one("errorsOnly") === "1",
    limit: 100,
    offset: page * 100,
  };
  const [{ rows, total }, accounts] = await Promise.all([audit.listActivity(ctx, filter), accountsService.listAccounts(ctx, { sort: "handle" })]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Activity" description={`${total.toLocaleString()} event${total === 1 ? "" : "s"} · every state change, approval, attempt and human intervention`} />
      <ActivityView
        rows={rows.map((e) => ({ id: e.id, at: e.at.toISOString(), actorType: e.actorType, actorLabel: e.actorLabel, eventType: e.eventType, message: e.message, accountId: e.accountId, handle: e.accountId ? accountById.get(e.accountId)?.handle ?? null : null, campaignId: e.campaignId, jobId: e.jobId, approvalId: e.approvalId, attemptNo: e.attemptNo, fromState: e.fromState, toState: e.toState, errorCategory: e.errorCategory, evidenceUrl: evidenceUrl(ctx.orgId, (e.evidence as { screenshotKey?: string } | null)?.screenshotKey), notificationId: e.notificationId, isHuman: e.isHumanIntervention }))}
        total={total}
        page={page}
        role={ctx.user.role}
      />
    </div>
  );
}
