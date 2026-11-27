// Load resilience (#208, #209): a stale route chunk reloads the page once and recovers, a second failure shows
// the "couldn't load" card instead of looping, a missing asset is a real 404, and a catalog outage on a case deep
// link is "couldn't load" with Try again, never the 404 card; a failed console load keeps the owner signed in.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME } from "./support";

const CASE_ID = "3am-outage";
/** The case route's own lazy chunk (Vite names it after views/case.ts; case-records is a static import of the entry). */
const CASE_CHUNK = /\/assets\/case-(?!records)[\w-]{8}\.js$/;

/** Counts full document loads, so a test can tell a reload from a re-render. */
function countLoads(page: Page): { count: () => number } {
  let loads = 0;
  page.on("load", () => loads++);
  return { count: () => loads };
}

test("a missing /assets file is a 404, never the SPA page", async ({ request }) => {
  const res = await request.get("/assets/case-from-an-old-deploy.js");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"] ?? "").not.toContain("text/html");
  // Other paths still get the SPA page.
  const page = await request.get("/some/old/path");
  expect(page.status()).toBe(200);
  expect(page.headers()["content-type"] ?? "").toContain("text/html");
});

test("a stale route chunk reloads the page once, then the route loads", async ({ page }) => {
  const loads = countLoads(page);
  let blocked = 0;
  await page.route(CASE_CHUNK, async (route) => {
    if (blocked === 0) {
      blocked++;
      // What an old deploy's chunk looks like now: gone.
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
      return;
    }
    await route.continue();
  });
  await page.goto(`/#/case/${CASE_ID}`);
  await expect.poll(loads.count).toBe(2); // the first load, then the one automatic reload
  await expect(page.locator(".load-failed")).toHaveCount(0);
  await expect(page.locator(".not-found")).toHaveCount(0);
  await expect(page.locator("main")).toContainText(/3 AM|outage/i);
  expect(blocked).toBe(1);
  // The route's code loaded after the reload, so the guard is cleared for a later deploy.
  expect(await page.evaluate(() => sessionStorage.getItem("incidentlab.chunkReload"))).toBeNull();
});

test("a chunk that stays missing shows the couldn't-load card after one reload, not a loop", async ({ page }) => {
  const loads = countLoads(page);
  await page.route(CASE_CHUNK, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
  await page.goto(`/#/case/${CASE_ID}`);
  const card = page.locator(".load-failed");
  await expect(card).toBeVisible();
  await expect(card.locator("h1")).toHaveText("Couldn't load this page");
  await expect(card.getByRole("button", { name: "Reload page" })).toBeVisible();
  await expect(page.locator(".not-found")).toHaveCount(0);
  await page.waitForTimeout(1500); // a loop would reload again within this window
  expect(loads.count()).toBe(2);
});

test("a catalog outage on a case deep link shows Try again, and Try again recovers", async ({ page }) => {
  let failing = true;
  await page.route(
    (url) => url.pathname === "/api/cases",
    async (route) => {
      if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      else await route.continue();
    },
  );
  await page.goto(`/#/case/${CASE_ID}`);
  const card = page.locator(".load-failed");
  await expect(card).toBeVisible({ timeout: 20_000 }); // the client retries a 5xx GET twice first
  await expect(card).toHaveAttribute("role", "alert");
  await expect(page.locator(".not-found")).toHaveCount(0);
  await expect(page.locator("h1").first()).not.toHaveText(/does not exist/i);
  failing = false;
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("main")).toContainText(/3 AM|outage/i);
});

test("the couldn't-load card is in Hebrew on a Hebrew page", async ({ page }) => {
  await page.route((url) => url.pathname === "/api/cases", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("il.lang", "he");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`/#/case/${CASE_ID}`);
  const card = page.locator(".load-failed");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(card.locator("h1")).toHaveText("לא הצלחנו לטעון את הדף");
  await expect(card.getByRole("button", { name: "לנסות שוב" })).toBeVisible();
});

test("a signed-in owner whose console fails to load sees Try again, never the admin-key form", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.status()).toBe(200);
  let failing = true;
  await page.route(
    (url) => url.pathname === "/api/admin/settings",
    async (route) => {
      if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      else await route.continue();
    },
  );
  await page.goto("/#/admin");
  const card = page.locator(".load-failed");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator("h1")).toHaveText("Couldn't load the console");
  await expect(page.locator("#admin-key")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("boom");
  failing = false;
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("#admin-key")).toHaveCount(0);
});
