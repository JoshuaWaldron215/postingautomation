import type { AccountState, JobState } from "../db/schema";

/** Allowed job transitions. Anything not listed is rejected server-side. */
export const JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  QUEUED: ["READY", "HELD", "CANCELLED", "BLOCKED"],
  READY: ["PREPARING", "HELD", "CANCELLED", "BLOCKED", "QUEUED"],
  PREPARING: ["SUBMITTING", "FAILED", "BLOCKED", "READY", "UNKNOWN_OUTCOME"],
  SUBMITTING: ["VERIFIED_PUBLISHED", "FAILED", "BLOCKED", "UNKNOWN_OUTCOME"],
  VERIFIED_PUBLISHED: [],
  BLOCKED: ["READY", "QUEUED", "CANCELLED", "HELD"],
  FAILED: ["READY", "QUEUED", "CANCELLED"],
  UNKNOWN_OUTCOME: ["VERIFIED_PUBLISHED", "FAILED", "READY", "CANCELLED"],
  HELD: ["QUEUED", "READY", "CANCELLED"],
  CANCELLED: [],
};

export const TERMINAL_JOB_STATES: JobState[] = ["VERIFIED_PUBLISHED", "CANCELLED"];
export const ACTIVE_JOB_STATES: JobState[] = ["QUEUED", "READY", "PREPARING", "SUBMITTING", "HELD"];
export const EXCEPTION_JOB_STATES: JobState[] = ["BLOCKED", "FAILED", "UNKNOWN_OUTCOME"];

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Plain-language labels used everywhere in the UI. */
export const JOB_STATE_LABEL: Record<JobState, string> = {
  QUEUED: "Scheduled",
  READY: "Ready to post",
  PREPARING: "Preparing",
  SUBMITTING: "Posting",
  VERIFIED_PUBLISHED: "Verified live",
  BLOCKED: "Needs attention",
  FAILED: "Failed",
  UNKNOWN_OUTCOME: "Unclear result",
  HELD: "On hold",
  CANCELLED: "Cancelled",
};

export const ACCOUNT_STATE_LABEL: Record<AccountState, string> = {
  ready: "Ready",
  posting: "Posting",
  needs_login: "Needs login",
  paused: "Paused",
  needs_review: "Needs review",
  offline: "Worker offline",
  unassigned: "No worker",
};

export const ERROR_CATEGORY_LABEL: Record<string, string> = {
  account_mismatch: "Logged-in account did not match",
  approval_changed: "Approved content changed",
  login_required: "Instagram login required",
  login_challenge: "Instagram asked for a verification challenge",
  unsupported_format: "Video format not accepted",
  unclear_publication: "Could not confirm the post went live",
  authorization_revoked: "Approval was revoked",
  paused: "Posting is paused",
  content_missing: "Media file is missing",
  worker_lost: "Worker stopped responding",
  timeout: "Timed out",
  network: "Network problem",
  instagram_error: "Instagram returned an error",
  internal: "Internal error",
};
