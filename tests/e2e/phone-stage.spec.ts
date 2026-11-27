// The case stage on phones (#132, #213, #218): at 390px a segmented Question | Commands | Evidence control switches
// panes, and a [input][Check] bar pinned to the bottom edge shows while the real answer field is off screen (another
// pane), answers through the same form and never covers a focused control; command rows show title and syntax and
// open for details (#214); Evidence leads into the Explorer. Every test makes its own data through the API.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

const ui = {
  bar: (p: Page) => p.getByRole("form", { name: "Answer this stage" }),
  barInput: (p: Page) => ui.bar(p).getByRole("textbox"),
  barCheck: (p: Page) => ui.bar(p).getByRole("button", { name: "Check" }),
  field: (p: Page) => p.locator(".answer-form input"),
  tab: (p: Page, name: string) => p.getByRole("tablist", { name: "Workbench" }).getByRole("tab", { name: new RegExp(`^${name}`) }),
};

/** A signed-in player with Stage 1 active on today's case. */
async function onStageOne(page: Page, request: APIRequestContext, lang: "en" | "he" = "en"): Promise<void> {
  const username = randomUsername("phone");
  await scheduleToday(request, CASE_ID);
  expect((await request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
  expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(ui.field(page)).toBeAttached();
}

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the pinned answer bar shows on the other panes, answers through the same form and never hides focus", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await onStageOne(page, request);

    // The Question pane holds the real field: the bar stays out of the way.
    await expect(ui.tab(page, "Question")).toHaveAttribute("aria-selected", "true");
    await expect(ui.field(page)).toBeVisible();
    await expect(ui.bar(page)).toBeHidden();

    // On Commands the field is in a hidden pane: the bar is pinned to the bottom edge (#218).
    await ui.tab(page, "Commands").click();
    await expect(page).toHaveURL(/[?&]pane=commands/);
    await expect(ui.bar(page)).toBeVisible();
    await expect(ui.bar(page)).toBeInViewport();
    expect(await ui.bar(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    const barBox = await ui.bar(page).boundingBox();
    expect(barBox).not.toBeNull();
    if (barBox !== null) expect(844 - (barBox.y + barBox.height)).toBeLessThanOrEqual(16);

    // A focused control is never under the bar (WCAG 2.4.11): focus the last command row from the top of the page.
    await page.evaluate(() => document.querySelector(".app-content")?.scrollTo(0, 0));
    const last = page.locator(".tool-list .cmd-sum").last();
    await last.focus();
    await expect(last).toBeFocused();
    const rowBox = await last.boundingBox();
    const barNow = await ui.bar(page).boundingBox();
    expect(rowBox !== null && barNow !== null && rowBox.y + rowBox.height <= barNow.y, `row ${JSON.stringify(rowBox)} vs bar ${JSON.stringify(barNow)}`).toBe(true);

    // Typing in the bar fills the real field (the same draft); a malformed answer is caught in the bar, for free.
    await ui.barInput(page).fill("not a time");
    await expect(ui.field(page)).toHaveValue("not a time");
    await ui.barCheck(page).click();
    await expect(ui.barInput(page)).toHaveAttribute("aria-invalid", "true");
    await expect(ui.bar(page)).toContainText(/nothing was charged/i);
    await expect(ui.barInput(page)).toBeFocused(); // focus stays in the bar, the page doesn't jump

    // Back on the Question pane the real field has the same draft, and the bar steps aside once focus leaves it.
    await ui.tab(page, "Question").click();
    await expect(ui.field(page)).toHaveValue("not a time");
    await expect(ui.bar(page)).toBeHidden();

    // The right answer from the bar on the Evidence pane solves the stage and shows the result.
    await ui.tab(page, "Evidence").click();
    await expect(ui.bar(page)).toBeVisible();
    await ui.barInput(page).fill(answerFor(CASE_ID, "q1"));
    await ui.barInput(page).press("Enter");
    await expect(page.locator(".result-title")).toBeFocused();
    await expect(ui.bar(page)).toHaveCount(0); // solved stages have no bar
    expect(errors).toEqual([]);
  });

  test("command rows show title and syntax and open for details; Evidence leads into the Explorer", async ({ page, request }) => {
    await onStageOne(page, request);
    await ui.tab(page, "Commands").click();
    const row = page.locator(".tool-list .cmd").first();
    await expect(row.locator(".cmd-title")).toBeVisible();
    await expect(row.locator(".cmd-line")).toBeVisible();
    await expect(row.locator(".cmd-body")).toBeHidden();
    const summary = row.locator("summary");
    expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44); // a touch-sized row
    await summary.click();
    await expect(row).toHaveAttribute("open", "");
    await expect(row.locator(".cmd-body")).toBeVisible();
    await expect(row.locator(".btn-reveal")).toBeVisible();

    // The Evidence pane: the way into the Explorer, and every file as a link that opens it there.
    await ui.tab(page, "Evidence").click();
    const evidence = page.getByRole("tabpanel", { name: /^Evidence/ });
    await expect(evidence.getByRole("link", { name: /Evidence Explorer/ })).toBeVisible();
    expect(await evidence.locator(`a.ev-link[href^="#/case/${CASE_ID}/explorer?f="]`).count()).toBeGreaterThan(0);
    // the segments are touch-sized
    for (const tab of await page.getByRole("tablist", { name: "Workbench" }).getByRole("tab").all()) expect((await tab.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("Hebrew: the bar is right-to-left around an LTR answer field, with no horizontal overflow", async ({ page, request }) => {
    await onStageOne(page, request, "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByRole("tab", { name: /^פקודות/ }).click();
    await expect(page.getByRole("form", { name: "תשובה לשלב" })).toBeVisible();
    await expect(page.getByRole("form", { name: "תשובה לשלב" }).getByRole("textbox")).toHaveCSS("direction", "ltr");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("desktop: no answer bar; command rows are one line each and start closed", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await onStageOne(page, request);
  await expect(page.locator(".answer-bar")).toBeHidden();
  const rows = page.locator(".tool-list .cmd");
  await expect(rows.first().locator(".cmd-body")).toBeHidden();
  // one shell switch for the stage's list, no per-row tabs
  await expect(page.locator(".tool-list").getByRole("tab")).toHaveCount(0);
  await expect(page.locator("#stage").getByRole("radio", { name: "PowerShell", exact: true })).toHaveCount(1);
  for (const height of await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(height).toBeLessThan(64);
});
