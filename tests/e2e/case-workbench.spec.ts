// The case workspace (#213, #216): above 1024px the question column keeps the answer above the fold with "Need help?"
// right under it, beside a Commands | Evidence | Hints workbench that follows the APG tabs pattern (arrows, Home/End,
// RTL) and keeps its tab in the URL; G then C/E/H switches panes unless "Shortcut keys" is off; the case header is
// one sticky status line with the page's only h1, "Costs so far" and the player's class event. Every test makes its
// own data through the API (CI is unseeded).
import { expect, test, type Page } from "@playwright/test";
import { randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

const ui = {
  tablist: (p: Page) => p.getByRole("tablist", { name: "Workbench" }),
  tab: (p: Page, name: string) => ui.tablist(p).getByRole("tab", { name: new RegExp(`^${name}`) }),
  field: (p: Page) => p.locator(".answer-form input"),
  status: (p: Page) => p.locator("header.case-status"),
};

/** A new player on Stage 1 of today's case; `before` runs after sign-up, before the page opens. */
async function onStageOne(page: Page, opts: { lang?: "en" | "he"; before?: () => Promise<void>; hash?: string } = {}): Promise<void> {
  const username = randomUsername("bench");
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await opts.before?.();
  await page.addInitScript((l) => localStorage.setItem("il.lang", l), opts.lang ?? "en");
  await page.goto(`/#/case/${CASE_ID}${opts.hash ?? ""}`);
  await expect(ui.field(page)).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await scheduleToday(request, CASE_ID);
});

test.describe("1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the answer is above the fold, help sits under it, and the status line is one line with the only h1", async ({ page }) => {
    await onStageOne(page);
    const field = await ui.field(page).boundingBox();
    expect(field).not.toBeNull();
    if (field !== null) expect(field.y + field.height).toBeLessThan(800);
    // "Need help?": the hint and the reveal directly under the answer, not below the commands.
    const help = page.getByRole("group", { name: "Need help?" });
    await expect(help.locator(".hint-trigger")).toBeVisible();
    await expect(help.locator(".reveal-trigger")).toBeVisible();
    const hint = await help.locator(".hint-trigger").boundingBox();
    if (field !== null && hint !== null) expect(hint.y - (field.y + field.height)).toBeLessThan(300);

    await expect(page.locator("h1")).toHaveCount(1);
    await expect(ui.status(page).locator("h1")).toHaveText("Ghost in the Network");
    await expect(ui.status(page)).toContainText(/Stage 1 of 6/);
    const line = await ui.status(page).locator(".cs-line").boundingBox();
    expect(line?.height ?? 999).toBeLessThanOrEqual(48);

    // "Costs so far": a popover from lib/overlay.ts; Escape returns focus to its button.
    const costs = ui.status(page).getByRole("button", { name: "Costs so far" });
    await costs.click();
    await expect(page.getByRole("dialog", { name: "Costs so far" })).toContainText(/Nothing spent yet/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Costs so far" })).toBeHidden();
    await expect(costs).toBeFocused();
  });

  test("workbench tabs: arrows, Home/End, the URL keeps the tab, and the pane shortcuts can be turned off", async ({ page }) => {
    await onStageOne(page);
    const commands = ui.tab(page, "Commands");
    await expect(commands).toHaveAttribute("aria-selected", "true");
    await expect(ui.tab(page, "Question")).toBeHidden(); // the question column is always in view on wide screens
    await expect(page.getByRole("tabpanel", { name: /^Commands/ }).locator(".tool-list .cmd").first()).toBeVisible();

    // One tab stop; arrows move and select (automatic activation).
    await commands.focus();
    await page.keyboard.press("ArrowRight");
    await expect(ui.tab(page, "Evidence")).toBeFocused();
    await expect(ui.tab(page, "Evidence")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: /^Evidence/ })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: /^Commands/ })).toBeHidden();
    await expect(page).toHaveURL(/[?&]pane=evidence/);
    await page.keyboard.press("End");
    await expect(ui.tab(page, "Hints")).toBeFocused();
    await expect(page.getByRole("tabpanel", { name: /^Hints/ })).toContainText(/No hints bought/);
    await page.keyboard.press("ArrowRight"); // wraps
    await expect(commands).toBeFocused();
    await page.keyboard.press("Home");
    await expect(commands).toHaveAttribute("aria-selected", "true");
    await expect(ui.tablist(page).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

    // The tab in the URL survives a reload.
    await ui.tab(page, "Evidence").click();
    await page.reload();
    await expect(ui.tab(page, "Evidence")).toHaveAttribute("aria-selected", "true");

    // G then H shows the hints; not while typing in the answer field.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await expect(ui.tab(page, "Hints")).toHaveAttribute("aria-selected", "true");
    await expect(ui.tab(page, "Hints")).toBeFocused();
    await ui.field(page).focus();
    await page.keyboard.type("gc");
    await expect(ui.tab(page, "Hints")).toHaveAttribute("aria-selected", "true");
    await expect(ui.field(page)).toHaveValue("gc");

    // Turned off in the display settings (WCAG 2.1.4): G then C does nothing.
    await page.evaluate(() => {
      const raw = localStorage.getItem("il.settings");
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      localStorage.setItem("il.settings", JSON.stringify({ ...(typeof parsed === "object" && parsed !== null ? parsed : {}), keyShortcuts: false }));
    });
    await page.reload();
    await expect(ui.tab(page, "Hints")).toHaveAttribute("aria-selected", "true");
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await expect(ui.tab(page, "Hints")).toHaveAttribute("aria-selected", "true");
  });

  test("a bought hint opens the Hints tab and takes focus", async ({ page }) => {
    await onStageOne(page);
    await page.getByRole("group", { name: "Need help?" }).locator(".hint-trigger").click();
    await page.getByRole("alertdialog").getByRole("button", { name: /^yes, spend/i }).click();
    await expect(page.locator('.hint[data-hint="0"]')).toBeFocused();
    await expect(ui.tab(page, "Hints")).toHaveAttribute("aria-selected", "true");
    await expect(ui.tab(page, "Hints")).toContainText("1/3");
    await expect(page).toHaveURL(/[?&]pane=hints/);
    // the penalty now shows on the meter and in "Costs so far"
    await expect(page.locator(".stage-meter .meter-item.is-minus")).toHaveCount(1);
    await ui.status(page).getByRole("button", { name: "Costs so far" }).click();
    await expect(page.getByRole("dialog", { name: "Costs so far" })).toContainText(/1 of \d+ hints/);
  });

  test("the status line shows the player's class event for this case", async ({ page }) => {
    await onStageOne(page, {
      before: async () => {
        const created = await page.request.post("/api/classes", { data: { name: "E2E bench class" } });
        expect(created.status(), await created.text()).toBe(201);
        const cls = ((await created.json()) as { class: { id: string } }).class;
        const now = Date.now();
        const patched = await page.request.patch(`/api/classes/${cls.id}`, {
          data: { event: { name: "Bench night", startsAt: new Date(now - 10 * 60_000).toISOString(), endsAt: new Date(now + 2 * 3600_000).toISOString(), freezeAt: null, announcement: null } },
        });
        expect(patched.status(), await patched.text()).toBe(200);
      },
    });
    const event = ui.status(page).locator(".cs-event");
    await expect(event).toBeVisible();
    await expect(event).toContainText("E2E bench class");
    await expect(event).toContainText("Bench night");
    await expect(event).toContainText(/ends in \d/);
  });
});

test("Hebrew: the tabs run right to left (ArrowLeft is the next tab)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await onStageOne(page, { lang: "he" });
  const commands = page.getByRole("tab", { name: /^פקודות/ });
  await commands.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: /^ראיות/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /^ראיות/ })).toHaveAttribute("aria-selected", "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("phones with a live class event (#275)", () => {
  for (const width of [390, 360]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

      test("the status line keeps the stage, the costs and the event, none cut off", async ({ page }) => {
        await onStageOne(page, {
          before: async () => {
            const created = await page.request.post("/api/classes", { data: { name: "E2E phone class" } });
            expect(created.status(), await created.text()).toBe(201);
            const cls = ((await created.json()) as { class: { id: string } }).class;
            const now = Date.now();
            const patched = await page.request.patch(`/api/classes/${cls.id}`, {
              data: { event: { name: "Phone night", startsAt: new Date(now - 10 * 60_000).toISOString(), endsAt: new Date(now + 2 * 3600_000).toISOString(), freezeAt: null, announcement: null } },
            });
            expect(patched.status(), await patched.text()).toBe(200);
          },
        });
        const status = ui.status(page);
        await expect(status.locator(".cs-event")).toContainText("Phone night");
        const layout = await status.locator(".cs-line").evaluate((line) => ({
          clipped: [...line.querySelectorAll<HTMLElement>(".cs-item")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
          overflow: line.scrollWidth - line.clientWidth,
          height: line.getBoundingClientRect().height,
        }));
        expect(layout.clipped).toEqual([]);
        expect(layout.overflow).toBeLessThanOrEqual(0);
        expect(layout.height).toBeLessThanOrEqual(76); // two rows: the line, then the event
        await expect(status.getByRole("button", { name: "Costs so far" })).toBeInViewport({ ratio: 1 });
      });
    });
  }
});
