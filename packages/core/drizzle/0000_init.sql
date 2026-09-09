CREATE TYPE "public"."account_state" AS ENUM('ready', 'posting', 'needs_login', 'paused', 'needs_review', 'offline', 'unassigned');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'worker', 'scheduler', 'system');--> statement-breakpoint
CREATE TYPE "public"."analytics_state" AS ENUM('SCHEDULED', 'READY', 'RUNNING', 'COMPLETE', 'FAILED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('uploading', 'processing', 'ready', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'approved', 'paused', 'needs_reapproval', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('queued', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."execution_route" AS ENUM('simulator', 'browser_hermes', 'pixel', 'official_api');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('QUEUED', 'READY', 'PREPARING', 'SUBMITTING', 'VERIFIED_PUBLISHED', 'BLOCKED', 'FAILED', 'UNKNOWN_OUTCOME', 'HELD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('post_verified', 'analytics_complete', 'login_required', 'unknown_outcome', 'content_shortage', 'worker_offline', 'missed_schedule', 'missed_analytics', 'approval_invalidated', 'job_failed', 'digest', 'test');--> statement-breakpoint
CREATE TYPE "public"."published_at_source" AS ENUM('worker_observed', 'instagram_reported', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."session_control" AS ENUM('worker', 'human_handoff');--> statement-breakpoint
CREATE TYPE "public"."session_readiness" AS ENUM('ready', 'needs_login', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'operator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."worker_kind" AS ENUM('simulator', 'hermes_mac', 'pixel', 'official_api');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('online', 'offline', 'revoked', 'never_connected');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"verified_ig_user_id" text,
	"avatar_color" text DEFAULT '#d8c7b0' NOT NULL,
	"execution_route" "execution_route" DEFAULT 'simulator' NOT NULL,
	"worker_id" uuid,
	"browser_profile_key" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"posting_policy" jsonb NOT NULL,
	"state" "account_state" DEFAULT 'unassigned' NOT NULL,
	"state_reason" text,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"paused_reason" text,
	"session_readiness" "session_readiness" DEFAULT 'unknown' NOT NULL,
	"session_checked_at" timestamp with time zone,
	"session_control" "session_control" DEFAULT 'worker' NOT NULL,
	"handoff_by_user_id" uuid,
	"handoff_started_at" timestamp with time zone,
	"handoff_expires_at" timestamp with time zone,
	"lock_job_id" uuid,
	"lock_worker_id" uuid,
	"lock_expires_at" timestamp with time zone,
	"last_verified_post_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"verified_post_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" "analytics_state" DEFAULT 'SCHEDULED' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"lease_worker_id" uuid,
	"lease_fence" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error_category" text,
	"last_error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_jobs_verified_post_id_unique" UNIQUE("verified_post_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"analytics_job_id" uuid NOT NULL,
	"verified_post_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"post_age_minutes" integer NOT NULL,
	"target_age_minutes" integer NOT NULL,
	"lateness_minutes" integer NOT NULL,
	"is_late" boolean NOT NULL,
	"metrics" jsonb NOT NULL,
	"source" text NOT NULL,
	"execution_route" "execution_route" NOT NULL,
	"evidence_key" text,
	"threshold" jsonb,
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"approved_by_user_id" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"job_count" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_id" uuid,
	"family_id" uuid,
	"variant_label" text,
	"uploaded_by_user_id" uuid,
	"original_filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime" text NOT NULL,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"codec" text,
	"status" "asset_status" DEFAULT 'processing' NOT NULL,
	"validation_error" text,
	"caption" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_order" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"account_id" uuid,
	"creator_id" uuid,
	"campaign_id" uuid,
	"job_id" uuid,
	"approval_id" uuid,
	"analytics_job_id" uuid,
	"attempt_no" integer,
	"from_state" text,
	"to_state" text,
	"error_category" text,
	"evidence" jsonb,
	"notification_id" uuid,
	"is_human_intervention" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_accounts" (
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "campaign_accounts_campaign_id_account_id_pk" PRIMARY KEY("campaign_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_assets" (
	"campaign_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "campaign_assets_campaign_id_asset_id_pk" PRIMARY KEY("campaign_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_id" uuid,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"template" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"current_approval_id" uuid,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"paused_reason" text,
	"completed_at" timestamp with time zone,
	"reapproval_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text DEFAULT '#7c5cff' NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"paused_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"worker_id" uuid,
	"fence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text DEFAULT 'in_progress' NOT NULL,
	"state_reached" "job_state",
	"error_category" text,
	"error_message" text,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"destination_label" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"last_test_at" timestamp with time zone,
	"last_test_result" text,
	"settings" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"state" "delivery_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"severity" "severity" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"account_id" uuid,
	"creator_id" uuid,
	"campaign_id" uuid,
	"job_id" uuid,
	"analytics_job_id" uuid,
	"worker_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "posting_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"asset_id" uuid,
	"approval_id" uuid,
	"approval_snapshot" jsonb,
	"sequence" integer NOT NULL,
	"is_day_one" boolean DEFAULT false NOT NULL,
	"planned_at" timestamp with time zone NOT NULL,
	"planned_timezone" text NOT NULL,
	"not_before" timestamp with time zone,
	"state" "job_state" DEFAULT 'QUEUED' NOT NULL,
	"state_reason" text,
	"error_category" text,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_worker_id" uuid,
	"lease_fence" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"submitting_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_at_source" "published_at_source",
	"post_url" text,
	"post_external_id" text,
	"idempotency_key" text NOT NULL,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"declared_mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"received_bytes" integer DEFAULT 0 NOT NULL,
	"tmp_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"creator_scope" uuid[],
	"preferences" jsonb DEFAULT '{"pinnedAccountIds":[]}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"asset_id" uuid,
	"campaign_id" uuid,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_source" "published_at_source" NOT NULL,
	"post_url" text,
	"external_id" text,
	"caption" text NOT NULL,
	"verified_by_worker_id" uuid,
	"execution_route" "execution_route" NOT NULL,
	"evidence_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verified_posts_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "worker_kind" NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "worker_status" DEFAULT 'never_connected' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"version" text,
	"host_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_jobs" ADD CONSTRAINT "analytics_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_jobs" ADD CONSTRAINT "analytics_jobs_verified_post_id_verified_posts_id_fk" FOREIGN KEY ("verified_post_id") REFERENCES "public"."verified_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_jobs" ADD CONSTRAINT "analytics_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_observations" ADD CONSTRAINT "analytics_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_observations" ADD CONSTRAINT "analytics_observations_analytics_job_id_analytics_jobs_id_fk" FOREIGN KEY ("analytics_job_id") REFERENCES "public"."analytics_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_observations" ADD CONSTRAINT "analytics_observations_verified_post_id_verified_posts_id_fk" FOREIGN KEY ("verified_post_id") REFERENCES "public"."verified_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_family_id_content_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."content_families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_families" ADD CONSTRAINT "content_families_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_families" ADD CONSTRAINT "content_families_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_posting_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."posting_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_jobs" ADD CONSTRAINT "posting_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_jobs" ADD CONSTRAINT "posting_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_jobs" ADD CONSTRAINT "posting_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_jobs" ADD CONSTRAINT "posting_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_jobs" ADD CONSTRAINT "posting_jobs_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_posts" ADD CONSTRAINT "verified_posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_posts" ADD CONSTRAINT "verified_posts_job_id_posting_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."posting_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_posts" ADD CONSTRAINT "verified_posts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_posts" ADD CONSTRAINT "verified_posts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_posts" ADD CONSTRAINT "verified_posts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_handle_idx" ON "accounts" USING btree ("org_id","handle");--> statement-breakpoint
CREATE INDEX "accounts_creator_idx" ON "accounts" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "analytics_jobs_due_idx" ON "analytics_jobs" USING btree ("org_id","state","due_at");--> statement-breakpoint
CREATE INDEX "observations_post_idx" ON "analytics_observations" USING btree ("verified_post_id");--> statement-breakpoint
CREATE INDEX "assets_org_sha_idx" ON "assets" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "assets_creator_idx" ON "assets" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "assets_family_idx" ON "assets" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "audit_org_at_idx" ON "audit_events" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "audit_account_idx" ON "audit_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "audit_job_idx" ON "audit_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "campaigns_org_idx" ON "campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "families_org_idx" ON "content_families" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_org_slug_idx" ON "creators" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "attempts_job_idx" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_unique_idx" ON "notification_deliveries" USING btree ("notification_id","channel_id");--> statement-breakpoint
CREATE INDEX "deliveries_state_idx" ON "notification_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_event_idx" ON "notifications" USING btree ("org_id","event_id");--> statement-breakpoint
CREATE INDEX "notifications_org_created_idx" ON "notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_org_state_idx" ON "posting_jobs" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "jobs_account_planned_idx" ON "posting_jobs" USING btree ("account_id","planned_at");--> statement-breakpoint
CREATE INDEX "jobs_campaign_idx" ON "posting_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_idx" ON "posting_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verified_posts_account_idx" ON "verified_posts" USING btree ("account_id","published_at");--> statement-breakpoint
CREATE INDEX "verified_posts_org_idx" ON "verified_posts" USING btree ("org_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_token_prefix_idx" ON "workers" USING btree ("token_prefix");