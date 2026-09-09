"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Pause, Play, Pencil, XCircle } from "lucide-react";
import { SidePanel, PanelSection, KV } from "../ui/panel";
import { Button } from "../ui/button";
import { Badge, CAMPAIGN_LABEL, CAMPAIGN_TONE } from "../ui/badge";
import { ConfirmDialog, Dialog } from "../ui/dialog";
import { Field, Input, Checkbox } from "../ui/field";
import { useToast } from "../ui/toast";
import { JobStatePill, Thumb } from "../common/chips";
import { fmtDateTime, relTime } from "@/lib/format";
import { approveCampaignAction, cancelCampaignAction, pauseCampaignAction, resumeCampaignAction } from "@/actions/campaigns";
import type { CampaignTemplate } from "@synthos/core/db/schema";

type Props = {
  campaign: { id: string; name: string; status: string; startDate: string; endDate: string; template: CampaignTemplate; reapprovalReason: string | null; pausedReason: string | null; createdAt: string; pausedAt: string | null; completedAt: string | null; creatorId: string | null };
  accounts: Array<{ id: string; handle: string; avatarColor: string; timezone: string }>;
  assets: Array<{ id: string; name: string; caption: string; position: number; thumbUrl: string | null; status: string }>;
  jobs: Array<{ id: string; state: string; plannedAt: string; handle: string; assetName: string | null; stateReason: string | null; approved: boolean; plannedTimezone: string }>;
  approvals: Array<{ id: string; approvedAt: string; approvedBy: string; jobCount: number; snapshotHash: string; revokedAt: string | null }>;
  role: string;
  closeHref: string;
  editHref: string;
  displayTz: string;
};

export function CampaignPanel({ campaign, accounts, assets, jobs, approvals, role, closeHref, editHref }: Props) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<"approve" | "cancel" | "pause" | null>(null);
  const [reason, setReason] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, title: (d: unknown) => string, body?: (d: unknown) => string | undefined) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error ?? "Failed" });
    toast.push({ tone: "ok", title: title(r.data), body: body?.(r.data) });
    setConfirm(null);
    router.refresh();
  };
  const unapproved = jobs.filter((j) => !j.approved && j.state !== "CANCELLED");
  const heldNoContent = jobs.filter((j) => j.state === "HELD" && !j.assetName).length;
  const counts = jobs.reduce<Record<string, number>>((m, j) => ({ ...m, [j.state]: (m[j.state] ?? 0) + 1 }), {});
  const needsApproval = campaign.status === "draft" || campaign.status === "needs_reapproval";
  const t = campaign.template;
  const upcoming = jobs.filter((j) => ["QUEUED", "READY", "HELD", "BLOCKED"].includes(j.state)).slice(0, 12);
  const missingCaptions = assets.filter((a) => !a.caption.trim()).length;

  return (
    <SidePanel title={campaign.name} subtitle={<span>{campaign.startDate} → {campaign.endDate} · {accounts.length} account{accounts.length === 1 ? "" : "s"} · {assets.length} video{assets.length === 1 ? "" : "s"}</span>} onCloseHref={closeHref} width="lg"
      header={
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={CAMPAIGN_TONE[campaign.status] ?? "neutral"}>{CAMPAIGN_LABEL[campaign.status] ?? campaign.status}</Badge>
            <span className="text-[12.5px] text-ink-3 tabular">{Object.entries(counts).map(([s, n]) => `${n} ${s.toLowerCase().replace("_", " ")}`).join(" · ")}</span>
          </div>
          {campaign.status === "needs_reapproval" ? <p className="text-[13px] text-danger">Approved posts were blocked because {campaign.reapprovalReason}. Review the changes below and approve again.</p> : null}
          {canEdit ? (
            <div className="flex flex-wrap gap-1.5">
              {needsApproval ? <Button size="sm" variant="primary" onClick={() => setConfirm("approve")} disabled={unapproved.length === 0}><CheckCircle2 size={13} /> Approve {unapproved.length ? `${unapproved.length} post${unapproved.length === 1 ? "" : "s"}` : ""}</Button> : null}
              {campaign.status === "approved" ? <Button size="sm" variant="outline" onClick={() => setConfirm("pause")}><Pause size={13} /> Pause campaign</Button> : null}
              {campaign.status === "paused" ? <Button size="sm" variant="primary" loading={busy === "resume"} onClick={() => void act("resume", () => resumeCampaignAction(campaign.id), () => "Campaign resumed", () => "Overdue posts publish in order with the minimum spacing.")}><Play size={13} /> Resume</Button> : null}
              {!["completed", "cancelled"].includes(campaign.status) ? <Link href={editHref} className="inline-flex h-8 items-center gap-1 rounded-[8px] border border-line-strong bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-2"><Pencil size={13} /> Edit</Link> : null}
              {!["completed", "cancelled"].includes(campaign.status) ? <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm("cancel")}><XCircle size={13} /> Cancel campaign</Button> : null}
            </div>
          ) : null}
        </div>
      }
    >
      <PanelSection title="What approval authorizes">
        <KV rows={[
          ["Day one", t.dayOne.enabled ? `${t.dayOne.count} posts starting ${t.dayOne.firstTime}, ${t.dayOne.spacingMinutes} min apart (planned). Actual publications keep at least the minimum spacing.` : "Off"],
          ["Ongoing", t.ongoing.enabled ? `${t.ongoing.times.join(", ")} daily in each account's timezone` : "Off"],
          ["Limits", `${t.limits.maxPostsPerAccount ?? "no"} per account · ${t.limits.maxPostsTotal ?? "no"} total · ends ${campaign.endDate}`],
          ["Format", "Reel, public audience"],
          ["Content", `${assets.length} video${assets.length === 1 ? "" : "s"} in source order${missingCaptions ? ` · ${missingCaptions} without a caption` : ""}`],
        ]} />
        <p className="mt-2 text-[11.5px] text-ink-4">Approval binds each post to the account, the file hash and version, the exact caption, format and audience, the schedule and timezone, and these limits. Editing any of them blocks the affected posts until re-approval.</p>
      </PanelSection>

      <PanelSection title="Accounts">
        <div className="flex flex-wrap gap-1.5">{accounts.map((a) => <Link key={a.id} href={`/accounts?account=${a.id}`} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[12px] hover:border-line-strong">@{a.handle}</Link>)}</div>
      </PanelSection>

      <PanelSection title="Content in source order" action={<Link href="/content" className="text-[12px] text-accent hover:underline">Library</Link>}>
        {assets.length === 0 ? <p className="text-[13px] text-warn">No videos assigned. Every slot is held until content is added.</p> : (
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {assets.map((a) => (
              <li key={a.id} className="w-[76px] shrink-0">
                <Link href={`/content?asset=${a.id}`} className="block">
                  <span className="relative block"><Thumb src={a.thumbUrl} alt="" className="w-full" /><span className="tabular absolute left-1 top-1 rounded bg-ink/70 px-1 text-[10px] text-white">{a.position + 1}</span></span>
                  <span className="mt-1 block truncate text-[11px] text-ink-2">{a.name}</span>
                  {!a.caption.trim() ? <span className="block text-[10.5px] text-warn">no caption</span> : null}
                </Link>
              </li>
            ))}
          </ol>
        )}
        {heldNoContent ? <p className="mt-2 text-[12.5px] text-warn">{heldNoContent} slot{heldNoContent === 1 ? "" : "s"} have no video and are held. Add content or shorten the campaign; nothing is recycled automatically.</p> : null}
      </PanelSection>

      <PanelSection title="Upcoming posts" action={<Link href={`/schedule?view=list&campaign=${campaign.id}`} className="text-[12px] text-accent hover:underline">All {jobs.length}</Link>}>
        <ul className="divide-y divide-line">
          {upcoming.map((j) => (
            <li key={j.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
              <span className="tabular w-[120px] shrink-0 text-ink-3">{fmtDateTime(j.plannedAt, j.plannedTimezone)}</span>
              <Link href={`/schedule?job=${j.id}&campaign=${campaign.id}`} className="w-[110px] shrink-0 truncate font-medium hover:underline">@{j.handle}</Link>
              <span className="min-w-0 flex-1 truncate text-ink-2">{j.assetName ?? <span className="text-warn">no video</span>}</span>
              <JobStatePill state={j.state} />
            </li>
          ))}
          {upcoming.length === 0 ? <li className="py-2 text-[13px] text-ink-3">Nothing upcoming.</li> : null}
        </ul>
      </PanelSection>

      <PanelSection title="Approval history">
        {approvals.length === 0 ? <p className="text-[13px] text-ink-3">Not approved yet.</p> : (
          <ul className="space-y-1 text-[12.5px]">
            {approvals.map((a) => <li key={a.id}>{fmtDateTime(a.approvedAt)} · {a.approvedBy} approved {a.jobCount} post{a.jobCount === 1 ? "" : "s"} <span className="text-ink-4">· ref {a.id.slice(0, 8)} · {a.snapshotHash.slice(0, 10)}</span>{a.revokedAt ? <span className="text-danger"> · revoked {relTime(a.revokedAt)}</span> : null}</li>)}
          </ul>
        )}
      </PanelSection>

      <Dialog open={confirm === "approve"} onOpenChange={(o) => !o && setConfirm(null)} title={`Approve “${campaign.name}”`} size="md" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Not yet</Button><Button variant="primary" disabled={!ack} loading={busy === "approve"} onClick={() => void act("approve", () => approveCampaignAction(campaign.id), (d) => `Approved ${(d as { approvedJobs: number }).approvedJobs} posts`, (d) => ((d as { heldJobs: number }).heldJobs ? `${(d as { heldJobs: number }).heldJobs} slots are held for missing content.` : "The worker will publish them without asking again."))}>Approve and let the worker post</Button></>}>
        <div className="space-y-3 text-sm text-ink-2">
          <p>You are authorizing <strong>{unapproved.length}</strong> post{unapproved.length === 1 ? "" : "s"} across <strong>{accounts.length}</strong> account{accounts.length === 1 ? "" : "s"} between <strong>{campaign.startDate}</strong> and <strong>{campaign.endDate}</strong>. After this, the worker publishes each one at its planned time without asking again.</p>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
            <li>It stops and asks you only for real exceptions: wrong logged-in account, changed content, login challenges, unsupported files, unclear results or revoked approval.</li>
            <li>Actual publications are spaced at least the minimum gap apart; delayed posts show as late instead of bunching up.</li>
            {missingCaptions ? <li className="text-warn">{missingCaptions} video{missingCaptions === 1 ? "" : "s"} have an empty caption and will be posted without one.</li> : null}
            {heldNoContent ? <li className="text-warn">{heldNoContent} slot{heldNoContent === 1 ? "" : "s"} have no video and stay held.</li> : null}
          </ul>
          <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label="I reviewed the captions, accounts and times, and I authorize automatic publishing." />
        </div>
      </Dialog>
      <Dialog open={confirm === "pause"} onOpenChange={(o) => !o && setConfirm(null)} title="Pause this campaign?" size="sm" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={busy === "pause"} onClick={() => void act("pause", () => pauseCampaignAction(campaign.id, reason || undefined), () => "Campaign paused", () => "No new posts start. A post already being published finishes.")}>Pause</Button></>}>
        <p className="mb-3 text-sm text-ink-2">No new posts from this campaign will start. Anything already sent to Instagram cannot be undone. Approval stays valid, so resuming needs no re-approval.</p>
        <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
      <ConfirmDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel this campaign?" body="All pending posts are cancelled and the approval is revoked. Verified posts stay on Instagram; a post mid-submission cannot be recalled." confirmLabel="Cancel campaign" tone="danger" loading={busy === "cancel"} onConfirm={() => void act("cancel", () => cancelCampaignAction(campaign.id), () => "Campaign cancelled")} />
    </SidePanel>
  );
}
