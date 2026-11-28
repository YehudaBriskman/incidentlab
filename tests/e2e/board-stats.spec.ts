// The leaderboard's periods, search and near-me window (#239), and the slimmed My stats (#240): achievement
// progress and the new player's zero state. Every test makes its own players through the API (CI is unseeded).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TAGS } from "./a11y-support";
import { answerFor, approveAccount, randomUsername } from "./support";

const CASE_ID = "3am-outage";
const PASSWORD = "e2e-password-123";

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
}

/**
 * Registers an approved player on `page`'s request context (its cookie becomes the session), and optionally opts
 * them in to the global board and solves the case's first stage without a hint.
 */
async function player(page: Page, prefix: string, opts: { board: boolean; solve: boolean }): Promise<string> {
  const username = randomUsername(prefix);
  const reg = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(page.request, username);
  if (opts.board) expect((await page.request.put("/api/me/board", { data: { show: true } })).status()).toBe(200);
  if (opts.solve) {
    const c = (path: string): string => `/api/cases/${CASE_ID}${path}`;
    expect((await page.request.get(c("/progress"))).status()).toBe(200);
    expect((await page.request.post(c("/setup-done"), { data: {} })).status()).toBe(200);
    const res = await page.request.post(c("/answer"), { data: { questionId: "q1", answer: answerFor(CASE_ID, "q1") } });
    expect(res.status(), await res.text()).toBe(200);
  }
  return username;
}

const rows = (page: Page) => page.locator(".lb-table tbody tr");

test("leaderboard periods: this week, this month and all time, in the URL and from the cached route", async ({ page }) => {
  await english(page);
  const me = await player(page, "e2eperiod", { board: true, solve: true });
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/leaderboard")) asked.push(new URL(r.url()).search);
  });
  await page.goto("/#/leaderboard");
  const period = page.getByRole("group", { name: "Period" });
  await expect(period.getByRole("radio", { name: "All time" })).toBeChecked();
  await expect(rows(page).filter({ hasText: me })).toHaveCount(1);
  await expect(page.locator(".lb-since")).toBeHidden();

  await period.getByText("This week").click();
  await expect(page).toHaveURL(/#\/leaderboard\?period=week$/);
  await expect(page.locator(".lb-since")).toContainText("Points scored since");
  await expect(rows(page).filter({ hasText: me })).toHaveCount(1); // solved just now: on this week's board
  expect(asked).toContain("?period=week");

  await period.getByText("This month").click();
  await expect(page).toHaveURL(/period=month/);
  await expect(page.locator(".lb-body table caption")).toContainText("This month");

  // The period survives a reload and carries over to projector mode.
  await page.reload();
  await expect(page.getByRole("group", { name: "Period" }).getByRole("radio", { name: "This month" })).toBeChecked();
  await expect(page.getByRole("link", { name: "Projector mode" })).toHaveAttribute("href", /period=month/);

  await page.getByRole("group", { name: "Period" }).getByText("All time").click();
  await expect(page).toHaveURL(/#\/leaderboard$/);
});

test("projector mode keeps the period and hides the board tools", async ({ page }) => {
  await english(page);
  await page.goto("/#/leaderboard?period=week&projector=1");
  await expect(page.locator(".lb-page.is-projector")).toBeVisible();
  await expect(page.locator(".lb-case-title")).toContainText("This week");
  await expect(page.locator(".lb-controls")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/leaderboard\?period=week$/);
});

test("find a player and jump to me: both cut the cached list, with a ±5 window around you", async ({ page }) => {
  await english(page);
  // Twelve others on the board, then the player: at least 13 rows, so the window is exactly 11.
  for (let i = 0; i < 12; i++) await player(page, "e2enear", { board: true, solve: true });
  const me = await player(page, "e2eme", { board: true, solve: true });
  await page.goto("/#/leaderboard");
  await expect(rows(page).filter({ hasText: me })).toHaveCount(1);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(r.url());
  });

  await test.step("search filters the loaded rows by name", async () => {
    const search = page.getByRole("searchbox", { name: "Find a player" });
    await search.fill(me.toUpperCase());
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(me);
    await expect(page.locator(".lb-view-status")).toHaveText(/^1 of \d+ players matches\.$/);
    await search.fill("no-such-player-zz");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator(".lb-view-status")).toHaveText("No player on this board matches that name.");
    await search.fill("");
    await expect(rows(page).filter({ hasText: me })).toHaveCount(1);
  });

  await test.step("Jump to me shows the 11 rows around the player and focuses their row", async () => {
    const jump = page.getByRole("button", { name: "Jump to me" });
    await jump.click();
    await expect(rows(page)).toHaveCount(11);
    const mine = page.locator(".lb-table tbody tr.is-me");
    await expect(mine).toContainText(me);
    await expect(mine).toBeFocused();
    await expect(page.locator(".lb-view-status")).toContainText("Showing the players around you");
    await expect(page.locator(".lb-body table caption")).toContainText("around you");
    const back = page.getByRole("button", { name: "Back to the top" });
    await expect(back).toHaveAttribute("aria-pressed", "true");
    await back.click();
    await expect(page.getByRole("button", { name: "Jump to me" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".lb-view-status")).toHaveText("");
  });
  // Neither search nor the window asked the server for anything.
  expect(calls.filter((u) => !u.includes("/api/leaderboard") && !u.includes("/api/event"))).toEqual([]);
});

test("Jump to me is offered only to a player on this board", async ({ page }) => {
  await english(page);
  await player(page, "e2enojump", { board: false, solve: true });
  await page.goto("/#/leaderboard");
  await expect(page.locator(".lb-body")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Jump to me" })).toHaveCount(0);
});

test("My stats: a new player gets one card with one next action, not a wall of zeros", async ({ page }) => {
  await english(page);
  await player(page, "e2ezero", { board: false, solve: false });
  await page.goto("/#/me");
  const zero = page.getByRole("region", { name: "Your stats start with your first stage" });
  await expect(zero).toBeVisible();
  const play = zero.getByRole("link", { name: /Play the start-here case/ });
  await expect(play).toHaveAttribute("href", /^#\/case\/[a-z0-9-]+$/);
  await expect(page.locator(".kpi-grid, .achievements, .per-case-table")).toHaveCount(0);
  await play.click();
  await expect(page).toHaveURL(/#\/case\//);
});

test("My stats: summary, progress, achievements with progress toward the locked ones, history", async ({ page }) => {
  await english(page);
  await player(page, "e2eprog", { board: true, solve: true });
  await page.goto("/#/me");
  await expect(page.getByRole("heading", { level: 2, name: "Progress per case" })).toBeVisible();
  await expect(page.locator(".stat-tile").filter({ hasText: "Global rank" })).toContainText(/#\d+ of \d+/);
  await expect(page.locator(".stat-tile").filter({ hasText: "Cases completed" })).toContainText("1 stage solved");
  const ach = (name: string) => page.locator(".ach").filter({ has: page.locator(".ach-label", { hasText: name }) });
  // One stage without a hint: 1 of 5 toward "No hints needed", and a streak of 1 toward "On a roll".
  await expect(ach("No hints needed")).toContainText("1 of 5 stages");
  await expect(ach("No hints needed").locator(".ach-meter")).toBeVisible();
  await expect(ach("On a roll")).toContainText("1 of 3 days");
  await expect(ach("First blood").locator(".ach-meter")).toHaveCount(0); // a feat: nothing to count
  await expect(page.locator(".detail-list")).toHaveCount(0); // the 7-item strip is gone
});

for (const lang of ["en", "he"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe: the week board near me, and My stats with progress (${lang}, ${scheme})`, async ({ browser }) => {
      for (const width of [1280, 390]) {
        const phone = width < 600;
        const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
        await context.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
        const page = await context.newPage();
        await player(page, "e2eaxe", { board: true, solve: true });
        const failing: string[] = [];
        const scan = async (where: string): Promise<void> => {
          const results = await new AxeBuilder({ page }).withTags([...TAGS, "best-practice"]).analyze();
          for (const v of results.violations) {
            if (["moderate", "serious", "critical"].includes(v.impact ?? "")) failing.push(`${width}px ${where} ${v.id}: ${v.help} e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`);
          }
        };
        await page.goto("/#/leaderboard?period=week");
        await expect(page.locator(".lb-table tbody tr.is-me")).toHaveCount(1);
        await page.locator(".lb-jump").click();
        await expect(page.locator(".lb-table tbody tr.is-me")).toBeFocused();
        await scan("leaderboard near me");
        await page.goto("/#/me");
        await expect(page.locator(".ach-meter").first()).toBeVisible();
        await scan("my stats");
        await context.close();
        expect(failing, failing.join("\n")).toEqual([]);
      }
    });
  }
}
