// The case stage on phones (#132): at 390px a sticky [input][Check] bar shows while the real answer field is off
// screen and answers through the same form; command cards fold to title and syntax; the Explorer tip sits right
// under the question. Every test makes its own data through the API (CI is unseeded).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

const ui = {
  bar: (p: Page) => p.getByRole("form", { name: "Answer this stage" }),
  barInput: (p: Page) => ui.bar(p).getByRole("textbox"),
  barCheck: (p: Page) => ui.bar(p).getByRole("button", { name: "Check" }),
  field: (p: Page) => p.locator(".answer-form input"),
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
  test.use({ viewport: { width: 390, height: 844 } });

  test("the sticky answer bar shows while the field is off screen and answers through the same form", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await onStageOne(page, request);

    // At the top of the stage the field is below the fold: the bar is on screen, at the bottom of the viewport.
    await page.locator(".stage-goal").scrollIntoViewIfNeeded();
    const fieldBox = await ui.field(page).boundingBox();
    expect(fieldBox === null || fieldBox.y > 844 || fieldBox.y + fieldBox.height < 0, "the field starts off screen at 390px").toBe(true);
    await expect(ui.bar(page)).toBeVisible();
    await expect(ui.bar(page)).toBeInViewport();
    const barBox = await ui.bar(page).boundingBox();
    expect(barBox).not.toBeNull();
    if (barBox !== null) expect(barBox.y + barBox.height).toBeGreaterThan(844 - 120);

    // Typing in the bar fills the real field (the same draft); a malformed answer is caught in the bar, for free.
    await ui.barInput(page).fill("not a time");
    await expect(ui.field(page)).toHaveValue("not a time");
    await ui.barCheck(page).click();
    await expect(ui.barInput(page)).toHaveAttribute("aria-invalid", "true");
    await expect(ui.bar(page)).toContainText(/nothing was charged/i);
    await expect(ui.barInput(page)).toBeFocused(); // focus stays in the bar, the page doesn't jump

    // Scrolled to the real field, the bar steps aside (once focus leaves it).
    await ui.field(page).scrollIntoViewIfNeeded();
    await ui.field(page).focus();
    await expect(ui.bar(page)).toBeHidden();
    await expect(ui.field(page)).toHaveValue("not a time");

    // Back at the top, the right answer from the bar solves the stage.
    await page.locator(".stage-goal").scrollIntoViewIfNeeded();
    await ui.field(page).evaluate((el) => (el as HTMLInputElement).blur());
    await expect(ui.bar(page)).toBeVisible();
    await ui.barInput(page).fill(answerFor(CASE_ID, "q1"));
    await ui.barInput(page).press("Enter");
    await expect(page.locator(".result-title")).toBeFocused();
    await expect(ui.bar(page)).toHaveCount(0); // solved stages have no bar
    expect(errors).toEqual([]);
  });

  test("command cards fold to title and syntax; the Explorer tip sits under the question", async ({ page, request }) => {
    await onStageOne(page, request);
    const card = page.locator(".tool-list .cmd").first();
    await expect(card.locator("h4")).toBeVisible();
    await expect(card.locator(".code-wrap")).toBeVisible();
    await expect(card.locator(".cmd-more")).toBeHidden();
    const toggle = card.getByRole("button", { name: /^Details/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".cmd-more")).toBeVisible();

    const tip = page.locator(".stage > .tip");
    if ((await tip.count()) > 0) {
      // the tip comes straight after the question card, before the commands
      const order = await page.evaluate(() => [...document.querySelectorAll(".stage > *")].map((el) => el.className));
      const q = order.findIndex((c) => c.includes("question-box"));
      expect(order[q + 1]).toContain("tip");
    }
  });

  test("Hebrew: the bar is right-to-left around an LTR answer field, with no horizontal overflow", async ({ page, request }) => {
    await onStageOne(page, request, "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.locator(".stage-goal").scrollIntoViewIfNeeded();
    await expect(page.getByRole("form", { name: "תשובה לשלב" })).toBeVisible();
    await expect(page.getByRole("form", { name: "תשובה לשלב" }).getByRole("textbox")).toHaveCSS("direction", "ltr");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("desktop: no answer bar and no Details toggles", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await onStageOne(page, request);
  await expect(page.locator(".answer-bar")).toBeHidden();
  await expect(page.locator(".cmd-more-toggle").first()).toBeHidden();
  await expect(page.locator(".tool-list .cmd .cmd-more").first()).toBeVisible();
});
