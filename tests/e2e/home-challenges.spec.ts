// Home and My stats for personal and class challenges (#183): a player in a class sees the class's live event and
// case of the day on home and their class rank on My stats; a player without classes sees the call to action; a
// guest sees the upgrade card. Every test makes its own data through the API (CI is unseeded).
import { expect, test, type Page } from "@playwright/test";
import { answerFor, randomUsername, scheduleToday } from "./support";

const PASSWORD = "e2e-password-123";
const TODAY_CASE = "ghost-in-the-network";
const CLASS_CASE = "3am-outage";

const ui = {
  classesCard: (p: Page) => p.getByRole("region", { name: "Your classes" }),
  ctaCard: (p: Page) => p.getByRole("region", { name: "Classes", exact: true }),
  streakCard: (p: Page) => p.getByRole("region", { name: "Your streak" }),
  guestCard: (p: Page) => p.getByRole("region", { name: "Keep your progress" }),
  statsClasses: (p: Page) => p.getByRole("region", { name: "Classes", exact: true }),
};

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
}

async function register(page: Page, prefix: string): Promise<string> {
  const username = randomUsername(prefix);
  const res = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return username;
}

test("a player in a class: the class event on home, the class rank on My stats", async ({ page, request }) => {
  await scheduleToday(request, TODAY_CASE);
  await english(page);
  await register(page, "e2echal");

  // A class with a live event night and its own case of the day, made through the API.
  const created = await page.request.post("/api/classes", { data: { name: "E2E challenge class" } });
  expect(created.status(), await created.text()).toBe(201);
  const cls = ((await created.json()) as { class: { id: string } }).class;
  const now = Date.now();
  const today = (await (await page.request.get("/api/today")).json()) as { timezone: string };
  const patched = await page.request.patch(`/api/classes/${cls.id}`, {
    data: {
      event: { name: "E2E incident night", startsAt: new Date(now - 10 * 60_000).toISOString(), endsAt: new Date(now + 2 * 3600_000).toISOString(), freezeAt: null, announcement: null },
      schedule: { timezone: today.timezone, defaultCaseId: CLASS_CASE, days: {} },
    },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  // One solve inside the window: it counts on the class board.
  const c = (path: string): string => `/api/cases/${CLASS_CASE}${path}`;
  expect((await page.request.get(c("/progress"))).status()).toBe(200);
  expect((await page.request.post(c("/setup-done"), { data: {} })).status()).toBe(200);
  const solved = await page.request.post(c("/answer"), { data: { questionId: "q1", answer: answerFor(CLASS_CASE, "q1") } });
  expect(solved.status(), await solved.text()).toBe(200);

  await page.goto("/#/");
  const card = ui.classesCard(page);
  const row = card.getByRole("link", { name: /E2E challenge class/ });
  await expect(row).toHaveAttribute("href", `#/class/${cls.id}`);
  await expect(row).toContainText("E2E incident night");
  await expect(row).toContainText(/ends in \d/);
  await expect(row).toContainText("The 3 AM Outage");
  await expect(card.getByRole("link", { name: "All classes" })).toHaveAttribute("href", "#/classes");
  await expect(ui.ctaCard(page)).toHaveCount(0);
  await expect(ui.streakCard(page)).toContainText("Next achievement");
  // home still lists the cases
  await expect(page.locator("table.home-cases-table tbody tr[data-case]").first()).toBeVisible();

  await page.goto("/#/me");
  const section = ui.statsClasses(page);
  const classRow = section.locator("tbody tr").filter({ hasText: "E2E challenge class" });
  await expect(classRow).toContainText("Owner");
  await expect(classRow).toContainText("#1 of 1");
  await expect(classRow.getByRole("link", { name: "E2E challenge class" })).toHaveAttribute("href", `#/class/${cls.id}`);
  await expect(page.locator(".stat-tile").filter({ hasText: "Global rank" })).toContainText("Global board, opt-in");
  // the global-board switch moved to Settings (#219): My stats links there
  await expect(page.getByRole("switch", { name: "Show me on the global leaderboard" })).toHaveCount(0);
  await expect(page.locator(".stats-settings-link a")).toHaveAttribute("href", "#/settings/privacy");
});

test("a player without classes sees the call to action on home and on My stats", async ({ page, request }) => {
  await scheduleToday(request, TODAY_CASE);
  await english(page);
  await register(page, "e2enocls");
  await page.goto("/#/");
  const cta = ui.ctaCard(page);
  await expect(cta.getByRole("link", { name: "Create or join a class" })).toHaveAttribute("href", "#/classes");
  await expect(ui.classesCard(page)).toHaveCount(0);
  await expect(ui.streakCard(page)).toContainText("0 days");
  await page.goto("/#/me");
  await expect(ui.statsClasses(page)).toContainText("You're not in a class yet.");
  await expect(ui.statsClasses(page).getByRole("link", { name: "Create or join a class" })).toHaveAttribute("href", "#/classes");
});

test("a guest sees the upgrade card on home and on My stats, and no class calls are made", async ({ page, request }) => {
  await scheduleToday(request, TODAY_CASE);
  await english(page);
  expect((await page.request.post("/api/guest", { data: {} })).status()).toBe(201);
  const classCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/classes")) classCalls.push(r.url());
  });
  await page.goto("/#/");
  const card = ui.guestCard(page);
  await expect(card).toContainText("join classes");
  await expect(ui.classesCard(page)).toHaveCount(0);
  await card.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("dialog", { name: /create your account/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/#/me");
  await expect(page.getByRole("region", { name: "Keep your progress" }).getByRole("button", { name: "Create account" })).toBeVisible();
  await expect(ui.statsClasses(page)).toContainText("Guests can't join classes");
  expect(classCalls).toEqual([]);
});

test("signed out: today's case says Play, and the intro offers sign-up and guest play", async ({ page, request }) => {
  await scheduleToday(request, TODAY_CASE);
  await english(page);
  await page.goto("/#/");
  const intro = page.getByRole("region", { name: "About IncidentLab" });
  await expect(intro.getByRole("link", { name: "Create account" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Today's case" }).getByRole("link", { name: "Play" })).toHaveAttribute("href", `#/case/${TODAY_CASE}`);
  await expect(page.locator(".home-chal")).toBeHidden();
  await intro.getByRole("button", { name: "Play as guest" }).click();
  // the account change reloads home for the guest
  await expect(ui.guestCard(page)).toBeVisible();
});
