import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { login, sql, expectNoHorizontalOverflow } from "./helpers";

const SAMPLE = path.resolve(process.cwd(), "../../packages/core/samples/sample-30.mp4");

test.describe("end-to-end operator flow (simulator)", () => {
  test("upload → assign → caption → schedule → approve → simulated publish → verified → 10h report → notification", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop flow; mobile checks are separate");
    test.setTimeout(600_000); // after the +10h jump the simulator works through the whole demo backlog before reaching this post
    await login(page, "josh@synthos.dev", "demo-operator-2026");
    // Start from real time in case an earlier run left the simulated clock advanced.
    sql(`update organizations set settings = jsonb_set(settings, '{simClockOffsetMs}', '0')`);

    // 1. Upload a Reel through the dashboard uploader (chunked).
    await page.goto("/content?upload=1");
    const stamp = Date.now().toString(36);
    const uploader = page.getByRole("region", { name: "Upload Reels" });
    await uploader.locator("select").selectOption({ label: "Priya Nair" });
    await uploader.locator("textarea").fill(`E2E caption ${stamp}`);
    // A byte-unique copy so the upload is a new asset (identical bytes would be flagged as an exact duplicate).
    const unique = path.join(os.tmpdir(), `e2e-${stamp}.mp4`);
    fs.writeFileSync(unique, Buffer.concat([fs.readFileSync(SAMPLE), Buffer.from(`e2e-${stamp}`)]));
    await uploader.locator("input[type=file]").setInputFiles(unique);
    await expect(uploader.getByText("Ready", { exact: true })).toBeVisible({ timeout: 60_000 });

    // 2. Open the asset panel, edit the caption, save.
    const assetId = sql(`select id from assets where caption like 'E2E caption ${stamp}%' order by created_at desc limit 1`);
    expect(assetId).toBeTruthy();
    await page.goto(`/content?asset=${assetId}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    const captionBox = page.getByRole("dialog").locator("textarea").first();
    await captionBox.fill(`E2E caption ${stamp} — edited`);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    // 3. Create a one-day campaign for one Priya account on the simulator worker, starting today (display tz).
    const accountId = sql(`select a.id from accounts a join creators c on c.id=a.creator_id join workers w on w.id=a.worker_id where c.name='Priya Nair' and w.name='local-simulator' and a.tags='{}' and a.state='ready' order by a.handle limit 1`);
    const handle = sql(`select handle from accounts where id='${accountId}'`);
    await page.goto(`/schedule?new=1&scope=account:${accountId}`);
    const dialog = page.getByRole("dialog", { name: "New campaign" });
    await dialog.getByPlaceholder("e.g. Maya · October launch").fill(`E2E ${stamp}`);
    await expect(dialog.getByText("1 account selected")).toBeVisible();
    await dialog.getByRole("button", { name: "Continue" }).click();
    // Day-one only, 1 post, starting a minute ago so it is due immediately.
    const tz = sql(`select timezone from accounts where id='${accountId}'`);
    const startDate = sql(`select to_char(now() at time zone '${tz}', 'YYYY-MM-DD')`);
    const firstTime = sql(`select to_char((now() - interval '2 minute') at time zone '${tz}', 'HH24:MI')`);
    await dialog.locator('input[type="date"]').first().fill(startDate);
    await dialog.locator('input[type="date"]').nth(1).fill(startDate);
    await dialog.getByRole("switch", { name: "Ongoing posts" }).click();
    await expect(dialog.getByRole("switch", { name: "Ongoing posts" })).toHaveAttribute("aria-checked", "false");
    const posts = dialog.locator('input[type="number"]').first();
    await posts.fill("1");
    await expect(posts).toHaveValue("1");
    await dialog.locator('input[type="time"]').fill(firstTime);
    await expect(dialog.locator('input[type="time"]')).toHaveValue(firstTime);
    await expect(posts).toHaveValue("1");
    await dialog.getByRole("button", { name: new RegExp(`e2e-${stamp}\\.mp4`) }).first().click();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByText("Planned posts")).toBeVisible();
    await expect(dialog.getByText("1", { exact: true }).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Create campaign" }).click();
    await expect(page.getByText("Campaign created")).toBeVisible();

    // 4. Approve once.
    const campaignId = sql(`select id from campaigns where name='E2E ${stamp}'`);
    await page.goto(`/schedule?campaign=${campaignId}`);
    await page.getByRole("button", { name: /^Approve/ }).click();
    await page.getByLabel(/I reviewed the captions/).check();
    await page.getByRole("button", { name: "Approve and let the worker post" }).click();
    await expect(page.getByText(/Approved 1 posts?/)).toBeVisible();
    // The approval snapshot binds the edited caption.
    expect(sql(`select approval_snapshot->>'caption' from posting_jobs where campaign_id='${campaignId}'`)).toBe(`E2E caption ${stamp} — edited`);

    // 5. The scheduler promotes and the simulator worker publishes (both run as separate processes).
    await expect.poll(() => sql(`select state from posting_jobs where campaign_id='${campaignId}'`), { timeout: 90_000, intervals: [2000] }).toBe("VERIFIED_PUBLISHED");
    const jobId = sql(`select id from posting_jobs where campaign_id='${campaignId}'`);

    // 6. Verified result with a link, labeled simulated.
    await page.goto(`/results?job=${jobId}&range=7d`);
    const panel = page.getByRole("dialog", { name: /Report for @/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Simulated").first()).toBeVisible();
    await expect(panel.getByRole("link", { name: /reel\// })).toBeVisible();
    await expect(panel.getByText(/due in|Due|Scheduled/).first()).toBeVisible();

    // 7. Advance the simulated clock by 10h; the scheduler makes the analytics job due and the worker observes it.
    await page.getByRole("button", { name: "+10h" }).click();
    await expect(page.getByText(/Simulated clock moved 10h forward/)).toBeVisible();
    await expect.poll(() => sql(`select a.state from analytics_jobs a join verified_posts v on v.id=a.verified_post_id where v.job_id='${jobId}'`), { timeout: 420_000, intervals: [3000] }).toBe("COMPLETE");
    await page.goto(`/results?job=${jobId}&range=7d`);
    await expect(panel.getByText("Post age", { exact: true })).toBeVisible();
    await expect(panel.getByText("simulator:insights.plays")).toBeVisible();
    await expect(panel.getByText(/Threshold plays/).first()).toBeVisible();

    // 8. Notifications exist for the verified post and the report.
    expect(sql(`select count(*) from notifications where job_id='${jobId}' and kind in ('post_verified','analytics_complete')`)).toBe("2");
    await page.goto("/today"); // leave the side panel so it cannot overlap the bell
    await page.getByRole("button", { name: /Notifications/ }).click();
    await page.getByRole("button", { name: "Recent" }).click();
    await expect(page.getByText(new RegExp(`report for @${handle}`)).first()).toBeVisible();
    // Reset the simulated clock so later tests see real time.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Reset" }).click();
  });

  test("needs-login resolution through the login handoff", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile");
    await login(page, "josh@synthos.dev", "demo-operator-2026");
    const accountId = sql(`select a.id from accounts a join creators c on c.id=a.creator_id where a.state='needs_login' and a.paused_at is null and c.paused_at is null and a.worker_id=(select id from workers where name='local-simulator') limit 1`);
    test.skip(!accountId, "demo data has no needs_login account on the simulator");
    const handle = sql(`select handle from accounts where id='${accountId}'`);
    await page.goto(`/accounts?state=needs_login&account=${accountId}`);
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Needs login").first()).toBeVisible();
    await panel.getByRole("button", { name: "Log in (handoff)" }).click();
    await page.getByRole("button", { name: /Start handoff/ }).click();
    await expect(page.getByText("Session handed to you")).toBeVisible();
    await expect(panel.getByText(/A person has the session/)).toBeVisible();
    expect(sql(`select session_control from accounts where id='${accountId}'`)).toBe("human_handoff");
    // Clear the demo scenario tag so the simulator reports a logged-in session afterwards.
    sql(`update accounts set tags='{}' where id='${accountId}'`);
    await panel.getByRole("button", { name: "Hand session back" }).click();
    await page.getByRole("button", { name: "Logged in, hand back" }).click();
    await expect(page.getByText("Session handed back")).toBeVisible();
    expect(sql(`select state from accounts where id='${accountId}'`)).toBe("ready");
    expect(sql(`select count(*) from posting_jobs where account_id='${accountId}' and state='BLOCKED' and error_category in ('login_required','login_challenge')`)).toBe("0");
    await expect(page.getByRole("dialog").getByText(`@${handle}`).first()).toBeVisible();
  });

  test("ambiguous submission is resolved by confirming the live URL", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile");
    await login(page, "josh@synthos.dev", "demo-operator-2026");
    const jobId = sql(`select id from posting_jobs where state='UNKNOWN_OUTCOME' limit 1`);
    test.skip(!jobId, "demo data has no unclear job");
    await page.goto(`/schedule?job=${jobId}`);
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Unclear result: the post may or may not be live")).toBeVisible();
    // Retry requires an explicit confirmation.
    await panel.getByRole("button", { name: "Not live, retry" }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "It is live" }).click();
    await page.getByPlaceholder("https://www.instagram.com/reel/…").fill("https://www.instagram.com/reel/e2e-confirmed/");
    await page.getByRole("button", { name: "Mark verified" }).click();
    await expect(page.getByText("Marked as verified live")).toBeVisible();
    expect(sql(`select state || ':' || published_at_source from posting_jobs where id='${jobId}'`)).toBe("VERIFIED_PUBLISHED:estimated");
    expect(sql(`select count(*) from analytics_jobs a join verified_posts v on v.id=a.verified_post_id where v.job_id='${jobId}'`)).toBe("1");
  });
});

test.describe("account navigation with 100 demo accounts", () => {
  test("switcher, scope, pinned/attention filters, prev/next and unsaved-edit guard", async ({ page }, testInfo) => {
    await login(page);
    // Account switcher by @handle.
    await page.getByRole("button", { name: /Choose scope/ }).click();
    await page.getByPlaceholder("Search @handle or creator…").fill("@maya.fit");
    await page.getByRole("option", { name: /@maya\.fit/ }).first().click();
    await expect(page).toHaveURL(/scope=account%3A|scope=account:/);
    await expect(page.getByRole("button", { name: /Choose scope/ })).toContainText("@maya.fit");
    // Scope carries into Schedule and Results.
    await page.getByRole("link", { name: "Schedule" }).first().click();
    await expect(page).toHaveURL(/schedule\?scope=account/);
    await page.getByRole("link", { name: "Results" }).first().click();
    await expect(page).toHaveURL(/results\?scope=account/);
    // Creator scope via the switcher; needs-attention toggle.
    await page.getByRole("button", { name: /Choose scope/ }).click();
    await page.getByRole("button", { name: /Needs attention/ }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.getByRole("button", { name: /Needs attention/ }).click();
    await page.getByRole("option", { name: /Theo Park/ }).first().click();
    await expect(page.getByRole("button", { name: /Choose scope/ })).toContainText("Theo Park");
    // Accounts list: pinned filter and prev/next in the panel with position preserved.
    await page.goto("/accounts?pinned=1");
    await expect(page.locator("main")).toContainText("3 in view");
    await page.goto("/accounts?sort=handle");
    await page.getByRole("button", { name: /^Open @/ }).first().click();
    const panel = page.getByRole("dialog");
    await expect(panel).toContainText("1 of ");
    await page.keyboard.press("ArrowRight");
    await expect(panel).toContainText("2 of ");
    await expect(page).toHaveURL(/sort=handle/);
    // Unsaved edit guard when moving to the next account.
    await panel.getByRole("tab", { name: "Settings" }).click();
    const nameInput = panel.locator("input").first();
    await nameInput.fill("Edited but not saved");
    await expect(panel.getByText("Unsaved changes")).toBeVisible();
    await panel.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toContainText("2 of ");
    await panel.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(panel).toContainText("3 of ");
    await expectNoHorizontalOverflow(page);
    if (testInfo.project.name === "mobile") {
      await page.goto("/today");
      await expectNoHorizontalOverflow(page);
      await page.goto("/schedule");
      await expectNoHorizontalOverflow(page);
    }
  });

  test("viewer cannot act; owner-only global pause is enforced server-side", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name === "mobile");
    await login(page, "riley@map.agency", "demo-viewer-2026");
    await page.goto("/accounts");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.goto("/settings/users");
    await expect(page.getByText("Only owners can manage people")).toBeVisible();
    // Viewer session cannot call the worker protocol either.
    const res = await request.post("/api/worker/v1/jobs/claim", { data: { max: 1 } });
    expect(res.status()).toBe(401);
  });
});
