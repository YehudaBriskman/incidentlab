// Answering from the Explorer and the Toolbox (#215): a docked "Current question" strip with the case page's own
// answer form. Its draft is the case page's draft, a solve offers "Next stage →" back to the case, and the case
// page in the same tab and in a second tab follows the answer. Signed out, the strip is the gate prompt instead.
// Every test makes its own player through the API (CI is unseeded).
import { expect, test, type Page } from "@playwright/test";
import { answerFor, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

const ui = {
  strip: (p: Page) => p.locator("section.q-strip"),
  stripField: (p: Page) => p.locator("section.q-strip .answer-form input"),
  stripCheck: (p: Page) => p.locator("section.q-strip .answer-form").getByRole("button", { name: "Check answer" }),
  stripDone: (p: Page) => p.locator("section.q-strip .q-strip-done"),
  stripToggle: (p: Page) => p.locator("section.q-strip .q-strip-toggle"),
  caseField: (p: Page) => p.locator("#stage .answer-form input"),
  caseKicker: (p: Page) => p.locator("#stage .stage-kicker"),
};

/** A new player on Stage 1 (the case started), in English. */
async function onStageOne(page: Page): Promise<void> {
  const username = randomUsername("strip");
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
}

test.beforeEach(async ({ request }) => {
  await scheduleToday(request, CASE_ID);
});

test.use({ viewport: { width: 1280, height: 800 } });

test("Explorer: the strip shares the case page's draft, and a solve moves the case page on in this tab and another", async ({ page, context }) => {
  await onStageOne(page);
  // A second tab on the case page, Stage 1.
  const other = await context.newPage();
  await other.goto(`/#/case/${CASE_ID}`);
  await expect(ui.caseKicker(other)).toContainText(/stage 1 of 6/i);

  await page.goto(`/#/case/${CASE_ID}/explorer?f=README_FIRST.txt`);
  const strip = ui.strip(page);
  await expect(strip).toHaveAccessibleName(/Current question/);
  // One line until opened: the stage line is a disclosure that shows the prompt.
  await expect(ui.stripToggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(ui.stripToggle(page)).toContainText(/Stage 1 of 6/);
  await ui.stripToggle(page).click();
  await expect(ui.stripToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(strip.locator(".q-strip-prompt")).toBeVisible();
  await ui.stripToggle(page).click();
  await expect(strip.locator(".q-strip-prompt")).toBeHidden();

  // The draft is the case page's draft: typed here, it is in the case's field after the round trip.
  await ui.stripField(page).fill("01:02:03");
  await page.getByRole("link", { name: /Back to case/ }).click();
  await expect(ui.caseField(page)).toHaveValue("01:02:03");
  await page.goBack();
  await expect(ui.stripField(page)).toHaveValue("01:02:03");

  // A solve announces itself in the strip, takes focus and offers the next stage on the case page.
  await ui.stripField(page).fill(answerFor(CASE_ID, "q1"));
  await ui.stripCheck(page).click();
  await expect(ui.stripDone(page)).toHaveText(/Stage 1 solved/);
  await expect(ui.stripDone(page)).toBeFocused();
  await expect(page.locator("body > p[role=status]")).toHaveText(/Solved/);

  // The other tab follows over the BroadcastChannel, with no reload.
  await expect(ui.caseKicker(other)).toContainText(/stage 2 of 6/i);

  // "Answer stage 2 here" keeps the player in the Explorer with the next question.
  await strip.getByRole("button", { name: "Answer stage 2 here" }).click();
  await expect(ui.stripToggle(page)).toContainText(/Stage 2 of 6/);
  await expect(ui.stripField(page)).toBeFocused();

  await page.reload();
  await expect(ui.stripToggle(page)).toContainText(/Stage 2 of 6/);
});

test("Toolbox: a wrong answer and a solve from the strip reach the case page, and Next stage leads there", async ({ page, context }) => {
  await onStageOne(page);
  const other = await context.newPage();
  await other.goto(`/#/case/${CASE_ID}`);
  await expect(ui.caseKicker(other)).toContainText(/stage 1 of 6/i);

  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  await expect(page.getByRole("heading", { level: 1, name: "All commands" })).toBeVisible();
  await expect(ui.stripToggle(page)).toContainText(/Stage 1 of 6/);

  // A wrong value is charged once and said in the strip; the other tab's meter counts it.
  await ui.stripField(page).fill("12:00:00");
  await ui.stripCheck(page).click();
  await expect(ui.strip(page).locator(".feedback")).toContainText(/wrong value/i);
  await expect(other.locator("#stage .answer-form .feedback")).toContainText("1 wrong attempt so far");

  await ui.stripField(page).fill(answerFor(CASE_ID, "q1"));
  await ui.stripCheck(page).click();
  await expect(ui.stripDone(page)).toHaveText(/Stage 1 solved/);
  await expect(ui.caseKicker(other)).toContainText(/stage 2 of 6/i);

  await ui.strip(page).getByRole("link", { name: "Next stage →" }).click();
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE_ID}$`));
  await expect(ui.caseKicker(page)).toContainText(/stage 2 of 6/i);
});

test("signed out, the Explorer's strip is the gate prompt; a guest then gets the start-the-case prompt", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto(`/#/case/${CASE_ID}/explorer`);
  const strip = ui.strip(page);
  await expect(strip).toContainText("Sign in to answer from here");
  await expect(strip.locator("input")).toHaveCount(0);
  await expect(strip.getByRole("link", { name: "Sign in on the case page" })).toHaveAttribute("href", `#/case/${CASE_ID}`);
  await strip.getByRole("button", { name: "Play as guest" }).click();
  await expect(strip).toContainText(/Start the case on the case page/);
  await expect(strip.locator("input")).toHaveCount(0);
});

test.describe("Explorer layout and filters (#217)", () => {
  const route = "/#/case/3am-outage/explorer";
  const count = (p: Page) => p.locator(".ex-count");
  const LOADED = / of [\d,]+ lines?/;
  const countOf = async (p: Page): Promise<number> => Number(/^([\d,]+) of/.exec((await count(p).textContent()) ?? "")?.[1]?.replace(/,/g, "") ?? "NaN");

  // Signed out on the 3 AM Outage, whose four examples wrap the filter row: the worst case for the fit layout.
  // CI fonts give one row fewer than a desktop at 1280x800 (14, locally 18 with a signed-in player).
  for (const [w, hgt, min] of [[1280, 800, 13], [1440, 900, 20]] as const) {
    test(`${w}x${hgt}: the log fills the height with no page scroll`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: hgt });
      await page.goto(`${route}?f=nginx/access.log`);
      await expect(count(page)).toHaveText(LOADED, { timeout: 60_000 });
      await expect.poll(() => page.locator(".ex-rows .ex-row[data-row]").count()).toBeGreaterThan(min);
      const m = await page.evaluate(() => {
        const content = document.querySelector("main.app-content");
        const vp = document.querySelector(".ex-viewport")?.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".ex-rows .ex-row[data-row]")].filter((r) => {
          const b = r.getBoundingClientRect();
          return vp !== undefined && b.top >= vp.top - 1 && b.bottom <= Math.min(vp.bottom, window.innerHeight) + 1;
        }).length;
        return { scrolls: content === null ? true : content.scrollHeight > content.clientHeight + 1, rows, bottom: vp?.bottom ?? 0 };
      });
      expect(m.scrolls).toBe(false);
      expect(m.rows).toBeGreaterThanOrEqual(min);
      expect(m.bottom).toBeLessThanOrEqual(hgt);
    });
  }

  test("empty state: no blank Examples row; a picked file shows its description in the title bar and no tooltip over the filters", async ({ page }) => {
    await page.goto(route);
    await expect(page.locator(".ex-presets")).toBeHidden();
    const file = page.getByRole("complementary", { name: /files/i }).getByRole("button", { name: /^deploys\/deploys\.log\b/ });
    await file.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await file.click();
    await expect(count(page)).toHaveText(LOADED, { timeout: 60_000 });
    await expect(page.locator(".ex-head .ex-file-desc")).not.toBeEmpty();
    await expect(page.locator(".ex-head .ex-file-desc")).toBeVisible();
    // the row under the pointer is the same element, so no tooltip comes back after the click
    await page.waitForTimeout(800);
    await expect(page.getByRole("tooltip")).toBeHidden();
  });

  test("filter chips: each active filter is a chip whose × removes it and moves focus on", async ({ page }) => {
    await page.goto(`${route}?f=deploys/deploys.log`);
    await expect(count(page)).toHaveText(LOADED, { timeout: 60_000 });
    const total = await countOf(page);
    const chips = page.getByRole("list", { name: "Active filters" });
    const quick = page.getByRole("textbox", { name: "Step 1 filter text" });
    await expect(chips).toBeHidden();
    // Step 1 is the quick filter in the toolbar (#280): it needs no chip of its own
    await quick.fill("DEPLOY");
    await expect.poll(() => countOf(page)).toBeLessThan(total);
    await expect(chips).toBeHidden();

    await page.getByRole("button", { name: "+ add filter", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Step 2 filter text" })).toBeFocused();
    await page.getByRole("textbox", { name: "Step 2 filter text" }).fill("checkout");
    await expect(chips.getByRole("listitem")).toHaveCount(1);
    await expect(chips).toContainText("contains checkout");
    await expect(page.getByRole("button", { name: /^Analyze \(1\)/ })).toBeVisible();

    // the chip's label opens the step where it is edited
    await page.getByRole("textbox", { name: "Step 2 filter text" }).blur();
    await chips.getByRole("button", { name: "contains checkout", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Step 2 filter text" })).toBeFocused();

    // removing step 1 moves step 2 into the quick filter
    await page.getByRole("button", { name: "Remove step 1" }).click();
    await expect(quick).toHaveValue("checkout");
    await expect(quick).toBeFocused();
    await expect(chips).toBeHidden();
    await quick.fill("");
    await page.keyboard.press("Enter");
    await expect.poll(() => countOf(page)).toBe(total);

    // a chip's × removes it and moves focus on (the next chip, else the quick filter)
    await quick.fill("DEPLOY");
    await page.getByRole("button", { name: "+ add filter", exact: true }).click();
    await page.getByRole("textbox", { name: "Step 2 filter text" }).fill("a");
    await page.getByRole("button", { name: "+ New step" }).click();
    await page.getByRole("textbox", { name: "Step 3 filter text" }).fill("b");
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await chips.getByRole("button", { name: "Remove filter: contains a" }).click();
    await expect(chips.getByRole("button", { name: "Remove filter: contains b" })).toBeFocused();
    await chips.getByRole("button", { name: "Remove filter: contains b" }).click();
    await expect(chips).toBeHidden();
    await expect(quick).toBeFocused();
  });

  test("Analyze: JSON conditions, columns and aggregations sit beside the log, with the count of active settings", async ({ page }) => {
    await page.goto(`${route}?f=app/checkout-service.log`);
    await expect(count(page)).toHaveText(LOADED, { timeout: 60_000 });
    const total = await countOf(page);
    const more = page.getByRole("button", { name: /^Analyze/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("combobox", { name: "Condition 1 field" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Plot", exact: true })).toBeHidden();

    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("tab", { name: "Filters" }).click();
    await page.getByRole("combobox", { name: "Condition 1 field" }).fill("level");
    await page.getByRole("textbox", { name: "Condition 1 value" }).fill("warn");
    await expect(more).toHaveText(/Analyze \(1\)/);
    await expect.poll(() => countOf(page)).toBeLessThan(total);
    await expect(page.getByRole("list", { name: "Active filters" })).toContainText("level equals warn");

    // APG tabs: arrows move between them, the panel follows
    await page.getByRole("tab", { name: "Filters" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Count unique values" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Count unique values" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "Plot", exact: true })).toBeVisible();

    // Escape closes the panel and returns to its button; the count stays and the chip still removes the condition.
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await expect(page.getByRole("combobox", { name: "Condition 1 field" })).toBeHidden();
    await expect(more).toHaveText(/Analyze \(1\)/);
    await page.getByRole("button", { name: "Remove filter: level equals warn" }).click();
    await expect(more).toHaveText(/^\W*Analyze$/);
    await expect.poll(() => countOf(page)).toBe(total);
  });
});
