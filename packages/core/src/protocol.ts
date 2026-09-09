/**
 * Worker protocol (HTTP, outbound from the worker, bearer token `wk_…`).
 * All routes live under /api/worker/v1 on the dashboard. Shared by the API and the worker.
 */
import { z } from "zod";

export const ErrorCategorySchema = z.enum(["account_mismatch", "approval_changed", "login_required", "login_challenge", "unsupported_format", "unclear_publication", "authorization_revoked", "paused", "content_missing", "worker_lost", "timeout", "network", "instagram_error", "internal"]);

export const HeartbeatRequest = z.object({
  version: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  hostInfo: z.record(z.string(), z.unknown()).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  adapter: z.enum(["simulator", "browser_hermes", "pixel", "official_api"]).optional(),
});

export const ClaimRequest = z.object({ max: z.number().int().min(1).max(10).default(1) });

export const ProgressRequest = z.object({
  fence: z.number().int(),
  identity: z.object({ observedHandle: z.string().nullable(), observedIgUserId: z.string().nullable(), sessionReady: z.boolean() }),
});

export const JobHeartbeatRequest = z.object({ fence: z.number().int() });

export const ResultRequest = z.object({
  fence: z.number().int(),
  result: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("verified"), postUrl: z.string().nullable(), externalId: z.string().nullable(), publishedAt: z.string(), publishedAtSource: z.enum(["worker_observed", "instagram_reported"]), evidenceKey: z.string().nullable().optional(), notes: z.string().optional() }),
    z.object({ outcome: z.literal("failed"), category: ErrorCategorySchema, message: z.string(), evidenceKey: z.string().nullable().optional() }),
    z.object({ outcome: z.literal("blocked"), category: ErrorCategorySchema, message: z.string(), evidenceKey: z.string().nullable().optional() }),
    z.object({ outcome: z.literal("unknown"), message: z.string(), evidenceKey: z.string().nullable().optional() }),
  ]),
});

export const ReconcileRequest = z.object({
  finding: z.discriminatedUnion("found", [
    z.object({ found: z.literal(true), postUrl: z.string().nullable(), externalId: z.string().nullable(), publishedAt: z.string(), publishedAtSource: z.enum(["worker_observed", "instagram_reported", "estimated"]), evidenceKey: z.string().nullable().optional() }),
    z.object({ found: z.literal(false), evidenceKey: z.string().nullable().optional(), notes: z.string().optional() }),
  ]),
});

export const AnalyticsResultRequest = z.object({
  fence: z.number().int(),
  result: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("observed"), observedAt: z.string(), metrics: z.array(z.object({ name: z.string(), value: z.number().nullable(), source: z.string(), note: z.string().optional() })), source: z.string(), evidenceKey: z.string().nullable().optional(), postFound: z.literal(true) }),
    z.object({ outcome: z.literal("post_not_found"), observedAt: z.string(), evidenceKey: z.string().nullable().optional() }),
    z.object({ outcome: z.literal("failed"), category: ErrorCategorySchema, message: z.string(), evidenceKey: z.string().nullable().optional() }),
  ]),
});

export const SessionReportRequest = z.object({
  accountId: z.string().uuid(),
  readiness: z.enum(["ready", "needs_login", "unknown"]),
  observedHandle: z.string().nullable().optional(),
  observedIgUserId: z.string().nullable().optional(),
});

export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;
export type ClaimRequest = z.infer<typeof ClaimRequest>;
export type ProgressRequest = z.infer<typeof ProgressRequest>;
export type ResultRequest = z.infer<typeof ResultRequest>;
export type ReconcileRequest = z.infer<typeof ReconcileRequest>;
export type AnalyticsResultRequest = z.infer<typeof AnalyticsResultRequest>;
export type SessionReportRequest = z.infer<typeof SessionReportRequest>;

export type HeartbeatResponse = { workerId: string; name: string; status: string; serverTime: string; demoMode: boolean; globalPause: boolean; accounts: Array<{ id: string; handle: string; browserProfileKey: string | null; tags: string[]; sessionControl: string }> };
