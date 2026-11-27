// Home dashboard (#97): the "Continue" and "Today's case" cards over the cases table, search and the filter popover
// (keyboard, count badge, clear), filter state in the URL, a row opening its case, recent visits, the inner
// table scroll at 1440x900 and Hebrew RTL at 390px. Every test makes its own data through the API (CI is unseeded).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  continueCard: (p: Page) => p.getByRole("region", { name: /^(continue|how it works)$/i }),
  todayCard: (p: Page) => p.getByRole("region", { name: "Today's case" }),
  cases: (p: Page) => p.getByRole("region", { name: "Cases" }).first(),
  table: (p: Page) => p.locator("table.home-cases-table"),
  rows: (p: Page) => p.locator("table.home-cases-table tbody tr[data-case]"),
  row: (p: Page, id: string) => p.locator(`table.home-cases-table tbody tr[data-case="${id}"]`),
  search: (p: Page) => p.getByRole("searchbox", { name: "Search cases" }),
  filterButton: (p: Page) => p.getByRole("button", { name: /^Filter/ }),
  filterPanel: (p: Page) => p.getByRole("dialog", { name: "Filters" }),
  clearFilters: (p: Page) => ui.filterPanel(p).getByRole("button", { name: "Clear all" }),
  shown: (p: Page) => p.locator(".home-shown"),
};

async function signedInPlayer(page: Page, request: APIRequestContext): Promise<void> {
  const username = randomUsername("home");
  await scheduleToday(request, CASE_ID);
  expect((await request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
}

async function englishHome(page: Page, hash = "#/"): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto(`/${hash}`);
  await expect(ui.rows(page).first()).toBeVisible();
}

test("signed out: intro with sign-up and guest actions, how-it-works card, today's card and the table", async ({ page, request }) => {
  await scheduleToday(request, CASE_ID);
  await englishHome(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "About IncidentLab" }).getByRole("link", { name: "Create account" })).toBeVisible();
  await expect(ui.continueCard(page)).toContainText(/how it works/i);
  await expect(ui.todayCard(page)).toContainText("Ghost in the Network");
  await expect(ui.todayCard(page).getByRole("link", { name: "Play", exact: true })).toHaveAttribute("href", `#/case/${CASE_ID}`);
  await expect(ui.table(page).getByRole("columnheader", { name: /status/i })).toHaveCount(0);
  // home puts nothing in the page panel (filters live in the toolbar popover); #sidebar no longer exists, so
  // check the frame's real panel and that the shared filter button is the one in the toolbar
  await expect(page.locator("aside.page-aside")).toBeEmpty();
  await expect(page.locator(".page-aside-trigger, .aside-trigger")).toHaveCount(0);
});

test("signed in on today's case only: one card resumes it (no Continue card repeating it, #125)", async ({ page, request }) => {
  await signedInPlayer(page, request);
  const api = (path: string): string => `/api/cases/${CASE_ID}${path}`;
  expect((await page.request.get(api("/progress"))).status()).toBe(200);
  expect((await page.request.post(api("/setup-done"), { data: {} })).status()).toBe(200);
  expect((await page.request.post(api("/answer"), { data: { questionId: "q1", answer: answerFor(CASE_ID, "q1") } })).status()).toBe(200);
  await englishHome(page);
  await expect(ui.todayCard(page).getByRole("link", { name: "Resume" })).toHaveAttribute("href", `#/case/${CASE_ID}`);
  await expect(ui.todayCard(page)).toContainText(/in progress/i);
  await expect(ui.continueCard(page)).toHaveCount(0);
  await expect(page.locator(".home-top")).toHaveClass(/is-single/);
  // exactly one Resume path to the case above the table
  await expect(page.locator(".home-top").locator(`a[href="#/case/${CASE_ID}"]`).filter({ hasText: "Resume" })).toHaveCount(1);
  await expect(ui.row(page, CASE_ID)).toContainText("1/6");
  await expect(ui.row(page, CASE_ID)).toContainText(/in progress/i);
});

test("signed in with another case in progress: Continue lists it, not today's case", async ({ page, request }) => {
  await signedInPlayer(page, request);
  const other = "3am-outage";
  for (const id of [CASE_ID, other]) {
    expect((await page.request.get(`/api/cases/${id}/progress`)).status()).toBe(200);
    expect((await page.request.post(`/api/cases/${id}/setup-done`, { data: {} })).status()).toBe(200);
  }
  await englishHome(page);
  await expect(page.locator(".home-top")).not.toHaveClass(/is-single/);
  await expect(ui.continueCard(page).getByRole("link", { name: /3 AM Outage/ })).toBeVisible();
  await expect(ui.continueCard(page).getByRole("link", { name: /Ghost in the Network/ })).toHaveCount(0);
  await expect(ui.todayCard(page).getByRole("link", { name: "Resume" })).toHaveAttribute("href", `#/case/${CASE_ID}`);
});

test("search and the filter popover by keyboard, with the count badge, clear and the URL query", async ({ page, request }) => {
  await scheduleToday(request, CASE_ID);
  await englishHome(page);
  const total = await ui.rows(page).count();

  await ui.search(page).fill("ghost");
  await expect(ui.rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/#\/\?q=ghost$/);
  await ui.search(page).fill("");
  await expect(ui.rows(page)).toHaveCount(total);

  await ui.filterButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(ui.filterPanel(page)).toBeVisible();
  const hard = ui.filterPanel(page).getByRole("checkbox", { name: "Hard" });
  await expect(ui.filterPanel(page).getByRole("checkbox").first()).toBeFocused();
  await hard.focus();
  await page.keyboard.press("Space");
  await expect(hard).toBeChecked();
  await expect(ui.filterButton(page)).toHaveAccessibleName("Filter, 1 active");
  await expect(page).toHaveURL(/difficulty=hard/);
  for (const text of await ui.rows(page).locator("td:first-of-type").allTextContents()) expect(text).toContain("Hard");
  const hardRows = await ui.rows(page).count();
  expect(hardRows).toBeLessThan(total);

  await page.keyboard.press("Escape");
  await expect(ui.filterPanel(page)).toBeHidden();
  await expect(ui.filterButton(page)).toBeFocused();

  // The URL alone restores the view
  await page.reload();
  await expect(ui.rows(page)).toHaveCount(hardRows);
  await expect(ui.filterButton(page)).toHaveAccessibleName("Filter, 1 active");

  await ui.filterButton(page).click();
  await ui.clearFilters(page).click();
  await expect(ui.filterButton(page)).toHaveAccessibleName(/^Filter$/);
  await expect(ui.rows(page)).toHaveCount(total);
  await expect(page).toHaveURL(/#\/$/);
});

test("Enter on a row's case link opens the case, and the visit shows under Recently visited", async ({ page, request }) => {
  await signedInPlayer(page, request);
  await englishHome(page);
  await ui.row(page, CASE_ID).getByRole("link").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE_ID}$`));
  await expect(page.locator(".view h1, h1").first()).toBeVisible();
  // Opening today's case starts it: the Today card resumes it, so Continue (which would only repeat it) is gone.
  await page.goto("/#/");
  await expect(ui.todayCard(page).getByRole("link", { name: /Ghost in the Network/ })).toHaveCount(1);
  await expect(ui.continueCard(page)).toHaveCount(0);

  // The toolbox is a place of its own: it shows under "Recently visited".
  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  await expect(page.locator(".tb-section").first()).toBeVisible();
  await page.goto("/#/");
  await expect(ui.continueCard(page).getByRole("list", { name: "Recently visited" }).getByRole("link", { name: /Toolbox/ })).toHaveAttribute("href", `#/case/${CASE_ID}/toolbox`);

  // A plain click anywhere on another row opens that case too
  const other = page.locator(`table.home-cases-table tbody tr[data-case]:not([data-case="${CASE_ID}"])`).first();
  const id = await other.getAttribute("data-case");
  await other.locator("td").first().click();
  await expect(page).toHaveURL(new RegExp(`#/case/${id}$`));
});

test("1440x900: the page doesn't scroll; the table scrolls inside its panel", async ({ page, request }) => {
  await signedInPlayer(page, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await englishHome(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
  // A short window: the dashboard caps itself and the table becomes the scroller (header stays visible).
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
  const wrap = page.locator(".home-table");
  const scrolls = await wrap.evaluate((el) => el.scrollHeight > el.clientHeight);
  if (scrolls) {
    await wrap.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(ui.table(page).locator("thead th").first()).toBeInViewport();
  }
});

test("Hebrew at 390px: right-to-left, cards stacked, no horizontal overflow", async ({ page, request }) => {
  await signedInPlayer(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("il.lang", "he"));
  await page.goto("/#/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(ui.rows(page).first()).toBeVisible();
  const today = await page.getByRole("region", { name: "התיק של היום" }).boundingBox();
  const cont = await page.getByRole("region", { name: "להמשיך" }).boundingBox();
  expect(today !== null && cont !== null && today.y > cont.y).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
