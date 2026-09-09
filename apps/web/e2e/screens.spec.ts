import { test, expect } from "@playwright/test";
import { login, expectNoHorizontalOverflow } from "./helpers";

const SCREENS = ["/today", "/content", "/accounts", "/schedule", "/schedule?view=list", "/results", "/activity", "/settings", "/settings/workers", "/settings/notifications", "/settings/users"];

test.describe("every screen renders without errors or horizontal overflow", () => {
  for (const path of SCREENS) {
    test(`${path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await login(page);
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.locator("h1")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expect(page.getByText(/Demo data/).filter({ visible: true }).first()).toBeVisible();
      expect(errors, "no uncaught browser errors").toEqual([]);
    });
  }
});
