// Full player walkthrough in a real browser: sign up -> approval -> today's incident -> setup ->
// (paid command reveal) -> wrong + right answer -> stats -> sign out -> admin sign-in -> dashboard.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  username: (p: Page) => p.getByLabel("Username", { exact: true }),
  password: (p: Page) => p.getByLabel("Password", { exact: true }),
  createAccount: (p: Page) => p.getByRole("button", { name: /^create account$/i }),
  signInSubmit: (p: Page) => p.locator("form").getByRole("button", { name: /^sign in$/i }),
  pendingTitle: (p: Page) => p.getByText(/waiting for approval/i),
  checkNow: (p: Page) => p.getByRole("button", { name: /check now/i }),
  todayCard: (p: Page) => p.locator(".today-card"),
  openTodayCase: (p: Page) => ui.todayCard(p).locator(`a[href^="#/case/"]`).first(),
  readyButton: (p: Page) => p.getByRole("button", { name: /ready/i }),
  answerInput: (p: Page) => p.locator(".answer-form input"),
  answerSubmit: (p: Page) => p.locator(".answer-form").getByRole("button", { name: /check answer/i }),
  wrongFeedback: (p: Page) => p.locator(".feedback.is-wrong"),
  revealCommand: (p: Page) => p.getByRole("button", { name: /reveal full command/i }),
  // Inline confirm ("Yes, −5 pts · charged to stage 1") or a dialog's confirm button.
  revealConfirm: (p: Page) => p.getByRole("button", { name: /^(yes|confirm)\b/i }),
  stageCurrent: (p: Page, n: number) => p.getByRole("button", { name: new RegExp(`^Stage ${n}:.*\\(current\\)`) }),
  totalScore: (p: Page) => p.locator(".stat-tile", { hasText: /total score/i }).locator(".stat-value"),
  signOut: (p: Page) => p.getByRole("button", { name: /^sign out$/i }).first(),
  headerSignIn: (p: Page) => p.getByRole("banner").getByRole("link", { name: /^sign in$/i }),
  adminKeyPrompt: (p: Page) => p.getByLabel(/admin key/i),
  adminDashboard: (p: Page) => p.getByRole("heading", { name: /class dashboard/i }),
};

type Progress = {
  score: number;
  stages: Record<string, { status: string; commandsRevealed: number; breakdown: { commands: number; wrong: number; total: number } | null }>;
};

async function fetchProgress(page: Page): Promise<Progress> {
  // page.request shares the browser context's cookies, so this is the signed-in player's view.
  const res = await page.request.get(`/api/cases/${CASE_ID}/progress`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { progress: Progress }).progress;
}

test("player walkthrough: sign up to first solved stage, then admin sign-in", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const username = randomUsername("e2e");

  await test.step("schedule today's incident", async () => {
    await scheduleToday(request, CASE_ID);
  });

  await test.step("sign up -> pending screen", async () => {
    await page.goto("/#/signup");
    await ui.username(page).fill(username);
    await ui.password(page).fill(PASSWORD);
    await ui.createAccount(page).click();
    await expect(ui.pendingTitle(page)).toBeVisible();
  });

  await test.step("admin approves via API -> home shows today's incident", async () => {
    await approveAccount(request, username);
    await ui.checkNow(page).click();
    await page.goto("/#/");
    await expect(ui.todayCard(page)).toBeVisible();
    await expect(ui.todayCard(page)).toContainText(/incident of the day/i);
  });

  await test.step("open the case and finish setup", async () => {
    await ui.openTodayCase(page).click();
    await expect(page).toHaveURL(new RegExp(`#/case/${CASE_ID}`));
    await ui.readyButton(page).click();
    await expect(ui.answerInput(page)).toBeVisible();
  });

  let revealedCommand = false;
  await test.step("reveal one full command (if the paid reveal UI exists)", async () => {
    const reveal = ui.revealCommand(page).first();
    if ((await reveal.count()) === 0) {
      test.info().annotations.push({ type: "skipped-step", description: "No 'Reveal full command' button in this UI build" });
      return;
    }
    page.once("dialog", (dialog) => void dialog.accept()); // native confirm()
    await reveal.click();
    const confirm = ui.revealConfirm(page).first();
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click(); // in-page confirm
    await expect.poll(async () => (await fetchProgress(page)).stages.q1?.commandsRevealed ?? 0).toBe(1);
    revealedCommand = true;
  });

  await test.step("wrong answer, then the right q1 answer", async () => {
    await ui.answerInput(page).fill("00:00:00"); // right format (HH:MM:SS), wrong value: a malformed answer is rejected for free
    await ui.answerSubmit(page).click();
    await expect(ui.wrongFeedback(page)).toBeVisible();

    await ui.answerInput(page).fill(answerFor(CASE_ID, "q1"));
    await ui.answerSubmit(page).click();
    await expect(ui.stageCurrent(page, 2)).toBeVisible();

    const progress = await fetchProgress(page);
    expect(progress.stages.q1?.status).toBe("solved");
    expect(progress.score).toBeGreaterThan(0);
    const breakdown = progress.stages.q1?.breakdown;
    if (breakdown) {
      expect(breakdown.wrong).toBeLessThan(0);
      // The paid reveal lowers the stage score.
      if (revealedCommand) expect(breakdown.commands).toBe(-5);
    }
  });

  await test.step("#/me shows a positive total score", async () => {
    await page.goto("/#/me");
    await expect(ui.totalScore(page)).toHaveText(/^[1-9][\d,]*$/);
  });

  await test.step("sign out", async () => {
    await ui.signOut(page).click();
    // Wait for the signed-out header before navigating, so the app's own redirect can't race us.
    await ui.headerSignIn(page).click();
    await expect(ui.signInSubmit(page)).toBeVisible();
  });

  await test.step("sign in as admin -> dashboard without a key prompt", async () => {
    await ui.username(page).fill(ADMIN_USERNAME);
    await ui.password(page).fill(ADMIN_KEY);
    await ui.signInSubmit(page).click();
    // Newer UI redirects admins to #/admin; older UI lands on #/. Either way, open the dashboard.
    await page.waitForURL((url) => !url.hash.startsWith("#/login"));
    if (!page.url().includes("#/admin")) await page.goto("/#/admin");
    await expect(ui.adminDashboard(page)).toBeVisible();
    await expect(ui.adminKeyPrompt(page)).toHaveCount(0);
  });

  expect(pageErrors, "uncaught page errors").toEqual([]);
});
