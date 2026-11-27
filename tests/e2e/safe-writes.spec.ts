// Safe writes (#202, #203): a hint bought in another tab shows up here, a stale tab's purchase charges nothing and
// redraws from the server's progress, and a slow write is never re-sent.
import { expect, test } from "@playwright/test";
import { randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

const hintsRevealed = async (page: import("@playwright/test").Page): Promise<number> => {
  const res = await page.request.get(`/api/cases/${CASE_ID}/progress`);
  const body = (await res.json()) as { progress: { stages: { q1: { hintsRevealed: number } } } };
  return body.progress.stages.q1.hintsRevealed;
};

test.beforeEach(async ({ page, request }) => {
  await scheduleToday(request, CASE_ID);
  const username = randomUsername("safe");
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await page.request.get(`/api/cases/${CASE_ID}/progress`);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
});

test("a hint bought in another tab shows up in this one", async ({ page, context }) => {
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(page.locator(".hint-trigger")).toContainText(/hint 1/i);
  const other = await context.newPage();
  await other.goto(`/#/case/${CASE_ID}`);
  await other.locator(".hint-trigger").click();
  await other.getByRole("alertdialog").getByRole("button", { name: /^yes, spend/i }).click();
  await expect(other.locator('.hint[data-hint="0"]')).toBeVisible();
  // The first tab follows over the BroadcastChannel, without a reload.
  await expect(page.locator('.hint[data-hint="0"]')).toBeVisible();
  await expect(page.locator(".hint-trigger")).toContainText(/hint 2/i);
  expect(await hintsRevealed(page)).toBe(1);
});

test("a stale tab's hint purchase charges nothing and shows the latest progress", async ({ page }) => {
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(page.locator(".hint-trigger")).toContainText(/hint 1/i);
  // Bought behind the page's back (no tab hears of it): the page still offers hint 1.
  expect((await page.request.post(`/api/cases/${CASE_ID}/hint`, { data: { questionId: "q1" } })).status()).toBe(200);
  await page.locator(".hint-trigger").click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^yes, spend/i }).click();
  await expect(page.locator(".toast-host")).toContainText(/out of date, so nothing was charged/i);
  await expect(page.locator('.hint[data-hint="0"]')).toBeVisible();
  await expect(page.locator(".hint-trigger")).toContainText(/hint 2/i);
  expect(await hintsRevealed(page)).toBe(1);
});

test("a write that gets no response is not re-sent; the page shows what the server saved", async ({ page }) => {
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(page.locator(".answer-form input")).toBeVisible();
  let posts = 0;
  // The answer reaches the server, but the response is lost on the way back.
  await page.route("**/api/cases/*/answer*", async (route) => {
    posts++;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.locator(".answer-form input").fill("00:00:00");
  await page.getByRole("button", { name: /check answer/i }).click();
  await expect(page.locator(".toast-host")).toContainText(/didn't confirm that in time/i);
  expect(posts).toBe(1);
  const res = await page.request.get(`/api/cases/${CASE_ID}/progress`);
  const body = (await res.json()) as { progress: { stages: { q1: { wrongAttempts: number } } } };
  expect(body.progress.stages.q1.wrongAttempts).toBe(1);
});
