import { cn } from "./cn";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
const tones: Record<Tone, string> = {
  neutral: "bg-muted-soft text-ink-2",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent-ink",
};

export function Badge({ tone = "neutral", className, children, dot }: { tone?: Tone; className?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap", tones[tone], className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export const JOB_TONE: Record<string, Tone> = {
  QUEUED: "neutral",
  READY: "info",
  PREPARING: "info",
  SUBMITTING: "info",
  VERIFIED_PUBLISHED: "ok",
  BLOCKED: "danger",
  FAILED: "danger",
  UNKNOWN_OUTCOME: "danger",
  HELD: "warn",
  CANCELLED: "neutral",
};
export const ACCOUNT_TONE: Record<string, Tone> = {
  ready: "ok",
  posting: "info",
  needs_login: "danger",
  paused: "neutral",
  needs_review: "danger",
  offline: "warn",
  unassigned: "warn",
};
export const ANALYTICS_TONE: Record<string, Tone> = { SCHEDULED: "neutral", READY: "info", RUNNING: "info", COMPLETE: "ok", FAILED: "danger", BLOCKED: "danger" };
export const ANALYTICS_LABEL: Record<string, string> = { SCHEDULED: "Scheduled", READY: "Due", RUNNING: "Checking", COMPLETE: "Complete", FAILED: "Failed", BLOCKED: "Needs login" };
export const CAMPAIGN_TONE: Record<string, Tone> = { draft: "neutral", approved: "ok", paused: "warn", needs_reapproval: "danger", completed: "neutral", cancelled: "neutral" };
export const CAMPAIGN_LABEL: Record<string, string> = { draft: "Awaiting approval", approved: "Approved", paused: "Paused", needs_reapproval: "Needs re-approval", completed: "Completed", cancelled: "Cancelled" };
