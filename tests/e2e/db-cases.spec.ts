// #68: cases published in the DB show up next to the bundled ones, open from a cold deep link, and read their
// evidence from the versioned /evidence/db/ path. Needs a server started with --seed-db-case (CI does).
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const res = await request.get("/api/cases");
  const ids = ((await res.json()) as { cases: Array<{ en: { id: string } }> }).cases.map((c) => c.en.id);
  test.skip(!ids.includes("db-demo"), "server not started with --seed-db-case");
});

test("a DB case is listed on home and opens from a cold deep link", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator('a[href="#/case/db-demo"]').first()).toBeVisible();
  await page.goto("about:blank");
  await page.goto("/#/case/db-demo");
  await expect(page.locator("h1").first()).not.toHaveText(/not on the runbook|can't find/i);
});

test("the Explorer reads a DB case's evidence from its versioned path, in Hebrew too", async ({ page }) => {
  for (const lang of ["en", "he"]) {
    await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
    const requested: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/evidence/")) requested.push(new URL(r.url()).pathname);
    });
    await page.goto("/#/case/db-demo/explorer?f=logs/app.log");
    await expect(page.locator("main")).toContainText("hello");
    expect(requested).toContain("/evidence/db/db-demo/v1/files/logs/app.log");
    expect(requested.some((p) => p.startsWith("/evidence/db-demo/"))).toBe(false);
  }
});
