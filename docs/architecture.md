# Architecture

## Processes

```
 dashboard (Next.js)  ──── Postgres ────  scheduler (Node)
   │  /api/worker/v1                          │ tick every 5 s
   ▲  outbound HTTPS, bearer token            │ promote / expire / notify
   │                                          │
 worker (Node, on the Mac mini or local) ── adapter: simulator | hermes | pixel* | official_api*
```

The database is the single source of truth. The dashboard renders from it and mutates it through
server actions; the scheduler runs maintenance against it; the worker only talks to the dashboard's
worker API. A long Hermes conversation is never used as a scheduler or ledger.

`*` future adapters exist as typed stubs that report no capabilities.

## Data model (packages/core/src/db/schema.ts)

organizations · users · sessions · creators · accounts · content_families · uploads · assets ·
campaigns · campaign_accounts · campaign_assets · approvals · posting_jobs · job_attempts ·
verified_posts · analytics_jobs · analytics_observations · workers · notifications ·
notification_channels · notification_deliveries · audit_events.

Every customer row carries `org_id`; services scope every query by it and by the user's creator
scope. Role checks (`owner` > `operator` > `viewer`) are enforced in services, never only in the UI.

## Job lifecycle

```
QUEUED → READY → PREPARING → SUBMITTING → VERIFIED_PUBLISHED
                    │            │
                    │            └─ lease expired / crash → UNKNOWN_OUTCOME (human or worker reconciles)
                    └─ retryable failure → READY (bounded attempts, backoff) else FAILED
BLOCKED  = needs a decision (login, mismatch, changed approval, unsupported format)
HELD     = no content or held by an operator; CANCELLED = terminal
```

- **Promote**: scheduler moves approved `QUEUED` jobs to `READY` at `planned_at`.
- **Claim** (`jobs.claimJobs`): one transaction selects `READY` jobs for the worker's accounts with
  `FOR UPDATE SKIP LOCKED`, refuses paused/handoff/needs-review accounts, takes the per-account lock
  (`accounts.lock_*`), increments `lease_fence`, sets a lease and records an attempt.
- **Gate** (`jobs.beginSubmitting`): the worker reports the observed handle and Instagram user id.
  The server verifies identity (first successful check pins the user id), re-checks global/creator/
  account pauses, approval validity and the bound content (hash, caption, version, timezone, handle),
  then persists `SUBMITTING` with a longer lease. Only then may the worker click Share.
- **Result** (`jobs.reportResult`): verified → one transaction writes `verified_posts`,
  `analytics_jobs` (`due_at = published_at + delayHours`), the `post_verified` notification, the
  account's `last_verified_post_at`, and `not_before` on sibling jobs to keep the minimum spacing.
- **Fencing**: every progress/result call carries the fence issued at claim; a stale fence is
  rejected (`409 stale_fence`). Leases that expire in `PREPARING` go back to `READY`; in
  `SUBMITTING` they become `UNKNOWN_OUTCOME`.

### Exactly-once limit

The idempotency key (`campaign:account:sequence`) guarantees one job row and one verified post per
slot in *our* records. It cannot make an external browser click exactly-once: if the worker dies
after clicking Share and before verifying, we cannot know whether Instagram published. That is why
the job becomes `UNKNOWN_OUTCOME`, is never retried automatically, and requires either the worker's
reconciliation (finding the post on the profile) or a human decision.

## Ten-hour analytics

One `analytics_jobs` row per verified post, `due_at = actual published_at + delayHours` (timezone-
aware, UTC instants). The observation stores the actual `observed_at`, `post_age_minutes`,
`target_age_minutes`, `lateness_minutes` and `is_late`; a 12-hour check is labeled late, never shown
as a 10-hour report. Metrics keep their name and exact source; missing metrics are `null`
(unknown), never zero. Threshold evaluation stores the comparator (`gt`/`gte`) and the observed
value. Recommendations list explicit content-family siblings only and never schedule anything.

## Notifications

`notifications.event_id` is a stable, deterministic id (`post_verified:<jobId>`,
`login_required:<jobId>:<attempt>` …) with a unique index, so re-emission is a no-op. External
delivery rows (`notification_deliveries`) are created only for channels that are enabled *and*
passed a labeled test; the scheduler retries with bounded backoff and records every attempt and
error. Delivery state never feeds back into publishing.

## Media and security

Uploads are chunked (4 MiB) into a private temp key, hashed with SHA-256, probed with ffprobe
(extension is ignored), thumbnailed with ffmpeg under a single-thread/30 s bound, and stored under
`STORAGE_DIR` which is never served statically. The dashboard and the worker access media only
through short-lived HMAC tokens bound to the organization. Evidence files (screenshots) use the same
mechanism and have a retention setting. Webhook URLs are AES-GCM encrypted with `APP_SECRET`.
Audit metadata passes through a redactor that strips tokens, cookies, bearer headers and webhook
URLs. Worker tokens are shown once and stored as SHA-256 hashes.

## Demo mode and the simulated clock

`organizations.settings.demoMode` blocks live adapters from receiving jobs. The simulated clock is an
offset stored in the same settings and applied by every process through `makeCtx`, so the scheduler
and the worker protocol observe the same "now" as the dashboard. The seed builds history by running
the real services with a fixed clock; the tests do the same.

## Row-level security

Server-side scoping is the enforced boundary in this version. A Postgres RLS layer keyed on a
session variable is a natural addition when moving to Supabase; the schema already carries `org_id`
on every table to make that a policy-only change.
