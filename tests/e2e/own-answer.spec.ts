// A solved stage shows the answer the player typed (#133), after a reload too, and only to that player: the admin
// live view and another player's progress never carry it. The test makes its own data through the API.
import { expect, test } from "@playwright/test";
import { ADMIN_KEY, answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

test("a solved stage shows the player's own answer; nobody else gets it", async ({ page, request, browser }) => {
  const username = randomUsername("own");
  await scheduleToday(request, CASE_ID);
  expect((await request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
  expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto(`/#/case/${CASE_ID}`);

  const typed = answerFor(CASE_ID, "q1");
  await page.locator(".answer-form input").fill(`  ${typed} `);
  await page.getByRole("button", { name: /check answer/i }).click();
  await expect(page.locator(".result-title")).toBeFocused();
  const own = page.locator(".result-panel .own-answer");
  await expect(own).toContainText("Your answer:");
  await expect(own.locator("code")).toHaveText(typed);

  // Stored, not just remembered by the page: still there after a reload.
  await page.reload();
  await page.getByRole("button", { name: /Stage 1.*\(solved\)/i }).first().click();
  await expect(page.locator(".result-panel .own-answer code")).toHaveText(typed);

  // The admin live view never carries it.
  const live = await request.get(`/api/admin/progress?caseId=${CASE_ID}`, { headers: { "x-admin-key": ADMIN_KEY } });
  expect(live.status()).toBe(200);
  expect(await live.text()).not.toContain('"solvedAnswer":"');

  // Another player on the same case has no answer to see.
  const other = await browser.newContext();
  const otherName = randomUsername("other");
  expect((await request.post("/api/auth/register", { data: { username: otherName, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(request, otherName);
  expect((await other.request.post("/api/auth/login", { data: { username: otherName, password: PASSWORD } })).status()).toBe(200);
  const view = await other.request.get(`/api/cases/${CASE_ID}/progress`);
  expect(view.status()).toBe(200);
  expect(await view.text()).not.toContain('"solvedAnswer":"');
  await other.close();
});
