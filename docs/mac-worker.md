# Mac worker setup (Hermes browser adapter)

**Status: unverified.** This environment had no access to Josh's Mac mini, its Hermes installation,
its authenticated browser profiles or Hermes's supported invocation methods. The adapter below does
not assume any Hermes HTTP endpoint, CLI flag, structured-output guarantee or session-persistence
behavior. It defines a small file-based contract that a Hermes-side script must satisfy, and it
treats anything outside that contract conservatively (a publish with no readable result is an
*unclear* outcome, never a retry).

## What runs where

| On the Mac mini | In the cloud / office server |
| --- | --- |
| `apps/worker` (Node 22, `WORKER_ADAPTER=hermes`) | `apps/web` (dashboard + `/api/worker/v1`) |
| Hermes Desktop + one browser profile per account | `apps/scheduler` |
| The Hermes-side script that honors the task/result contract | Postgres |

The worker only makes **outbound** HTTPS calls to `APP_URL`. Do not expose Hermes, a browser
debugging port or a terminal to the internet.

## 1. Create the worker and token

Settings → Workers → *Add worker* → kind **Mac · Hermes browser**. Copy the token; it is shown once.
Tokens can be rotated or revoked at any time; a revoked worker's leases expire and its jobs are
handled by the scheduler.

## 2. Install the worker on the Mac

```bash
git clone <this repo> ~/synthos && cd ~/synthos
pnpm install --filter @synthos/worker --filter @synthos/core
cat > .env <<'ENV'
APP_URL=https://<your dashboard host>
WORKER_TOKEN=wk_...
WORKER_ADAPTER=hermes
WORKER_NAME=mac-mini-hermes
WORKER_MAX_CONCURRENCY=1
HERMES_COMMAND=/Users/<you>/synthos-hermes/run-task.sh
HERMES_WORKDIR=/Users/<you>/synthos-hermes/work
HERMES_PROFILES_DIR=/Users/<you>/synthos-browser-profiles
HERMES_TIMEOUT_MS=900000
ENV
pnpm --filter @synthos/worker start
```

Keep it alive with `launchd` (a sample plist is easy to add once the command path is known).

## 3. Browser profiles

One profile directory per account under `HERMES_PROFILES_DIR`, named by the account's
*browser profile key* (default `profile-<handle>`, visible in the account panel). Log each profile
in once through the **login handoff** in the dashboard (Accounts → account → *Log in (handoff)*):
while a person holds the session, the worker will not touch that account. Passwords are never
entered in the dashboard; cookies and session storage stay on the Mac. Separate profiles are an
identity-management requirement, not a guarantee against account linkage or enforcement.

## 4. The task/result contract the Hermes-side script must implement

The adapter invokes:

```
$HERMES_COMMAND --task <path/to/task-<id>.json> --result <path/to/result-<id>.json>
```

and waits for the process to exit (timeout `HERMES_TIMEOUT_MS`). It then reads the result file and
validates it (`packages/core/src/adapters/hermes.ts`, `HermesResultSchema`).

### task.json

```jsonc
{ "op": "verify_identity", "expectedHandle": "maya.fit", "profileDir": "/…/profile-maya.fit" }

{ "op": "publish", "expectedHandle": "maya.fit", "expectedIgUserId": "1784…", "profileDir": "…",
  "mediaPath": "/tmp/synthos-worker-media/<job>-sample.mp4", "caption": "exact caption",
  "format": "reel", "idempotencyKey": "<campaign>:<account>:<seq>" }

{ "op": "reconcile", "expectedHandle": "maya.fit", "profileDir": "…", "caption": "…", "idempotencyKey": "…" }

{ "op": "read_metrics", "expectedHandle": "maya.fit", "profileDir": "…",
  "postUrl": "https://www.instagram.com/reel/…/", "externalId": "…" }
```

### result.json

```jsonc
{ "op": "verify_identity", "sessionReady": true, "observedHandle": "maya.fit",
  "observedIgUserId": "1784…", "screenshotPath": "/…/identity.png" }

{ "op": "publish", "outcome": "verified",             // verified | failed | blocked | unknown
  "postUrl": "https://www.instagram.com/reel/…/", "externalId": "…",
  "publishedAt": "2026-09-09T14:03:11Z",             // required for verified
  "category": "login_required", "message": "…",      // for failed/blocked
  "screenshotPath": "/…/after-share.png" }

{ "op": "reconcile", "found": true, "postUrl": "…", "externalId": "…", "publishedAt": "…" }   // or false, or "unknown"

{ "op": "read_metrics", "outcome": "observed",        // observed | post_not_found | failed
  "observedAt": "2026-09-10T00:05:00Z",
  "metrics": [ { "name": "plays", "value": 1234, "source": "instagram_web:insights.plays" },
               { "name": "reach", "value": null, "source": "instagram_web:insights.reach", "note": "not shown" } ] }
```

Error categories: `account_mismatch`, `approval_changed`, `login_required`, `login_challenge`,
`unsupported_format`, `unclear_publication`, `authorization_revoked`, `paused`, `content_missing`,
`worker_lost`, `timeout`, `network`, `instagram_error`, `internal`.

Rules the script must follow:

1. `verify_identity` must read the *logged-in* account from the page (handle and, if possible, the
   numeric user id), never infer it from the profile folder name. The server compares it with the
   approved account before allowing `publish`.
2. `publish` must only report `verified` after seeing the post live (URL from the profile grid or
   the share confirmation). If Share was clicked and the outcome could not be confirmed, report
   `unknown`. Never click Share twice.
3. `reconcile` looks at the profile for a post matching the caption/idempotency key and reports
   `found: true/false`, or `"unknown"` if the page could not be read.
4. `read_metrics` reports only metrics that are actually visible, with their exact source label;
   omit or set `null` for anything unavailable. Never substitute views for plays or reach.
5. Write the result file atomically (write temp, rename) and exit 0. Screenshots are optional but
   recommended; the worker uploads them as evidence (they can contain account information and are
   retained per the evidence-retention setting).

## 5. Connecting Josh's existing Hermes test

The known fact is that Hermes Desktop on the Mac mini is posting to a test account through
Instagram's website. To plug it in:

1. Wrap that flow in a script that accepts `--task` / `--result` and implements `verify_identity`
   and `publish` exactly as above (the other two ops can return `{"op":"reconcile","found":"unknown"}`
   and `{"op":"read_metrics","outcome":"failed","category":"internal","message":"not implemented"}`
   initially).
2. Point `HERMES_COMMAND` at it, create the worker in Settings, start `apps/worker`.
3. In the dashboard, set `DEMO_MODE=false` on the server, create the test account under a creator,
   set its execution route to *Browser via Hermes* and assign the Mac worker.
4. Run the login handoff for the account once.
5. Create a one-post campaign with a real caption on the test account, approve it, and watch the
   Activity log: `job.claimed` → `job.submitting` (identity verified) → `job.verified_published`.

The smallest live validation is exactly that single post. Until it has been done, treat every
Hermes-related capability shown in the dashboard as **unverified**.

## Files

- `apps/worker/src/main.ts` — worker loop (heartbeat, claims, session checks, reconciliation).
- `apps/worker/src/client.ts` — protocol client.
- `packages/core/src/adapters/hermes.ts` — the adapter and result schema.
- `packages/core/src/protocol.ts` — request/response schemas for `/api/worker/v1`.
- `packages/core/src/adapters/hermes.test.ts` — contract tests using a fake Hermes-side script.
