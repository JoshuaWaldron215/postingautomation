/**
 * Synthos posting platform — database schema.
 *
 * The database is the single source of truth for scheduling and execution.
 * Every row that belongs to a customer carries `org_id`; services always scope by it
 * and the RLS migration (0001_rls.sql) enforces the same boundary at the database layer
 * for connections that set `app.org_id`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- enums ----------
export const userRoleEnum = pgEnum("user_role", ["owner", "operator", "viewer"]);
export const executionRouteEnum = pgEnum("execution_route", ["simulator", "browser_hermes", "pixel", "official_api"]);
export const accountStateEnum = pgEnum("account_state", ["ready", "posting", "needs_login", "paused", "needs_review", "offline", "unassigned"]);
export const sessionReadinessEnum = pgEnum("session_readiness", ["ready", "needs_login", "unknown"]);
export const sessionControlEnum = pgEnum("session_control", ["worker", "human_handoff"]);
export const assetStatusEnum = pgEnum("asset_status", ["uploading", "processing", "ready", "invalid"]);
export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "approved",
  "paused",
  "needs_reapproval",
  "completed",
  "cancelled",
]);
export const jobStateEnum = pgEnum("job_state", [
  "QUEUED",
  "READY",
  "PREPARING",
  "SUBMITTING",
  "VERIFIED_PUBLISHED",
  "BLOCKED",
  "FAILED",
  "UNKNOWN_OUTCOME",
  "HELD",
  "CANCELLED",
]);
export const analyticsStateEnum = pgEnum("analytics_state", ["SCHEDULED", "READY", "RUNNING", "COMPLETE", "FAILED", "BLOCKED"]);
export const workerKindEnum = pgEnum("worker_kind", ["simulator", "hermes_mac", "pixel", "official_api"]);
export const workerStatusEnum = pgEnum("worker_status", ["online", "offline", "revoked", "never_connected"]);
export const notificationKindEnum = pgEnum("notification_kind", [
  "post_verified",
  "analytics_complete",
  "login_required",
  "unknown_outcome",
  "content_shortage",
  "worker_offline",
  "missed_schedule",
  "missed_analytics",
  "approval_invalidated",
  "job_failed",
  "digest",
  "test",
]);
export const severityEnum = pgEnum("severity", ["info", "warning", "critical"]);
export const deliveryStateEnum = pgEnum("delivery_state", ["queued", "sent", "failed", "skipped"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "worker", "scheduler", "system"]);
export const publishedAtSourceEnum = pgEnum("published_at_source", ["worker_observed", "instagram_reported", "estimated"]);

// ---------- helpers ----------
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => ts("created_at").notNull().defaultNow();
const orgRef = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

// ---------- organizations & users ----------
export type OrgSettings = {
  demoMode: boolean;
  /** Simulated clock offset in ms, applied on top of wall-clock time in demo mode. */
  simClockOffsetMs: number;
  globalPause: { active: boolean; byUserId?: string; at?: string; reason?: string };
  analytics: {
    delayHours: number;
    /** Provisional threshold. `comparator` makes >= vs > explicit. */
    threshold: { metric: "plays" | "views" | "reach"; value: number; comparator: "gt" | "gte" };
    /** An observation later than this is flagged as late (still recorded). */
    lateAfterMinutes: number;
  };
  retention: { evidenceDays: number; deletedAssetDays: number };
  /** Minimum minutes between actual publications on the same account. */
  minGapMinutes: number;
};

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").$type<OrgSettings>().notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: orgRef(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("viewer"),
    /** Optional creator scoping for operators/viewers. Empty = whole organization. */
    creatorScope: uuid("creator_scope").array(),
    preferences: jsonb("preferences").$type<{ pinnedAccountIds: string[] }>().notNull().default({ pinnedAccountIds: [] }),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

// ---------- creators & accounts ----------
export const creators = pgTable(
  "creators",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    color: text("color").notNull().default("#7c5cff"),
    pausedAt: ts("paused_at"),
    pausedByUserId: uuid("paused_by_user_id"),
    pausedReason: text("paused_reason"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("creators_org_slug_idx").on(t.orgId, t.slug)],
);

export type PostingPolicy = {
  /** Ongoing template: local times "HH:mm" in the account timezone. Demo default only. */
  ongoingTimes: string[];
  /** Day-one template: number of posts and spacing between planned times. */
  dayOne: { count: number; spacingMinutes: number };
  /** Minimum minutes between actual publications on this account (overrides org default when set). */
  minGapMinutes?: number;
};

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: orgRef(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id, { onDelete: "restrict" }),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    /** Instagram numeric user id once verified by a worker. Identity is never established by profile name alone. */
    verifiedIgUserId: text("verified_ig_user_id"),
    avatarColor: text("avatar_color").notNull().default("#d8c7b0"),
    executionRoute: executionRouteEnum("execution_route").notNull().default("simulator"),
    workerId: uuid("worker_id"),
    /** Per-account browser profile key on the execution host. One profile per account. */
    browserProfileKey: text("browser_profile_key"),
    timezone: text("timezone").notNull().default("America/New_York"),
    postingPolicy: jsonb("posting_policy").$type<PostingPolicy>().notNull(),
    state: accountStateEnum("state").notNull().default("unassigned"),
    stateReason: text("state_reason"),
    stateSince: ts("state_since").notNull().defaultNow(),
    pausedAt: ts("paused_at"),
    pausedByUserId: uuid("paused_by_user_id"),
    pausedReason: text("paused_reason"),
    sessionReadiness: sessionReadinessEnum("session_readiness").notNull().default("unknown"),
    sessionCheckedAt: ts("session_checked_at"),
    sessionControl: sessionControlEnum("session_control").notNull().default("worker"),
    handoffByUserId: uuid("handoff_by_user_id"),
    handoffStartedAt: ts("handoff_started_at"),
    handoffExpiresAt: ts("handoff_expires_at"),
    /** Account-level execution lock. Only the holder may submit for this account. */
    lockJobId: uuid("lock_job_id"),
    lockWorkerId: uuid("lock_worker_id"),
    lockExpiresAt: ts("lock_expires_at"),
    lastVerifiedPostAt: ts("last_verified_post_at"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("accounts_org_handle_idx").on(t.orgId, t.handle), index("accounts_creator_idx").on(t.creatorId)],
);

// ---------- content ----------
export const contentFamilies = pgTable(
  "content_families",
  {
    id: id(),
    orgId: orgRef(),
    creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [index("families_org_idx").on(t.orgId)],
);

export const uploads = pgTable("uploads", {
  id: id(),
  orgId: orgRef(),
  userId: uuid("user_id").notNull(),
  filename: text("filename").notNull(),
  declaredMime: text("declared_mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  receivedBytes: integer("received_bytes").notNull().default(0),
  tmpKey: text("tmp_key").notNull(),
  status: text("status").$type<"open" | "complete" | "aborted">().notNull().default("open"),
  assetId: uuid("asset_id"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const assets = pgTable(
  "assets",
  {
    id: id(),
    orgId: orgRef(),
    creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
    familyId: uuid("family_id").references(() => contentFamilies.id, { onDelete: "set null" }),
    variantLabel: text("variant_label"),
    uploadedByUserId: uuid("uploaded_by_user_id"),
    originalFilename: text("original_filename").notNull(),
    storageKey: text("storage_key").notNull(),
    thumbnailKey: text("thumbnail_key"),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mime: text("mime").notNull(),
    durationSeconds: integer("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    codec: text("codec"),
    status: assetStatusEnum("status").notNull().default("processing"),
    validationError: text("validation_error"),
    caption: text("caption").notNull().default(""),
    /** Increments on every caption/media/mapping edit. Approvals bind a specific version. */
    version: integer("version").notNull().default(1),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    sourceOrder: integer("source_order").notNull().default(0),
    /** Set once any job referencing this asset was approved. Approved media is immutable; edits bump version and invalidate. */
    lockedAt: ts("locked_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("assets_org_sha_idx").on(t.orgId, t.sha256), index("assets_creator_idx").on(t.creatorId), index("assets_family_idx").on(t.familyId)],
);

// ---------- campaigns, approvals, jobs ----------
export type CampaignTemplate = {
  dayOne: { enabled: boolean; count: number; spacingMinutes: number; firstTime: string };
  ongoing: { enabled: boolean; times: string[] };
  limits: { maxPostsPerAccount: number | null; maxPostsTotal: number | null };
};

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    orgId: orgRef(),
    creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: campaignStatusEnum("status").notNull().default("draft"),
    startDate: text("start_date").notNull(), // ISO date, interpreted per account timezone
    endDate: text("end_date").notNull(),
    template: jsonb("template").$type<CampaignTemplate>().notNull(),
    createdByUserId: uuid("created_by_user_id"),
    currentApprovalId: uuid("current_approval_id"),
    pausedAt: ts("paused_at"),
    pausedByUserId: uuid("paused_by_user_id"),
    pausedReason: text("paused_reason"),
    completedAt: ts("completed_at"),
    reapprovalReason: text("reapproval_reason"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("campaigns_org_idx").on(t.orgId)],
);

export const campaignAccounts = pgTable(
  "campaign_accounts",
  {
    campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.accountId] })],
);

export const campaignAssets = pgTable(
  "campaign_assets",
  {
    campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.assetId] })],
);

export type ApprovalSnapshot = {
  campaignId: string;
  campaignName: string;
  approvedBy: { id: string; name: string };
  template: CampaignTemplate;
  startDate: string;
  endDate: string;
  jobs: Array<{
    jobId: string;
    accountId: string;
    handle: string;
    verifiedIgUserId: string | null;
    assetId: string;
    assetVersion: number;
    sha256: string;
    caption: string;
    format: "reel";
    audience: "public";
    timezone: string;
    plannedAt: string;
  }>;
};

export const approvals = pgTable("approvals", {
  id: id(),
  orgId: orgRef(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  approvedByUserId: uuid("approved_by_user_id").notNull(),
  approvedAt: ts("approved_at").notNull().defaultNow(),
  snapshot: jsonb("snapshot").$type<ApprovalSnapshot>().notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  jobCount: integer("job_count").notNull(),
  revokedAt: ts("revoked_at"),
  revokedByUserId: uuid("revoked_by_user_id"),
  revokedReason: text("revoked_reason"),
});

export type JobApprovalSnapshot = {
  accountId: string;
  handle: string;
  verifiedIgUserId: string | null;
  assetId: string;
  assetVersion: number;
  sha256: string;
  caption: string;
  format: "reel";
  audience: "public";
  timezone: string;
  plannedAt: string;
  limits: CampaignTemplate["limits"];
};

export type ErrorCategory =
  | "account_mismatch"
  | "approval_changed"
  | "login_required"
  | "login_challenge"
  | "unsupported_format"
  | "unclear_publication"
  | "authorization_revoked"
  | "paused"
  | "content_missing"
  | "worker_lost"
  | "timeout"
  | "network"
  | "instagram_error"
  | "internal";

export const postingJobs = pgTable(
  "posting_jobs",
  {
    id: id(),
    orgId: orgRef(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    approvalSnapshot: jsonb("approval_snapshot").$type<JobApprovalSnapshot>(),
    sequence: integer("sequence").notNull(),
    isDayOne: boolean("is_day_one").notNull().default(false),
    plannedAt: ts("planned_at").notNull(),
    plannedTimezone: text("planned_timezone").notNull(),
    /** Earliest actual publish time (enforces min gap after the previous actual publication). */
    notBefore: ts("not_before"),
    state: jobStateEnum("state").notNull().default("QUEUED"),
    stateReason: text("state_reason"),
    errorCategory: text("error_category").$type<ErrorCategory>(),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseWorkerId: uuid("lease_worker_id"),
    leaseFence: integer("lease_fence").notNull().default(0),
    leaseExpiresAt: ts("lease_expires_at"),
    claimedAt: ts("claimed_at"),
    submittingAt: ts("submitting_at"),
    publishedAt: ts("published_at"),
    publishedAtSource: publishedAtSourceEnum("published_at_source"),
    postUrl: text("post_url"),
    postExternalId: text("post_external_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Set when a human took a decision on the job (retry, cancel, mark published). */
    resolvedByUserId: uuid("resolved_by_user_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("jobs_org_state_idx").on(t.orgId, t.state),
    index("jobs_account_planned_idx").on(t.accountId, t.plannedAt),
    index("jobs_campaign_idx").on(t.campaignId),
    uniqueIndex("jobs_idempotency_idx").on(t.idempotencyKey),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: id(),
    orgId: orgRef(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => postingJobs.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    workerId: uuid("worker_id"),
    fence: integer("fence").notNull(),
    startedAt: createdAt(),
    endedAt: ts("ended_at"),
    outcome: text("outcome").$type<"verified" | "failed" | "blocked" | "unknown" | "lost" | "in_progress">().notNull().default("in_progress"),
    stateReached: jobStateEnum("state_reached"),
    errorCategory: text("error_category").$type<ErrorCategory>(),
    errorMessage: text("error_message"),
    evidence: jsonb("evidence").$type<{ screenshotKey?: string; url?: string; notes?: string; adapter?: string }>(),
  },
  (t) => [index("attempts_job_idx").on(t.jobId)],
);

export const verifiedPosts = pgTable(
  "verified_posts",
  {
    id: id(),
    orgId: orgRef(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => postingJobs.id, { onDelete: "cascade" })
      .unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    publishedAt: ts("published_at").notNull(),
    publishedAtSource: publishedAtSourceEnum("published_at_source").notNull(),
    postUrl: text("post_url"),
    externalId: text("external_id"),
    caption: text("caption").notNull(),
    verifiedByWorkerId: uuid("verified_by_worker_id"),
    executionRoute: executionRouteEnum("execution_route").notNull(),
    evidenceKey: text("evidence_key"),
    createdAt: createdAt(),
  },
  (t) => [index("verified_posts_account_idx").on(t.accountId, t.publishedAt), index("verified_posts_org_idx").on(t.orgId, t.publishedAt)],
);

// ---------- analytics ----------
export type MetricObservation = { name: string; value: number | null; source: string; note?: string };
export type ThresholdResult = {
  metric: string;
  comparator: "gt" | "gte";
  threshold: number;
  observed: number | null;
  result: "met" | "not_met" | "unknown";
};

export const analyticsJobs = pgTable(
  "analytics_jobs",
  {
    id: id(),
    orgId: orgRef(),
    verifiedPostId: uuid("verified_post_id")
      .notNull()
      .references(() => verifiedPosts.id, { onDelete: "cascade" })
      .unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    dueAt: ts("due_at").notNull(),
    state: analyticsStateEnum("state").notNull().default("SCHEDULED"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    leaseWorkerId: uuid("lease_worker_id"),
    leaseFence: integer("lease_fence").notNull().default(0),
    leaseExpiresAt: ts("lease_expires_at"),
    nextAttemptAt: ts("next_attempt_at"),
    lastErrorCategory: text("last_error_category").$type<ErrorCategory>(),
    lastErrorMessage: text("last_error_message"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("analytics_jobs_due_idx").on(t.orgId, t.state, t.dueAt)],
);

export const analyticsObservations = pgTable(
  "analytics_observations",
  {
    id: id(),
    orgId: orgRef(),
    analyticsJobId: uuid("analytics_job_id")
      .notNull()
      .references(() => analyticsJobs.id, { onDelete: "cascade" }),
    verifiedPostId: uuid("verified_post_id")
      .notNull()
      .references(() => verifiedPosts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    observedAt: ts("observed_at").notNull(),
    postAgeMinutes: integer("post_age_minutes").notNull(),
    targetAgeMinutes: integer("target_age_minutes").notNull(),
    latenessMinutes: integer("lateness_minutes").notNull(),
    isLate: boolean("is_late").notNull(),
    metrics: jsonb("metrics").$type<MetricObservation[]>().notNull(),
    source: text("source").notNull(),
    executionRoute: executionRouteEnum("execution_route").notNull(),
    evidenceKey: text("evidence_key"),
    threshold: jsonb("threshold").$type<ThresholdResult>(),
    recommendations: jsonb("recommendations").$type<Array<{ assetId: string; reason: string }>>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("observations_post_idx").on(t.verifiedPostId)],
);

// ---------- workers ----------
export const workers = pgTable(
  "workers",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    kind: workerKindEnum("kind").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: workerStatusEnum("status").notNull().default("never_connected"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    version: text("version"),
    hostInfo: jsonb("host_info").$type<Record<string, unknown>>().notNull().default({}),
    revokedAt: ts("revoked_at"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workers_token_prefix_idx").on(t.tokenPrefix)],
);

// ---------- notifications ----------
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable, deterministic event id used for deduplication (e.g. post_verified:<jobId>). */
    eventId: text("event_id").notNull(),
    kind: notificationKindEnum("kind").notNull(),
    severity: severityEnum("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    accountId: uuid("account_id"),
    creatorId: uuid("creator_id"),
    campaignId: uuid("campaign_id"),
    jobId: uuid("job_id"),
    analyticsJobId: uuid("analytics_job_id"),
    workerId: uuid("worker_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    readAt: ts("read_at"),
    resolvedAt: ts("resolved_at"),
    resolvedByUserId: uuid("resolved_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notifications_event_idx").on(t.orgId, t.eventId), index("notifications_org_created_idx").on(t.orgId, t.createdAt)],
);

export type ChannelSettings = {
  exceptionsImmediate: boolean;
  successIndividual: boolean;
  analyticsIndividual: boolean;
  digest: "off" | "daily";
  digestTime: string; // HH:mm in org display tz
};

export const notificationChannels = pgTable("notification_channels", {
  id: id(),
  orgId: orgRef(),
  kind: text("kind").$type<"discord_webhook">().notNull(),
  name: text("name").notNull(),
  /** Encrypted with APP_SECRET; never returned to clients. */
  secretEncrypted: text("secret_encrypted").notNull(),
  /** Safe, non-secret description of the destination (e.g. host + masked path). */
  destinationLabel: text("destination_label").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  verifiedAt: ts("verified_at"),
  lastTestAt: ts("last_test_at"),
  lastTestResult: text("last_test_result"),
  settings: jsonb("settings").$type<ChannelSettings>().notNull(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: createdAt(),
});

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: id(),
    orgId: orgRef(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    state: deliveryStateEnum("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("deliveries_unique_idx").on(t.notificationId, t.channelId), index("deliveries_state_idx").on(t.state, t.nextAttemptAt)],
);

// ---------- audit ----------
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: orgRef(),
    at: ts("at").notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label").notNull(),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    accountId: uuid("account_id"),
    creatorId: uuid("creator_id"),
    campaignId: uuid("campaign_id"),
    jobId: uuid("job_id"),
    approvalId: uuid("approval_id"),
    analyticsJobId: uuid("analytics_job_id"),
    attemptNo: integer("attempt_no"),
    fromState: text("from_state"),
    toState: text("to_state"),
    errorCategory: text("error_category"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    notificationId: uuid("notification_id"),
    isHumanIntervention: boolean("is_human_intervention").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_org_at_idx").on(t.orgId, t.at), index("audit_account_idx").on(t.accountId), index("audit_job_idx").on(t.jobId)],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Creator = typeof creators.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type ContentFamily = typeof contentFamilies.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type PostingJob = typeof postingJobs.$inferSelect;
export type JobAttempt = typeof jobAttempts.$inferSelect;
export type VerifiedPost = typeof verifiedPosts.$inferSelect;
export type AnalyticsJob = typeof analyticsJobs.$inferSelect;
export type AnalyticsObservation = typeof analyticsObservations.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type JobState = PostingJob["state"];
export type AccountState = Account["state"];
