import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

export async function login(page: Page, email = "shafiq@map.agency", password = "demo-owner-2026") {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/today/);
}

/** Runs a SQL statement against the dev database (psql). Used only to find demo ids and to nudge the simulated clock. */
export function sql(query: string): string {
  const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/synthos_dev";
  return execFileSync("psql", [url, "-tAc", query], { encoding: "utf8" }).trim();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, "page must not scroll horizontally").toBeLessThanOrEqual(inner + 1);
}
