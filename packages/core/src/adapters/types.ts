/**
 * Publisher adapter interface. The worker process owns one adapter instance and drives it
 * with jobs claimed through the worker protocol. Adapters never talk to the database.
 */
import type { ClaimedJob } from "../services/jobs";
import type { ClaimedAnalyticsJob } from "../services/analytics";
import type { ErrorCategory, MetricObservation } from "../db/schema";

export type AdapterKind = "simulator" | "browser_hermes" | "pixel" | "official_api";

export type Capabilities = {
  canVerifyIdentity: boolean;
  canPublish: boolean;
  canReconcile: boolean;
  canReadMetrics: boolean;
  /** Plain-language caveats shown in Settings → Workers. */
  notes: string[];
  /** Whether results from this adapter count as real Instagram activity. */
  live: boolean;
};

export type AccountRef = { id: string; handle: string; verifiedIgUserId: string | null; browserProfileKey: string | null; timezone?: string; executionRoute?: string };

export type IdentityCheck = { sessionReady: boolean; observedHandle: string | null; observedIgUserId: string | null; evidenceKey?: string | null; notes?: string };

export type PublishOutcome =
  | { outcome: "verified"; postUrl: string | null; externalId: string | null; publishedAt: string; publishedAtSource: "worker_observed" | "instagram_reported"; evidenceKey?: string | null }
  | { outcome: "failed"; category: ErrorCategory; message: string; evidenceKey?: string | null }
  | { outcome: "blocked"; category: ErrorCategory; message: string; evidenceKey?: string | null }
  | { outcome: "unknown"; message: string; evidenceKey?: string | null };

export type ReconcileOutcome =
  | { found: true; postUrl: string | null; externalId: string | null; publishedAt: string; publishedAtSource: "worker_observed" | "instagram_reported" | "estimated"; evidenceKey?: string | null }
  | { found: false; evidenceKey?: string | null; notes?: string }
  | { found: "unknown"; message: string };

export type MetricsOutcome =
  | { outcome: "observed"; observedAt: string; metrics: MetricObservation[]; source: string; evidenceKey?: string | null }
  | { outcome: "post_not_found"; observedAt: string; evidenceKey?: string | null }
  | { outcome: "failed"; category: ErrorCategory; message: string; evidenceKey?: string | null };

export interface AdapterControl {
  /** Extend the lease. Returns false when the worker must abort (job reassigned, paused). */
  heartbeat(): Promise<boolean>;
  /** Upload a screenshot or other evidence; returns a storage key. */
  storeEvidence(name: string, data: Buffer, mime: string): Promise<string | null>;
  log(message: string): void;
  /** Local media path for the claimed job (downloaded by the worker runtime). */
  mediaPath: string;
}

export interface PublisherAdapter {
  readonly kind: AdapterKind;
  /** Label shown in the dashboard next to results, e.g. "Simulated" or "Browser (Hermes)". */
  readonly executionLabel: string;
  capabilities(): Promise<Capabilities>;
  checkReadiness(account: AccountRef): Promise<{ ready: boolean; reason?: string }>;
  verifyIdentity(account: AccountRef, ctrl: Pick<AdapterControl, "log" | "storeEvidence">): Promise<IdentityCheck>;
  publish(job: ClaimedJob, ctrl: AdapterControl): Promise<PublishOutcome>;
  reconcile(job: Pick<ClaimedJob, "jobId" | "account" | "content" | "idempotencyKey">, ctrl: Pick<AdapterControl, "log" | "storeEvidence">): Promise<ReconcileOutcome>;
  readMetrics(job: ClaimedAnalyticsJob, ctrl: Pick<AdapterControl, "log" | "storeEvidence" | "heartbeat">): Promise<MetricsOutcome>;
}

export const EXECUTION_LABELS: Record<AdapterKind, string> = {
  simulator: "Simulated",
  browser_hermes: "Browser (Hermes)",
  pixel: "Pixel (future)",
  official_api: "Official API (future)",
};
