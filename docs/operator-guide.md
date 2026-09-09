# Operator guide

## Daily loop

1. Open **Today**. Work the "What needs attention" list top to bottom; every row links to the
   records behind it. When it says "Nothing needs you right now", posting is running by itself.
2. Check "Verified today" against "planned". Late posts show as *late*; nothing is skipped or
   squeezed into a burst.
3. Glance at Workers: an offline worker means its accounts are held, not lost.

## Activating a campaign

1. **Content** → *Upload Reels*. Drop finished MP4/MOV files, assign a creator, write the exact
   caption per video (empty captions are flagged). Group variants of the same idea into a content
   family so Results can recommend siblings later.
2. **Schedule** → *New campaign*: pick the creator and accounts, choose videos in posting order,
   set start/end dates (finite), the day-one template (3 posts, 5 minutes apart by default) and the
   ongoing daily times (the demo default 11:00/18:00 must be replaced with the client's real times),
   and optional per-account/total limits. The preview shows planned slots, content coverage and
   conflicts.
3. Open the campaign and **Approve** once. Approval binds each post to the account, the file hash and
   version, the exact caption, format/audience, schedule/timezone and limits. From then on the worker
   publishes without asking again. It stops only for real exceptions.

Planned times are targets. Actual publications on one account always keep the minimum spacing
(Settings → Operating rules), so a delayed post appears as late instead of piling up.

## Exceptions and how to resolve them

| State | What it means | What to do |
| --- | --- | --- |
| Needs login | The browser profile is logged out or Instagram asked for a challenge | Accounts → account → *Log in (handoff)*; log in on the Mac; *Hand session back*. Blocked posts retry automatically. |
| Needs review · logged-in account did not match | The profile was logged in as a different handle/user id; nothing was posted | Fix the profile on the Mac, then *Mark reviewed* (or retry the post) |
| Unclear result | Share may or may not have gone through | Check the profile on Instagram. *It is live* (paste the URL) or *Not live, retry* (confirm you checked) or cancel |
| Failed | Retries exhausted (network, Instagram error) | Read the attempts; *Retry now* or cancel |
| Approved content changed | Someone edited a caption/file/account binding after approval | Open the campaign and approve again |
| On hold · no content | The slot has no video | Upload more content and assign it in the job panel, then approve the campaign again; nothing is recycled automatically |
| Worker offline | No heartbeat for 90 s | Restart the worker; accounts resume where they left off |
| Analytics late / failed | The 10-hour check could not run on time | It runs when possible and is labeled late; retry from Results if failed |

## Pausing

- **Pause all** (top bar, owners): stops every new submission immediately. Anything already sent to
  Instagram cannot be undone; a post mid-submission finishes and is verified.
- **Pause creator / account / campaign**: same semantics at a narrower scope. Approval stays valid,
  so resuming needs no re-approval; overdue posts publish in order with the minimum spacing.
- **Login handoff**: while you hold a session, the worker will not use that account.

## Notifications

In-app notifications are always on. Discord delivery (Settings → Notifications) stays off until an
owner adds a webhook and *Send test* succeeds. Choose immediate exception alerts, per-post success
alerts, per-report alerts and a daily digest per destination.

## Deleting

Deleting a video removes it from the library (files are purged after the retention window) and
blocks approved posts that use it. It never deletes anything already on Instagram; remote deletion
is not part of this version.

## Navigating 100 accounts

- ⌘K / Ctrl+K opens the account switcher: type `@handle` or a creator name; toggle *Needs
  attention*; pick *All accounts*, a creator or one account. The scope carries across Today,
  Schedule and Results.
- Pin accounts from their panel; the *Pinned* filter and the switcher list them first.
- Inside a panel, ← / → move to the previous/next record in the current list, Esc closes. Unsaved
  edits are guarded; switching scope clears bulk selections so an action never lands on the wrong
  account.
