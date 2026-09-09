"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, RotateCcw, XCircle, PauseCircle, PlayCircle, CheckCircle2 } from "lucide-react";
import { SidePanel, PanelSection, KV } from "../ui/panel";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog } from "../ui/dialog";
import { Field, Input, Select, Textarea, Checkbox } from "../ui/field";
import { useToast } from "../ui/toast";
import { AccountChip, JobStatePill, Thumb } from "../common/chips";
import type { JobLite } from "./schedule-view";
import { fmtDateTime, relTime } from "@/lib/format";
import { cancelJobAction, holdJobAction, markPublishedAction, releaseJobAction, retryJobAction } from "@/actions/jobs";
import { assignAssetToJobAction } from "@/actions/campaigns";
import { ERROR_CATEGORY_LABEL } from "@synthos/core/lib/states";

type Attempt = { id: string; attemptNo: number; startedAt: string; endedAt: string | null; outcome: string; stateReached: string | null; errorCategory: string | null; errorMessage: string | null; evidenceUrl: string | null; adapter: string | null; fence: number };
type Props = {
  job: JobLite & { submittingAt: string | null; claimedAt: string | null; snapshot: { caption: string; sha256: string; handle: string; timezone: string; assetVersion: number } | null; idempotencyKey: string };
  attempts: Attempt[];
  verified: { postUrl: string | null; publishedAt: string; publishedAtSource: string; executionRoute: string } | null;
  analytics: { id: string; state: string; dueAt: string } | null;
  readyAssets: Array<{ id: string; name: string; caption: string }>;
  role: string;
  closeHref: string; prevHref: string | null; nextHref: string | null; position?: { index: number; total: number };
};

export function JobPanel(props: Props) {
  return <JobPanelInner key={props.job.id} {...props} />;
}

function JobPanelInner({ job, attempts, verified, analytics, readyAssets, role, closeHref, prevHref, nextHref, position }: Props) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<"retry-unknown" | "confirm-live" | "cancel" | "hold" | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [postUrl, setPostUrl] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [assetId, setAssetId] = React.useState(job.assetId ?? "");
  const tz = job.plannedTimezone;
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, title: string, body?: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error ?? "Failed" });
    toast.push({ tone: "ok", title, body });
    setDialog(null);
    router.refresh();
  };
  const isException = ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"].includes(job.state);
  const reapproval = job.errorCategory === "approval_changed" || job.errorCategory === "authorization_revoked";
  const loginProblem = job.errorCategory === "login_required" || job.errorCategory === "login_challenge";

  return (
    <SidePanel ariaLabel={`Post for @${job.handle}`} title={<span className="flex items-center gap-2"><JobStatePill state={job.state} /> <span>Post for @{job.handle}</span></span>} subtitle={<span>{job.campaignName} · planned {fmtDateTime(job.plannedAt, tz)} ({tz})</span>} onCloseHref={closeHref} prevHref={prevHref} nextHref={nextHref} position={position}>
      <div className="mb-4 flex gap-3">
        <Thumb src={job.thumbUrl} alt="" className="w-20 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          <AccountChip handle={job.handle} color={job.avatarColor} subtitle={job.creatorName} href={`/accounts?account=${job.accountId}`} />
          <p className="mt-2 truncate text-ink-2">{job.assetName ?? <span className="text-warn">No video assigned</span>}</p>
          <p className="text-[12px] text-ink-3">{job.approved ? "Approved for automatic publishing" : "Not approved yet"}{job.isDayOne ? " · day-one post" : ""} · attempt {job.attemptCount} of {job.maxAttempts}</p>
        </div>
      </div>

      {job.state === "UNKNOWN_OUTCOME" ? (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger-soft p-3 text-[13px]">
          <p className="font-semibold text-danger">Unclear result: the post may or may not be live</p>
          <p className="mt-1 text-ink-2">{job.stateReason}</p>
          <p className="mt-1 text-ink-3">The worker will not retry this on its own, because a second Share could create a duplicate. Check @{job.handle} on Instagram, then choose one:</p>
          {canEdit ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setDialog("confirm-live")}><CheckCircle2 size={13} /> It is live</Button>
              <Button size="sm" variant="outline" onClick={() => setDialog("retry-unknown")}><RotateCcw size={13} /> Not live, retry</Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog("cancel")}><XCircle size={13} /> Cancel post</Button>
            </div>
          ) : null}
        </div>
      ) : isException ? (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger-soft/60 p-3 text-[13px]">
          <p className="font-semibold text-danger">{job.errorCategory ? ERROR_CATEGORY_LABEL[job.errorCategory] ?? job.errorCategory : "Needs a decision"}</p>
          <p className="mt-1 text-ink-2">{job.stateReason ?? job.errorMessage}</p>
          {canEdit ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {reapproval ? <Link href={`/schedule?campaign=${job.campaignId}`} className="inline-flex h-8 items-center rounded-[8px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-accent-strong">Re-approve campaign</Link> : loginProblem ? <Link href={`/accounts?account=${job.accountId}`} className="inline-flex h-8 items-center rounded-[8px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-accent-strong">Log the account in</Link> : job.errorCategory === "account_mismatch" ? <Link href={`/accounts?account=${job.accountId}`} className="inline-flex h-8 items-center rounded-[8px] bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-accent-strong">Review the account</Link> : <Button size="sm" variant="primary" loading={busy === "retry"} onClick={() => void act("retry", () => retryJobAction(job.id), "Post queued for retry")}><RotateCcw size={13} /> Retry now</Button>}
              {!reapproval && !loginProblem && job.errorCategory !== "account_mismatch" ? null : <Button size="sm" variant="outline" loading={busy === "retry"} disabled={reapproval} onClick={() => void act("retry", () => retryJobAction(job.id), "Post queued for retry")}><RotateCcw size={13} /> Retry anyway</Button>}
              <Button size="sm" variant="ghost" onClick={() => setDialog("cancel")}><XCircle size={13} /> Cancel post</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {job.state === "HELD" && canEdit ? (
        <div className="mb-4 rounded-md border border-warn/40 bg-warn-soft p-3 text-[13px]">
          <p className="font-semibold text-warn">On hold</p>
          <p className="mt-1 text-ink-2">{job.stateReason}</p>
          {!job.assetId ? (
            <div className="mt-2 flex flex-col gap-2">
              <Field label="Assign a ready video from this creator">
                <Select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">Choose a video…</option>
                  {readyAssets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.caption ? ` — ${a.caption.slice(0, 40)}` : " (no caption)"}</option>)}
                </Select>
              </Field>
              <div><Button size="sm" variant="primary" disabled={!assetId} loading={busy === "assign"} onClick={() => void act("assign", () => assignAssetToJobAction(job.id, assetId), "Video assigned", "Approve the campaign again to authorize this post.")}>Assign video</Button></div>
              {readyAssets.length === 0 ? <p className="text-[12px] text-ink-3">No ready videos for this creator. <Link href="/content?upload=1" className="text-accent hover:underline">Upload more</Link>.</p> : null}
            </div>
          ) : (
            <div className="mt-2"><Button size="sm" variant="primary" loading={busy === "release"} onClick={() => void act("release", () => releaseJobAction(job.id), "Released")}><PlayCircle size={13} /> Release</Button></div>
          )}
        </div>
      ) : null}

      {verified ? (
        <PanelSection title="Verified publication">
          <KV rows={[
            ["Post", verified.postUrl ? <a key="u" href={verified.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{verified.postUrl.replace("https://www.instagram.com/", "")} <ExternalLink size={12} /></a> : <span className="text-ink-3">URL not captured</span>],
            ["Published", <span key="p">{fmtDateTime(verified.publishedAt, tz)} <span className="text-ink-3">· {verified.publishedAtSource.replace(/_/g, " ")}</span></span>],
            ["Execution", <Badge key="e" tone={verified.executionRoute === "simulator" ? "warn" : "neutral"}>{verified.executionRoute === "simulator" ? "Simulated" : "Browser (Hermes)"}</Badge>],
            ["Analytics", analytics ? <Link key="a" href={`/results?job=${job.id}`} className="hover:underline">{analytics.state === "COMPLETE" ? "Report ready →" : `${analytics.state === "FAILED" ? "Failed" : analytics.state === "BLOCKED" ? "Needs login" : "Due"} ${relTime(analytics.dueAt)} →`}</Link> : "—"],
          ]} />
        </PanelSection>
      ) : null}

      <PanelSection title="Approved content">
        {job.snapshot ? (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2.5 text-[13px] text-ink">{job.snapshot.caption || <span className="text-ink-4">(empty caption)</span>}</p>
            <p className="mt-1.5 text-[11.5px] text-ink-4">Bound to file hash {job.snapshot.sha256.slice(0, 12)}… v{job.snapshot.assetVersion}, @{job.snapshot.handle}, {job.snapshot.timezone}, Reel, public. If any of these change, the worker refuses to post.</p>
          </>
        ) : <p className="text-[13px] text-ink-3">Not approved yet. Approve the campaign to bind the caption, file and schedule.</p>}
      </PanelSection>

      <PanelSection title="Timing">
        <KV rows={[
          ["Planned", `${fmtDateTime(job.plannedAt, tz)} (${tz})`],
          ...(job.notBefore ? [["Not before", `${fmtDateTime(job.notBefore, tz)} — keeps the minimum spacing after the previous actual publication`] as [string, React.ReactNode]] : []),
          ...(job.claimedAt ? [["Claimed", `${fmtDateTime(job.claimedAt, tz)}${job.workerName ? ` by ${job.workerName}` : ""}`] as [string, React.ReactNode]] : []),
          ...(job.submittingAt ? [["Submitting since", fmtDateTime(job.submittingAt, tz)] as [string, React.ReactNode]] : []),
        ]} />
      </PanelSection>

      <PanelSection title={`Attempts (${attempts.length})`}>
        {attempts.length === 0 ? <p className="text-[13px] text-ink-3">No attempts yet.</p> : (
          <ul className="space-y-2">
            {attempts.map((a) => (
              <li key={a.id} className="rounded-md border border-line p-2 text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Attempt {a.attemptNo}</span>
                  <Badge tone={a.outcome === "verified" ? "ok" : a.outcome === "in_progress" ? "info" : a.outcome === "unknown" || a.outcome === "lost" ? "danger" : "warn"}>{a.outcome.replace("_", " ")}</Badge>
                  {a.adapter ? <Badge tone="neutral">{a.adapter === "simulator" ? "Simulated" : a.adapter}</Badge> : null}
                  <span className="ml-auto text-ink-4">{fmtDateTime(a.startedAt, tz)}</span>
                </div>
                {a.errorMessage ? <p className="mt-1 text-ink-2">{a.errorCategory ? `${ERROR_CATEGORY_LABEL[a.errorCategory] ?? a.errorCategory}: ` : ""}{a.errorMessage}</p> : null}
                <p className="mt-0.5 text-ink-4">Reached {a.stateReached ?? "—"} · lease fence {a.fence}{a.evidenceUrl ? <> · <a href={a.evidenceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">evidence</a></> : null}</p>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {canEdit && ["QUEUED", "READY"].includes(job.state) ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" variant="outline" onClick={() => setDialog("hold")}><PauseCircle size={13} /> Put on hold</Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("cancel")}><XCircle size={13} /> Cancel post</Button>
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-ink-4">Idempotency key {job.idempotencyKey}. This makes our records exactly-once; it cannot make an external browser click exactly-once, which is why unclear results are never retried automatically.</p>

      <Dialog open={dialog === "retry-unknown"} onOpenChange={(o) => !o && setDialog(null)} title="Retry an unclear post" size="sm" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!checked} loading={busy === "retry"} onClick={() => void act("retry", () => retryJobAction(job.id, true), "Post queued for retry")}>Retry</Button></>}>
        <p className="mb-3 text-sm text-ink-2">Retrying means the worker will click Share again. If the first attempt did go live, this creates a duplicate post.</p>
        <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} label={<>I checked @{job.handle} on Instagram and this post is <strong>not</strong> live.</>} />
      </Dialog>
      <Dialog open={dialog === "confirm-live"} onOpenChange={(o) => !o && setDialog(null)} title="Confirm the post is live" size="sm" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!postUrl.trim()} loading={busy === "live"} onClick={() => void act("live", () => markPublishedAction(job.id, postUrl.trim()), "Marked as verified live", "An analytics check was scheduled from the estimated publication time.")}>Mark verified</Button></>}>
        <Field label="Instagram post URL" hint="Paste the reel link from the profile. The publication time is estimated from when submission started unless the worker can read it later."><Input value={postUrl} onChange={(e) => setPostUrl(e.target.value)} placeholder="https://www.instagram.com/reel/…" /></Field>
      </Dialog>
      <Dialog open={dialog === "cancel"} onOpenChange={(o) => !o && setDialog(null)} title="Cancel this post?" size="sm" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Keep it</Button><Button variant="danger" loading={busy === "cancel"} onClick={() => void act("cancel", () => cancelJobAction(job.id, reason || undefined), "Post cancelled")}>Cancel post</Button></>}>
        <p className="mb-3 text-sm text-ink-2">The slot is removed from the schedule. Nothing already on Instagram is affected, and the video stays in the library.</p>
        <Field label="Reason (optional)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={dialog === "hold"} onOpenChange={(o) => !o && setDialog(null)} title="Put this post on hold" size="sm" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={busy === "hold"} onClick={() => void act("hold", () => holdJobAction(job.id, reason), "Post on hold", "Release it from this panel when ready.")}>Hold</Button></>}>
        <Field label="Why?"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. waiting for client sign-off on the caption" /></Field>
      </Dialog>
    </SidePanel>
  );
}
