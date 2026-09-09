import { accountsService, campaignsService, content, jobs, type JobState } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { parseScope } from "@/lib/scope";
import { DISPLAY_TZ } from "@/lib/display";
import { thumbUrl, evidenceUrl } from "@/lib/media";
import { PageHeader } from "@/components/common/page-header";
import { ScheduleView } from "@/components/schedule/schedule-view";
import { JobPanel } from "@/components/schedule/job-panel";
import { CampaignPanel } from "@/components/schedule/campaign-panel";
import { CampaignBuilder } from "@/components/schedule/campaign-builder";
import { AutoRefresh } from "@/components/common/auto-refresh";

export const metadata = { title: "Schedule" };
const EXCEPTIONS: JobState[] = ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"];

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scope = parseScope(sp.scope);
  const ctx = await getUserCtx();
  const now = ctx.clock.now();
  const view = one("view") === "list" ? "list" : "calendar";
  const stateParam = one("state");
  const states = stateParam === "exceptions" ? EXCEPTIONS : stateParam ? [stateParam as JobState] : undefined;
  const category = one("category");
  const anchor = one("date") ? new Date(`${one("date")}T12:00:00Z`) : now;
  const rangeStart = new Date(anchor.getTime() - 7 * 86_400_000);
  const rangeEnd = new Date(anchor.getTime() + 14 * 86_400_000);
  const campaignId = one("campaign");
  const filter: jobs.JobFilter = { limit: 3000, campaignId, states, ...(scope.kind === "account" ? { accountId: scope.accountId } : scope.kind === "creator" ? { creatorId: scope.creatorId } : {}), ...(view === "calendar" && !states ? { from: rangeStart, to: rangeEnd } : {}) };
  let rows = await jobs.listJobs(ctx, filter);
  if (category) rows = rows.filter((r) => r.errorCategory === category);
  const [campaigns, accounts, creators] = await Promise.all([campaignsService.listCampaigns(ctx), accountsService.listAccounts(ctx, { sort: "creator" }), accountsService.listCreators(ctx)]);
  const selectedJobId = one("job");
  const index = selectedJobId ? rows.findIndex((r) => r.id === selectedJobId) : -1;
  const jobDetail = selectedJobId ? await jobs.getJobDetail(ctx, selectedJobId).catch(() => null) : null;
  const campaignDetail = campaignId && !selectedJobId ? await campaignsService.getCampaignDetail(ctx, campaignId).catch(() => null) : null;
  const editCampaign = one("edit") ? await campaignsService.getCampaignDetail(ctx, one("edit")!).catch(() => null) : null;
  const builderOpen = one("new") === "1" || Boolean(editCampaign);
  const readyAssets = builderOpen ? (await content.listAssets(ctx, { status: "ready", limit: 500, sort: "source_order" })).rows : [];
  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (!["job", "new", "edit"].includes(k) && typeof v === "string" && v) baseParams.set(k, v);
  const hrefFor = (jobId?: string, extra: Record<string, string | null> = {}) => {
    const p = new URLSearchParams(baseParams);
    if (jobId) p.set("job", jobId);
    for (const [k, v] of Object.entries(extra)) { if (v) p.set(k, v); else p.delete(k); }
    const q = p.toString();
    return q ? `/schedule?${q}` : "/schedule";
  };
  const serializeJob = (j: (typeof rows)[number]) => ({ id: j.id, state: j.state, plannedAt: j.plannedAt.toISOString(), plannedTimezone: j.plannedTimezone, notBefore: j.notBefore?.toISOString() ?? null, publishedAt: j.publishedAt?.toISOString() ?? null, stateReason: j.stateReason, errorCategory: j.errorCategory, errorMessage: j.errorMessage, attemptCount: j.attemptCount, maxAttempts: j.maxAttempts, handle: j.handle, avatarColor: j.avatarColor, creatorId: j.creatorId, creatorName: j.creatorName, campaignId: j.campaignId, campaignName: j.campaignName, assetName: j.assetName, thumbUrl: thumbUrl(ctx.orgId, j.thumbnailKey), postUrl: j.postUrl, isDayOne: j.isDayOne, sequence: j.sequence, approved: Boolean(j.approvalId), accountId: j.accountId, workerName: j.workerName, assetId: j.assetId });
  return (
    <div className="mx-auto max-w-[1280px]">
      <AutoRefresh seconds={20} />
      <PageHeader title="Schedule" description={`${rows.length} post${rows.length === 1 ? "" : "s"} in view · times shown in each account's own timezone (calendar days in ${DISPLAY_TZ})`} />
      <ScheduleView
        key={baseParams.toString()}
        jobs={rows.map(serializeJob)}
        campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, creatorName: c.creatorName, startDate: c.startDate, endDate: c.endDate, accountCount: c.accountCount, jobCounts: c.jobCounts, approvedByName: c.approvedByName, approvedAt: c.approvedAt?.toISOString() ?? null, reapprovalReason: c.reapprovalReason, pausedReason: c.pausedReason }))}
        view={view}
        anchorIso={anchor.toISOString()}
        nowIso={now.toISOString()}
        displayTz={DISPLAY_TZ}
        role={ctx.user.role}
        selectedJobId={selectedJobId ?? null}
        selectedCampaignId={campaignId ?? null}
        filterKey={baseParams.toString()}
        minGapMinutes={ctx.settings.minGapMinutes}
      />
      {jobDetail ? (
        <JobPanel
          job={{ ...serializeJob(jobDetail.job), submittingAt: jobDetail.job.submittingAt?.toISOString() ?? null, claimedAt: jobDetail.job.claimedAt?.toISOString() ?? null, snapshot: jobDetail.job.approvalSnapshot ? { caption: jobDetail.job.approvalSnapshot.caption, sha256: jobDetail.job.approvalSnapshot.sha256, handle: jobDetail.job.approvalSnapshot.handle, timezone: jobDetail.job.approvalSnapshot.timezone, assetVersion: jobDetail.job.approvalSnapshot.assetVersion } : null, idempotencyKey: jobDetail.job.idempotencyKey }}
          attempts={jobDetail.attempts.map((a) => ({ id: a.id, attemptNo: a.attemptNo, startedAt: a.startedAt.toISOString(), endedAt: a.endedAt?.toISOString() ?? null, outcome: a.outcome, stateReached: a.stateReached, errorCategory: a.errorCategory, errorMessage: a.errorMessage, evidenceUrl: evidenceUrl(ctx.orgId, a.evidence?.screenshotKey), adapter: a.evidence?.adapter ?? null, fence: a.fence }))}
          verified={jobDetail.verified ? { postUrl: jobDetail.verified.postUrl, publishedAt: jobDetail.verified.publishedAt.toISOString(), publishedAtSource: jobDetail.verified.publishedAtSource, executionRoute: jobDetail.verified.executionRoute } : null}
          analytics={jobDetail.analytics ? { id: jobDetail.analytics.id, state: jobDetail.analytics.state, dueAt: jobDetail.analytics.dueAt.toISOString() } : null}
          readyAssets={jobDetail.job.state === "HELD" || (["BLOCKED", "FAILED"].includes(jobDetail.job.state) && ctx.user.role !== "viewer") ? (await content.listAssets(ctx, { status: "ready", creatorId: jobDetail.job.creatorId, limit: 200, sort: "source_order" })).rows.map((a) => ({ id: a.id, name: a.originalFilename, caption: a.caption })) : []}
          role={ctx.user.role}
          closeHref={hrefFor()}
          prevHref={index > 0 ? hrefFor(rows[index - 1]!.id) : null}
          nextHref={index >= 0 && index < rows.length - 1 ? hrefFor(rows[index + 1]!.id) : null}
          position={index >= 0 ? { index, total: rows.length } : undefined}
        />
      ) : campaignDetail ? (
        <CampaignPanel
          campaign={{ id: campaignDetail.campaign.id, name: campaignDetail.campaign.name, status: campaignDetail.campaign.status, startDate: campaignDetail.campaign.startDate, endDate: campaignDetail.campaign.endDate, template: campaignDetail.campaign.template, reapprovalReason: campaignDetail.campaign.reapprovalReason, pausedReason: campaignDetail.campaign.pausedReason, creatorId: campaignDetail.campaign.creatorId, createdAt: campaignDetail.campaign.createdAt.toISOString(), pausedAt: campaignDetail.campaign.pausedAt?.toISOString() ?? null, completedAt: campaignDetail.campaign.completedAt?.toISOString() ?? null }}
          accounts={campaignDetail.accounts.map((a) => ({ id: a.id, handle: a.handle, avatarColor: a.avatarColor, timezone: a.timezone }))}
          assets={campaignDetail.assets.map((a) => ({ id: a.id, name: a.originalFilename, caption: a.caption, position: a.position, thumbUrl: thumbUrl(ctx.orgId, a.thumbnailKey), status: a.status }))}
          jobs={campaignDetail.jobs.map((j) => ({ id: j.id, state: j.state, plannedAt: j.plannedAt.toISOString(), handle: j.handle, assetName: j.assetName, stateReason: j.stateReason, approved: Boolean(j.approvalId), plannedTimezone: j.plannedTimezone }))}
          approvals={campaignDetail.approvals.map((a) => ({ id: a.id, approvedAt: a.approvedAt.toISOString(), approvedBy: a.snapshot.approvedBy.name, jobCount: a.jobCount, snapshotHash: a.snapshotHash, revokedAt: a.revokedAt?.toISOString() ?? null }))}
          role={ctx.user.role}
          closeHref={hrefFor(undefined, { campaign: null })}
          editHref={hrefFor(undefined, { edit: campaignDetail.campaign.id })}
          displayTz={DISPLAY_TZ}
        />
      ) : null}
      {builderOpen && ctx.user.role !== "viewer" ? (
        <CampaignBuilder
          creators={creators.map((c) => ({ id: c.id, name: c.name, paused: Boolean(c.pausedAt) }))}
          accounts={accounts.map((a) => ({ id: a.id, handle: a.handle, creatorId: a.creatorId, creatorName: a.creatorName, timezone: a.timezone, avatarColor: a.avatarColor, state: a.effectiveState, workerName: a.workerName }))}
          assets={readyAssets.map((a) => ({ id: a.id, name: a.originalFilename, caption: a.caption, creatorId: a.creatorId, thumbUrl: thumbUrl(ctx.orgId, a.thumbnailKey), sourceOrder: a.sourceOrder, durationSeconds: a.durationSeconds }))}
          initial={editCampaign ? { id: editCampaign.campaign.id, name: editCampaign.campaign.name, creatorId: editCampaign.campaign.creatorId, startDate: editCampaign.campaign.startDate, endDate: editCampaign.campaign.endDate, template: editCampaign.campaign.template, accountIds: editCampaign.accounts.map((a) => a.id), assetIds: editCampaign.assets.map((a) => a.id), status: editCampaign.campaign.status } : null}
          defaultCreatorId={scope.kind === "creator" ? scope.creatorId : scope.kind === "account" ? accounts.find((a) => a.id === scope.accountId)?.creatorId : undefined}
          defaultAccountIds={scope.kind === "account" ? [scope.accountId] : []}
          closeHref={hrefFor(undefined, { new: null, edit: null })}
          todayIso={new Intl.DateTimeFormat("en-CA", { timeZone: DISPLAY_TZ }).format(now)}
          minGapMinutes={ctx.settings.minGapMinutes}
        />
      ) : null}
    </div>
  );
}
