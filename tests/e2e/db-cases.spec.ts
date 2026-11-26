// #68: cases come only from the DB. A published case shows up on home, opens from a cold deep link, and reads
// its evidence from the location the content API names (the versioned /evidence/db/ path).
// Needs a server started with --seed-db-case (CI does).
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

// One test per language: each gets a fresh browser context, so the Explorer's download cache (which reuses
// immutable, versioned evidence without a request) cannot hide the fetch.
for (const lang of ["en", "he"]) {
  test(`the Explorer reads a DB case's evidence from its versioned path (${lang})`, async ({ page }) => {
    await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
    const requested: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/evidence/")) requested.push(new URL(r.url()).pathname);
    });
    await page.goto("/#/case/db-demo/explorer?f=logs/app.log");
    await expect(page.locator("main")).toContainText("hello");
    expect(requested).toContain("/evidence/db/db-demo/v1/files/logs/app.log");
    expect(requested.some((p) => p.startsWith("/evidence/db-demo/"))).toBe(false);
  });
}

test("the site lists exactly the API catalog, and an id outside it is a 404", async ({ page, request }) => {
  const ids = ((await (await request.get("/api/cases")).json()) as { cases: Array<{ en: { id: string } }> }).cases.map((c) => c.en.id);
  await page.goto("/#/");
  for (const id of ids) await expect(page.locator(`a[href="#/case/${id}"]`).first()).toBeVisible();
  await page.goto("about:blank");
  await page.goto("/#/case/no-such-case");
  await expect(page.locator("h1").first()).toHaveText(/does not exist/i);
});

test("no request reaches the pre-#68 static case paths", async ({ page }) => {
  const stale: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if ((path.startsWith("/evidence/") && !path.startsWith("/evidence/db/")) || /\/assets\/.*(3am-outage|ghost-in-the-network)[^/]*\.js$/.test(path)) stale.push(path);
  });
  await page.goto("/#/case/3am-outage/explorer?f=README_FIRST.txt");
  await expect(page.locator("main")).toContainText(/README|incident/i);
  expect(stale).toEqual([]);
});
