"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pin, PinOff, Pause, Play, KeyRound, ShieldCheck, ExternalLink, AlertTriangle } from "lucide-react";
import { SidePanel, PanelSection, KV } from "../ui/panel";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog } from "../ui/dialog";
import { Field, Input, Select, Textarea } from "../ui/field";
import { SegmentedTabs } from "../ui/tabs";
import { useToast } from "../ui/toast";
import { useDirty } from "../shell/dirty-guard";
import { AccountStatePill, ExecutionLabel, JobStatePill } from "../common/chips";
import { fmtDateTime, relTime, tzShort } from "@/lib/format";
import { clearReviewAction, endHandoffAction, pauseAccountsAction, resumeAccountsAction, startHandoffAction, togglePinAction, updateAccountAction } from "@/actions/accounts";
import { ERROR_CATEGORY_LABEL } from "@synthos/core/lib/states";
import { cn } from "../ui/cn";

type Account = {
  id: string; handle: string; displayName: string; creatorId: string; creatorName: string; creatorColor: string; avatarColor: string; effectiveState: string; stateExplanation: string; stateReason: string | null; stateSince: string; needsAttention: boolean; executionRoute: string; workerId: string | null; workerName: string | null; workerStatus: string | null; browserProfileKey: string | null; timezone: string; postingPolicy: { ongoingTimes: string[]; dayOne: { count: number; spacingMinutes: number }; minGapMinutes?: number }; nextScheduledAt: string | null; lastVerifiedPostAt: string | null; approvedRemaining: number; heldForContent: number; openExceptions: number; sessionReadiness: string; sessionCheckedAt: string | null; sessionControl: string; handoffExpiresAt: string | null; verifiedIgUserId: string | null; pausedAt: string | null; pausedReason: string | null; lockExpiresAt: string | null; pinned: boolean; tags: string[];
};
type Job = { id: string; state: string; plannedAt: string; stateReason: string | null; errorCategory: string | null; postUrl: string | null; attemptCount: number };
type Activity = { id: string; at: string; actorLabel: string; actorType: string; eventType: string; message: string; errorCategory: string | null; jobId: string | null; evidenceUrl: string | null; isHuman: boolean };

export function AccountPanel({ account, creators, workers, activity, jobs, analytics, role, closeHref, prevHref, nextHref, position }: { account: Account; creators: Array<{ id: string; name: string }>; workers: Array<{ id: string; name: string; status: string; kind: string }>; activity: Activity[]; jobs: Job[]; analytics: Record<string, number>; role: string; closeHref: string; prevHref: string | null; nextHref: string | null; position?: { index: number; total: number } }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const [tab, setTab] = React.useState<"overview" | "posts" | "activity" | "settings">("overview");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [handoff, setHandoff] = React.useState<"start" | "end" | null>(null);
  const [handoffNotes, setHandoffNotes] = React.useState("");
  const [reviewNote, setReviewNote] = React.useState("");
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // Transient state never carries over between accounts: the page remounts this panel with key={account.id}.

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okTitle: string, okBody?: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error ?? "Failed" });
    toast.push({ tone: "ok", title: okTitle, body: okBody });
    router.refresh();
  };
  const exceptions = jobs.filter((j) => ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"].includes(j.state));
  const scheduleHref = (extra = "") => `/schedule?scope=account:${account.id}${extra}`;
  const inHandoff = account.sessionControl === "human_handoff";
  const locked = account.lockExpiresAt && new Date(account.lockExpiresAt) > new Date();

  return (
    <SidePanel
      ariaLabel={`Account @${account.handle}`}
      title={<span className="flex items-center gap-2"><Avatar handle={account.handle} color={account.avatarColor} size={26} />@{account.handle}</span>}
      subtitle={<span>{account.displayName} · {account.creatorName} · {tzShort(account.timezone)}</span>}
      onCloseHref={closeHref}
      prevHref={prevHref}
      nextHref={nextHref}
      position={position}
      header={
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <AccountStatePill state={account.effectiveState} />
            <ExecutionLabel route={account.executionRoute} />
            {account.pinned ? <Badge tone="accent">Pinned</Badge> : null}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void act("pin", () => togglePinAction(account.id), account.pinned ? "Unpinned" : "Pinned")} aria-label={account.pinned ? "Unpin account" : "Pin account"}>
              {account.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </Button>
          </div>
          <p className="text-[13px] text-ink-2">{account.stateExplanation}</p>
          {canEdit ? (
            <div className="flex flex-wrap gap-1.5">
              {account.pausedAt ? (
                <Button size="sm" variant="outline" loading={busy === "resume"} onClick={() => void act("resume", () => resumeAccountsAction([account.id]), "Account resumed", "Overdue posts publish in order with the minimum spacing.")}><Play size={13} /> Resume</Button>
              ) : (
                <Button size="sm" variant="outline" loading={busy === "pause"} onClick={() => void act("pause", () => pauseAccountsAction([account.id]), "Account paused", "No new posts will start. Anything in progress finishes.")}><Pause size={13} /> Pause</Button>
              )}
              {inHandoff ? (
                <Button size="sm" variant="primary" onClick={() => setHandoff("end")}><ShieldCheck size={13} /> Hand session back</Button>
              ) : (
                <Button size="sm" variant={account.effectiveState === "needs_login" ? "primary" : "outline"} onClick={() => setHandoff("start")} disabled={Boolean(locked)} title={locked ? "A post is being published right now" : undefined}><KeyRound size={13} /> Log in (handoff)</Button>
              )}
              {account.effectiveState === "needs_review" && !inHandoff ? <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>Mark reviewed</Button> : null}
            </div>
          ) : null}
        </div>
      }
    >
      <SegmentedTabs ariaLabel="Account sections" size="sm" value={tab} onChange={setTab} options={[{ value: "overview", label: "Overview" }, { value: "posts", label: "Posts", count: jobs.length }, { value: "activity", label: "Activity" }, { value: "settings", label: "Settings" }]} />
      <div className="mt-4">
        {tab === "overview" ? (
          <>
            {exceptions.length ? (
              <PanelSection title="Needs a decision">
                <ul className="space-y-1.5">
                  {exceptions.slice(0, 5).map((j) => (
                    <li key={j.id} className="rounded-md border border-danger/30 bg-danger-soft/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <JobStatePill state={j.state} />
                        <Link href={scheduleHref(`&job=${j.id}`)} className="text-[12px] font-medium text-accent hover:underline">Resolve →</Link>
                      </div>
                      <p className="mt-1 text-[12.5px] text-ink-2">{j.errorCategory ? `${ERROR_CATEGORY_LABEL[j.errorCategory] ?? j.errorCategory}: ` : ""}{j.stateReason}</p>
                      <p className="text-[11.5px] text-ink-4">Planned {fmtDateTime(j.plannedAt, account.timezone)} · attempt {j.attemptCount}</p>
                    </li>
                  ))}
                </ul>
              </PanelSection>
            ) : null}
            <PanelSection title="Posting">
              <KV rows={[
                ["Next scheduled", account.nextScheduledAt ? <Link href={scheduleHref()} className="hover:underline">{fmtDateTime(account.nextScheduledAt, account.timezone)} <span className="text-ink-3">({relTime(account.nextScheduledAt)})</span></Link> : <span className="text-ink-3">Nothing scheduled</span>],
                ["Last verified post", account.lastVerifiedPostAt ? <Link href={`/results?scope=account:${account.id}`} className="hover:underline">{fmtDateTime(account.lastVerifiedPostAt, account.timezone)} <span className="text-ink-3">({relTime(account.lastVerifiedPostAt)})</span></Link> : <span className="text-ink-3">None yet</span>],
                ["Approved content left", <span key="a" className={account.approvedRemaining === 0 ? "text-warn" : ""}>{account.approvedRemaining} post{account.approvedRemaining === 1 ? "" : "s"}{account.heldForContent ? <span className="text-warn"> · {account.heldForContent} slot{account.heldForContent === 1 ? "" : "s"} without a video</span> : null}</span>],
                ["Timezone", `${account.timezone} (${tzShort(account.timezone)})`],
                ["Daily times", account.postingPolicy.ongoingTimes.join(", ") || "—"],
                ["Day-one", `${account.postingPolicy.dayOne.count} posts, ${account.postingPolicy.dayOne.spacingMinutes} min apart`],
              ]} />
            </PanelSection>
            <PanelSection title="Session & identity">
              <KV rows={[
                ["Worker", account.workerName ? <span>{account.workerName} <span className="text-ink-3">· {account.workerStatus}</span></span> : <span className="text-warn">Not assigned</span>],
                ["Browser profile", account.browserProfileKey ? <code className="rounded bg-surface-3 px-1 text-[12px]">{account.browserProfileKey}</code> : "—"],
                ["Session readiness", <span key="s">{account.sessionReadiness === "ready" ? "Logged in" : account.sessionReadiness === "needs_login" ? <span className="text-danger">Logged out</span> : "Not checked yet"} <span className="text-ink-3">· {account.sessionCheckedAt ? `checked ${relTime(account.sessionCheckedAt)}` : "never checked"}</span></span>],
                ["Identity", account.verifiedIgUserId ? <span>Verified · Instagram user id <code className="rounded bg-surface-3 px-1 text-[12px]">{account.verifiedIgUserId}</code></span> : <span className="text-ink-3">Not verified yet. The worker checks the logged-in account before every post; the profile name alone never counts.</span>],
                ["Control", inHandoff ? <span className="text-warn">A person has the session{account.handoffExpiresAt ? ` (expires ${relTime(account.handoffExpiresAt)})` : ""}</span> : "Worker"],
              ]} />
            </PanelSection>
            <PanelSection title="Analytics">
              <p className="text-[13px] text-ink-2">{Object.entries(analytics).map(([k, v]) => `${v} ${({ COMPLETE: "complete", SCHEDULED: "scheduled", READY: "due", RUNNING: "running", FAILED: "failed", BLOCKED: "blocked" } as Record<string, string>)[k] ?? k}`).join(" · ") || "No analytics checks yet."} <Link href={`/results?scope=account:${account.id}`} className="text-accent hover:underline">Results →</Link></p>
            </PanelSection>
          </>
        ) : null}
        {tab === "posts" ? (
          jobs.length === 0 ? <p className="text-sm text-ink-3">No posts have been scheduled for this account.</p> : (
            <ul className="divide-y divide-line">
              {jobs.map((j) => (
                <li key={j.id} className="flex items-start gap-3 py-2">
                  <span className="tabular w-[92px] shrink-0 text-[12px] text-ink-3">{fmtDateTime(j.plannedAt, account.timezone)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><JobStatePill state={j.state} />{j.postUrl ? <a href={j.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-accent hover:underline">link <ExternalLink size={11} /></a> : null}</div>
                    {j.stateReason ? <p className="mt-0.5 text-[12px] text-ink-3">{j.stateReason}</p> : null}
                  </div>
                  <Link href={scheduleHref(`&job=${j.id}`)} className="text-[12px] text-accent hover:underline">Open</Link>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {tab === "activity" ? (
          activity.length === 0 ? <p className="text-sm text-ink-3">No activity recorded yet.</p> : (
            <ul className="space-y-2">
              {activity.map((e) => (
                <li key={e.id} className="text-[12.5px]">
                  <div className="flex items-center gap-2 text-ink-4">
                    <span className="tabular">{fmtDateTime(e.at, account.timezone)}</span>
                    <span>·</span>
                    <span className={cn(e.isHuman && "text-accent-ink font-medium")}>{e.actorLabel}</span>
                    {e.errorCategory ? <Badge tone="danger">{ERROR_CATEGORY_LABEL[e.errorCategory] ?? e.errorCategory}</Badge> : null}
                  </div>
                  <p className="text-ink">{e.message}{e.evidenceUrl ? <> · <a href={e.evidenceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">evidence</a></> : null}</p>
                </li>
              ))}
              <li><Link href={`/activity?accountId=${account.id}`} className="text-[12px] text-accent hover:underline">Full history →</Link></li>
            </ul>
          )
        ) : null}
        {tab === "settings" ? <AccountSettingsForm key={account.id} account={account} creators={creators} workers={workers} canEdit={canEdit} /> : null}
      </div>

      <Dialog open={handoff === "start"} onOpenChange={(o) => !o && setHandoff(null)} title={`Take over the browser session for @${account.handle}`} size="md" footer={<><Button variant="ghost" onClick={() => setHandoff(null)}>Cancel</Button><Button variant="primary" loading={busy === "handoff"} onClick={() => void act("handoff", () => startHandoffAction(account.id, 30), "Session handed to you", "Automatic posting on this account waits until you hand it back.").then(() => setHandoff(null))}>Start handoff (30 min)</Button></>}>
        <div className="space-y-3 text-sm text-ink-2">
          <p>While you hold the session, the worker will not claim posts or analytics checks for this account, so a person and the worker never control the same browser at once.</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>On the execution host (the Mac mini), open the browser profile <code className="rounded bg-surface-3 px-1 text-[12px]">{account.browserProfileKey ?? `profile-${account.handle}`}</code>.</li>
            <li>Log in to Instagram as <strong>@{account.handle}</strong> and complete any challenge Instagram shows.</li>
            <li>Come back here and choose <em>Hand session back</em>. The worker re-verifies the logged-in identity before it posts again.</li>
          </ol>
          <p className="flex items-start gap-2 rounded-md bg-surface-2 p-2 text-[12.5px]"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> Passwords are never entered or stored in this dashboard. Cookies and session storage stay on the execution host.</p>
        </div>
      </Dialog>
      <Dialog open={handoff === "end"} onOpenChange={(o) => !o && setHandoff(null)} title="Hand the session back to the worker" size="sm" footer={<><Button variant="ghost" onClick={() => setHandoff(null)}>Cancel</Button><Button variant="outline" loading={busy === "end-no"} onClick={() => void act("end-no", () => endHandoffAction(account.id, false, handoffNotes), "Handoff ended", "The account still needs a login.").then(() => setHandoff(null))}>Could not log in</Button><Button variant="primary" loading={busy === "end-yes"} onClick={() => void act("end-yes", () => endHandoffAction(account.id, true, handoffNotes), "Session handed back", "Blocked posts on this account will retry; identity is re-verified first.").then(() => setHandoff(null))}>Logged in, hand back</Button></>}>
        <Field label="Notes (optional)"><Textarea rows={2} value={handoffNotes} onChange={(e) => setHandoffNotes(e.target.value)} placeholder="e.g. Instagram asked for an SMS code" /></Field>
      </Dialog>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen} title="Mark this account as reviewed" size="sm" footer={<><Button variant="ghost" onClick={() => setReviewOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === "review"} disabled={!reviewNote.trim()} onClick={() => void act("review", () => clearReviewAction(account.id, reviewNote.trim()), "Account marked reviewed").then(() => setReviewOpen(false))}>Mark reviewed</Button></>}>
        <p className="mb-3 text-sm text-ink-2">Only do this after checking the account on Instagram. Unclear posts must be resolved first from the Schedule.</p>
        <Field label="What did you check?"><Textarea rows={3} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="e.g. Confirmed the profile is @maya.fit and no duplicate post exists" /></Field>
      </Dialog>
    </SidePanel>
  );
}

function AccountSettingsForm({ account, creators, workers, canEdit }: { account: Account; creators: Array<{ id: string; name: string }>; workers: Array<{ id: string; name: string; status: string; kind: string }>; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const initial = React.useMemo(() => ({ displayName: account.displayName, creatorId: account.creatorId, timezone: account.timezone, workerId: account.workerId ?? "", executionRoute: account.executionRoute, times: account.postingPolicy.ongoingTimes.join(", "), dayOneCount: String(account.postingPolicy.dayOne.count), dayOneSpacing: String(account.postingPolicy.dayOne.spacingMinutes), tags: account.tags.join(", ") }), [account]);
  const [form, setForm] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirty(`account-settings-${account.id}`, dirty);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    const r = await updateAccountAction(account.id, {
      displayName: form.displayName,
      creatorId: form.creatorId,
      timezone: form.timezone,
      workerId: form.workerId || null,
      executionRoute: form.executionRoute as "simulator" | "browser_hermes",
      postingPolicy: { ongoingTimes: form.times.split(",").map((s) => s.trim()).filter(Boolean), dayOne: { count: Number(form.dayOneCount) || 3, spacingMinutes: Number(form.dayOneSpacing) || 5 } },
      tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
    });
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: "Account updated", body: r.data.invalidatedJobs ? `${r.data.invalidatedJobs} approved post(s) now need re-approval because the schedule binding changed.` : undefined });
    router.refresh();
  };
  const bindingChange = form.timezone !== initial.timezone || form.creatorId !== initial.creatorId;
  return (
    <div className="space-y-3">
      <Field label="Display name"><Input value={form.displayName} onChange={set("displayName")} disabled={!canEdit} /></Field>
      <Field label="Creator"><Select value={form.creatorId} onChange={set("creatorId")} disabled={!canEdit}>{creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="Timezone" hint="IANA name, e.g. America/Los_Angeles. Changing it invalidates approved schedules on this account."><Input value={form.timezone} onChange={set("timezone")} disabled={!canEdit} /></Field>
      <Field label="Execution route"><Select value={form.executionRoute} onChange={set("executionRoute")} disabled={!canEdit}><option value="simulator">Simulated (demo)</option><option value="browser_hermes">Browser via Hermes (Mac)</option><option value="pixel" disabled>Pixel — future</option><option value="official_api" disabled>Official API — future</option></Select></Field>
      <Field label="Worker / session host"><Select value={form.workerId} onChange={set("workerId")} disabled={!canEdit}><option value="">Not assigned</option>{workers.filter((w) => w.status !== "revoked").map((w) => <option key={w.id} value={w.id}>{w.name} ({w.status})</option>)}</Select></Field>
      <Field label="Ongoing posting times" hint="Local times, comma separated. Demo default 11:00, 18:00 — set the client's real times before going live."><Input value={form.times} onChange={set("times")} disabled={!canEdit} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Day-one posts"><Input type="number" min={1} max={10} value={form.dayOneCount} onChange={set("dayOneCount")} disabled={!canEdit} /></Field>
        <Field label="Minutes apart"><Input type="number" min={1} value={form.dayOneSpacing} onChange={set("dayOneSpacing")} disabled={!canEdit} /></Field>
      </div>
      <Field label="Tags" hint="Demo scenario tags start with sim: (e.g. sim:needs_login)."><Input value={form.tags} onChange={set("tags")} disabled={!canEdit} /></Field>
      {bindingChange ? <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">Changing the creator or timezone invalidates approved posts on this account. They will need re-approval.</p> : null}
      {canEdit ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()}>Save changes</Button>
          {dirty ? <Button variant="ghost" onClick={() => setForm(initial)}>Discard</Button> : null}
          {dirty ? <span className="text-[12px] text-warn">Unsaved changes</span> : null}
        </div>
      ) : <p className="text-[12px] text-ink-4">Viewers cannot change settings.</p>}
    </div>
  );
}
