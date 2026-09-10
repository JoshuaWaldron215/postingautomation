# Synthos posting — Instagram Reels dashboard for MAP Agency

An operations dashboard plus a durable scheduler and an execution-worker protocol for publishing
finished Reels to many Instagram accounts through a browser worker (Hermes on a Mac mini), with
verified results, ten-hour analytics reports and auditable exception handling.

**Status:** first working version. Everything runs locally in demo mode with a simulator worker.
The Hermes browser adapter is implemented to a file-based contract but is **unverified** against a
real Hermes installation (see `docs/mac-worker.md`). Nothing here claims 100-account throughput or
account safety; the demo data is synthetic and labeled as such in the UI.

## What is in the repository

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 16 dashboard (App Router, Tailwind 4, Radix). Also hosts the worker protocol API under `/api/worker/v1`. |
| `apps/scheduler` | Node process: promotes due jobs, expires stale leases, detects offline workers, schedules ten-hour analytics, raises missed checkpoints, delivers notifications. Runs without any browser tab open. |
| `apps/worker` | Node process that runs on the execution host (Mac mini with Hermes, or locally with the simulator). Outbound-only, token-authenticated. |
| `packages/core` | Domain: Drizzle schema + migrations, services (approval, jobs, analytics, notifications, audit), publisher adapters (simulator, Hermes boundary, future stubs), demo seed, tests. |
| `docs/` | Architecture, Mac worker setup, operator guide, test and visual verification report. |

## Quick start

```bash
git clone https://github.com/JoshuaWaldron215/postingautomation && cd postingautomation
git checkout claude/gallant-curie-6ihjgy
pnpm setup      # creates .env, databases, runs migrations and the demo seed (~2 min)
pnpm dev:all    # dashboard + scheduler + simulator worker in one terminal
```

Then open http://localhost:3000 and sign in with a demo login below. Requires Node 22+, pnpm and a local Postgres (`brew install postgresql@16 && brew services start postgresql@16` on a Mac).

## Local startup, step by step

Prerequisites: Node 22+, pnpm 10, Postgres 14+ reachable locally (Postgres 16 was used), ~500 MB disk.
ffmpeg/ffprobe are installed from npm (`ffmpeg-static`, `ffprobe-static`); nothing else is required.

```bash
pnpm install
cp .env.example .env                # then set APP_SECRET to a random value (openssl rand -hex 32)
createdb synthos_dev && createdb synthos_test   # or any DATABASE_URL you prefer
pnpm db:migrate                      # applies packages/core/drizzle/*.sql
pnpm db:seed                         # generates sample media, 100 demo accounts and several days of simulated history (~90 s)
```

`pnpm db:seed` prints the demo logins and writes the simulator worker token into `.env` as `WORKER_TOKEN`.
Stop the scheduler and worker before re-seeding (`pnpm db:reset` drops and recreates everything).

Run the three processes in separate terminals:

```bash
pnpm dev:web         # http://localhost:3000
pnpm dev:scheduler   # maintenance tick every 5 s
pnpm dev:worker      # simulator worker (WORKER_ADAPTER=simulator)
```

Sign in at http://localhost:3000/login:

| Role | Email | Password |
| --- | --- | --- |
| Owner | shafiq@map.agency | demo-owner-2026 |
| Operator | josh@synthos.dev | demo-operator-2026 |
| Viewer | riley@map.agency | demo-viewer-2026 |
| Operator limited to one creator | ana@map.agency | demo-scoped-2026 |

Quality checks:

```bash
pnpm typecheck      # all packages
pnpm lint           # eslint (web + node packages)
pnpm test           # core integration tests against TEST_DATABASE_URL (migrates a fresh schema each run)
pnpm build          # next build + tsc for node packages
```

## The six screens

- **Today** — what needs attention first: exceptions grouped by cause, accounts needing login/review, content shortages, late or failed analytics, offline workers; verified vs planned today; posting now / next up; recent verified posts with links; global pause (owners).
- **Content** — bulk drag-and-drop upload with per-file progress, chunked/resumable transfer and retry; server-side probing (ffprobe) and thumbnails; captions, creator assignment, tags, source order, explicit content families/variants; SHA-256 exact-duplicate detection; approval status and posting history per video.
- **Accounts** — grouped by creator, searchable, filterable by state, pinned and “needs attention” views, bulk pause/resume; side panel with history, session/identity status, login handoff, exception resolution, settings; previous/next navigation keeps list position.
- **Schedule** — campaigns (day-one template: 3 posts 5 min apart; ongoing template: chosen daily times), calendar and list views, conflict and coverage checks, preview and one-time approval, pause/resume/cancel with the consequences spelled out; job panel to resolve exceptions.
- **Results** — verified posts with links, publication time and its source, observation time and post age, metrics with their exact source labels, late flags, configurable threshold with explicit `>` / `≥`, similar-age comparison, family-sibling recommendations.
- **Activity** — auditable event log (actor, account, campaign, job, approval, attempt, state transition, error category, evidence, notification) with search, filters and CSV export.

Plus **Settings**: operating rules (analytics delay, lateness, threshold, spacing, retention), workers (tokens), notification destinations (Discord webhook with labeled test before delivery), people & roles.

## Key guarantees (and their limits)

- A campaign approval binds account, asset version/hash, exact caption, format/audience, schedule/timezone and limits. Editing any of these blocks the affected jobs until re-approval. The worker re-checks approval, pauses and the logged-in identity server-side before it is allowed to click Share.
- Jobs are claimed atomically (`FOR UPDATE SKIP LOCKED`), with per-account execution locks, leases, heartbeats and fencing tokens; stale workers cannot report results.
- `SUBMITTING` is persisted before publication. An expired lease while `SUBMITTING` becomes `UNKNOWN_OUTCOME` and is never retried automatically; a human confirms the live URL or confirms no post exists.
- Verified publication writes the verified post, the ten-hour analytics job and the notification in one transaction.
- Demo mode never gives jobs to a live adapter.
- An idempotency key makes our records exactly-once; it cannot make an external browser click exactly-once. See `docs/architecture.md`.

## Deploying beyond local

The schema is plain Postgres and runs unchanged on Supabase Postgres; media is stored on a private local disk (`STORAGE_DIR`) and would move to object storage with signed URLs when deploying. The scheduler and worker are long-running Node processes, not serverless functions. See `docs/architecture.md` for the boundaries and `docs/mac-worker.md` for the Hermes host.
