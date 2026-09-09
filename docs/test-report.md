# Test report and visual verification

Date: 2026-09-09 · environment: Linux container, Node 22.22, pnpm 10.33, Postgres 16.13 (local), Next.js 16.3.4, Playwright 1.63 with the pre-installed Chromium 1194 build.

## Commands and results

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (core, web, scheduler, worker) | `pnpm typecheck` | pass |
| Lint | `pnpm lint` | pass (1 warning in core: unused variable) |
| Core integration tests (25) | `pnpm test` | **25 passed** in ~8 s against `synthos_test` (fresh migration each run) |
| Production build | `pnpm --filter @synthos/web build` | pass; every route is server-rendered on demand |
| Browser tests (32: 16 desktop + 16 mobile) | `pnpm --filter @synthos/web test:e2e` | full run: **26 passed, 5 skipped** (desktop-only flows skipped on mobile; the ambiguous-submission test skips itself once the demo has no unclear job left), 1 failed on its last assertion (a locator matched several report notifications); after fixing the locator the full operator flow **passed** on rerun (`--grep "10h report"`). The first flow run takes up to 5 minutes because the +10h clock jump makes the whole demo backlog due at once. |
| Demo seed | `pnpm db:seed` | ~80–90 s; 100 accounts, 39 uploads, 5 campaigns, ~120 simulated posts, ~110 simulated analytics checks |

## What the core tests cover (`packages/core/src/**/*.test.ts`)

- **Organization and role isolation**: another organization's accounts, assets, campaigns and activity are invisible and un-editable; creator-scoped operators only see their creators; viewers are read-only; only owners manage workers; worker tokens authenticate by hash and reject tampering.
- **Content**: exact duplicates detected by SHA-256 across different filenames; same filename with different bytes is not a duplicate; undecodable bytes with a video extension become an *invalid* asset instead of crashing; size/type limits; resumable chunk offset recovery.
- **Approval binding and invalidation**: approval snapshots the caption/hash/version; editing an approved caption blocks the jobs, flags the campaign, and re-approval binds the new caption; changing an account's timezone invalidates again.
- **Pipeline**: claim → identity gate → `SUBMITTING` → verified post + analytics job (+10 h) + notification in one transaction; minimum spacing applied to the next job via `not_before`.
- **Concurrency and fencing**: two concurrent claims on the same account yield one job; stale fences and foreign workers are rejected; a late result on a superseded lease is refused.
- **Crash after `PREPARING`** → requeued with backoff; **crash after `SUBMITTING`** → `UNKNOWN_OUTCOME`, never auto-retried, not claimable, retry requires explicit confirmation, operator confirms the live URL (publication time marked *estimated*) and an analytics job is created.
- **Identity mismatch and login problems** block before Share, stop the account (`needs_review` / `needs_login`), raise `login_required`; the login handoff removes the account from claims and hands it back with blocked jobs retried.
- **Pauses**: global (owner-only), creator and account pauses stop claims and are re-checked right before Share (job returns to `READY`).
- **Content exhaustion**: slots without content are held with a `content_shortage` notification, never recycled.
- **Timezones/DST**: New York before/after the March 2026 change, London, Dubai and Sydney conversions; per-account day-one bursts and ongoing slots; finite limits; conflicts; coverage.
- **Ten-hour analytics**: nothing claimable before `due_at`; overdue check raises `missed_analytics` once; a 12-hour observation is stored with `is_late=true` and the real post age; missing metrics stored as unknown and the threshold evaluates to *unknown*.
- **Notifications**: deduplicated by event id; deliveries only for verified+enabled channels; failed delivery recorded and retried with backoff without touching the job; webhook secrets never returned; audit redaction strips tokens/webhooks.
- **Scheduler**: tick is idempotent; a silent worker is marked offline once and reconnects.
- **Hermes boundary**: result files validated against the contract; missing/malformed publish results become *unknown*; identity results parsed; capabilities marked UNVERIFIED.

## Browser tests (`apps/web/e2e`)

- `flow.spec.ts`
  - Upload (byte-unique copy of a sample) → assign creator → edit caption in the panel → create a one-post campaign for one account → approve once (checkbox acknowledgement) → the separate scheduler and simulator-worker processes publish it → Results panel shows the verified link labeled *Simulated* → **+10h** on the demo clock → analytics observed by the worker → report shows post age and `simulator:insights.plays` → notifications for `post_verified` and `analytics_complete` exist → clock reset.
  - Needs-login resolution: start login handoff (worker control released), hand back as logged in, blocked posts retried, account `ready`.
  - Ambiguous submission: retry refused until the operator confirms no post exists; "It is live" with the URL marks the job verified (`estimated` time) and schedules analytics. Skips itself when the demo has no unclear job left.
  - 100-account navigation: ⌘K switcher by `@handle`, scope carried into Schedule and Results, Needs-attention toggle, creator scope, pinned filter, ← → prev/next inside the panel with list position, unsaved-edit guard, no horizontal overflow (mobile included).
  - Viewer restrictions: no checkboxes/actions, People page refused, worker protocol refuses a user session.
- `screens.spec.ts`: every screen at 1440 px and 390 px renders an `h1`, shows the demo label, has no horizontal overflow and no uncaught browser errors.

## Visual verification (manual, from screenshots in `docs/screenshots/`)

Checked at 1440×900 and 390×844 after fixes:

- Fixed: filter selects stretching full width (Accounts, Content); "Next up" times wrapping; Today grid overflowing on mobile; a hidden select causing horizontal scroll on Schedule; filter tab strip not shrinking; Escape inside a modal closing the side panel underneath; auto-refresh re-rendering under an open modal; result-panel comparison table cramped on mobile.
- Verified: warm neutral surface, single accent; large thumbnails in Content; compact account rows grouped by creator; side panels keep list context with position counter; plain-language states with a "why" column; empty states on filtered views; offline banner logic; keyboard focus rings.
- Known cosmetic items not addressed: the sidebar demo card sits mid-height on very tall pages; calendar day cells cap at 7 visible posts with a "+N more" link to the list view.

## Not demonstrated

- Nothing was posted to Instagram. All publication and analytics in this report are simulated through the same services the browser worker would use.
- The Hermes adapter was exercised only against a fake script implementing the file contract, not against Hermes on the Mac mini.
- Throughput with 100 real accounts and real browser sessions was not measured; the demo shows that 100 accounts are navigable and that one simulator worker with concurrency 2 builds a visible backlog when many analytics checks come due at once.
