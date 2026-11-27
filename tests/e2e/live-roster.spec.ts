// Class Live counts the whole roster (#229) and a command reveal keeps the player at the card (#210).
import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const CASE_ID = "3am-outage";

async function player(browser: Browser, prefix: string): Promise<{ page: Page; username: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const username = randomUsername(prefix);
  const res = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return { page, username };
}

test("class Live lists members who haven't started and shares the class join link", async ({ browser }) => {
  const owner = await player(browser, "e2elro");
  const started = await player(browser, "e2elrs");
  const idle = await player(browser, "e2elri");

  const created = await owner.page.request.post("/api/classes", { data: { name: "E2E roster class" } });
  expect(created.status(), await created.text()).toBe(201);
  const { class: cls } = (await created.json()) as { class: { id: string; admin: { joinCode: string } } };
  for (const p of [started, idle]) {
    const joined = await p.page.request.post("/api/classes/join", { data: { code: cls.admin.joinCode } });
    expect(joined.status(), await joined.text()).toBe(200);
  }
  const assign = await owner.page.request.patch(`/api/classes/${cls.id}`, { data: { caseIds: [CASE_ID] } });
  expect(assign.status(), await assign.text()).toBe(200);

  // Empty Live: the share link is the class join link, not the site root.
  await owner.page.goto(`/#/class/${cls.id}/manage`);
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Live" }).click();
  await expect(owner.page.locator(".admin-share-url").first()).toContainText(`#/join/`);

  // One member opens the case: Live counts 1 of 2 and names the other.
  expect((await started.page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await started.page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await owner.page.reload();
  await owner.page.locator(".nav-sub").getByRole("link", { name: "Live" }).click();
  const notStarted = owner.page.locator(".live-not-started");
  await expect(notStarted.getByRole("heading", { name: "Not started (1)" })).toBeVisible();
  await expect(notStarted).toContainText(idle.username);
  await expect(notStarted).not.toContainText(started.username);
  await expect(owner.page.locator("#admin-live-tiles")).toContainText("of 2 members");
});

test("revealing a command on the case page keeps focus and scroll at that card", async ({ browser }) => {
  const p = await player(browser, "e2erev");
  expect((await p.page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await p.page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await p.page.goto(`/#/case/${CASE_ID}`);
  const reveal = p.page.locator("#stage .btn-reveal").last();
  const card = reveal.locator("xpath=ancestor::*[@data-tool][1]");
  await card.locator("summary").click(); // the row opens to show Reveal (#214)
  await reveal.scrollIntoViewIfNeeded();
  const toolId = await card.getAttribute("data-tool");
  expect(toolId).not.toBeNull();
  await reveal.click();
  await p.page.getByRole("button", { name: /Yes, spend/ }).click();
  const copy = p.page.locator(`#stage [data-tool="${toolId ?? ""}"] .btn-copy`).first();
  await expect(copy).toBeFocused();
  await expect(copy).toBeInViewport();
});
