// Guest play (#176): a visitor plays as a guest, solves stage 1, upgrades to an account from the guest banner, and
// the progress is still there signed in, in this browser and in a fresh one.
import { expect, test } from "@playwright/test";
import { answerFor, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

test("a guest plays, upgrades from the banner and keeps the progress", async ({ page, request, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const username = randomUsername("guest");
  await scheduleToday(request, CASE_ID);

  await test.step("a signed-out visitor sees Play as guest beside sign-in, and it opens the case", async () => {
    await page.goto(`/#/case/${CASE_ID}`);
    await expect(page.locator("form.gate")).toBeVisible();
    const choice = page.locator(".guest-choice");
    await expect(choice.getByRole("heading", { name: /just want to play/i })).toBeVisible();
    await choice.getByRole("button", { name: /play as guest/i }).click();
    await expect(page.getByRole("button", { name: /ready/i })).toBeVisible();
  });

  const banner = page.getByRole("region", { name: /guest mode/i });
  await test.step("the guest banner and the account menu say Guest", async () => {
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/playing as a guest/i);
    await page.locator(".account-btn").click();
    await expect(page.locator(".account-name")).toHaveText("Guest");
    await page.keyboard.press("Escape");
  });

  await test.step("the guest solves stage 1", async () => {
    await page.getByRole("button", { name: /ready/i }).click();
    const input = page.locator(".answer-form input");
    await input.fill(answerFor(CASE_ID, "q1"));
    await page.getByRole("button", { name: /check answer/i }).click();
    await expect(page.locator(".result-title")).toBeFocused();
  });

  await test.step("the banner's Create account upgrades the guest; the banner goes", async () => {
    await banner.getByRole("button", { name: /create account/i }).click();
    const dialog = page.getByRole("dialog", { name: /create your account/i });
    await expect(dialog.getByLabel(/username/i)).toBeFocused();
    await dialog.getByRole("button", { name: /create account/i }).click(); // empty: inline errors, nothing sent
    await expect(dialog.getByLabel(/username/i)).toHaveAttribute("aria-invalid", "true");
    await dialog.getByLabel(/username/i).fill(username);
    await dialog.getByLabel(/^password$/i).fill(PASSWORD);
    await dialog.getByRole("button", { name: /create account/i }).click();
    // the new account's one-time recovery code (#174) is shown before the dialog closes
    await expect(dialog.getByTestId("recovery-code")).toHaveText(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
    await dialog.getByRole("button", { name: "I've saved it", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(banner).toBeHidden();
    await expect(page.locator(".toast-host .toast").filter({ hasText: /account created/i })).toBeVisible();
  });

  await test.step("after a reload the account is signed in with stage 1 still solved", async () => {
    await page.reload();
    await page.locator(".account-btn").click();
    await expect(page.locator(".account-name")).toHaveText(username);
    await page.keyboard.press("Escape");
    await expect(banner).toBeHidden();
    const progress = await page.request.get(`/api/cases/${CASE_ID}/progress`);
    expect(progress.status()).toBe(200);
    const body = (await progress.json()) as { progress: { stages: Record<string, { status: string }> } };
    expect(body.progress.stages["q1"]?.status).toBe("solved");
  });

  await test.step("a fresh browser signs in with the new account and sees the same progress", async () => {
    const context = await browser.newContext();
    const fresh = await context.newPage();
    const login = await fresh.request.post("/api/auth/login", { data: { username, password: PASSWORD } });
    expect(login.status(), await login.text()).toBe(200);
    const progress = await fresh.request.get(`/api/cases/${CASE_ID}/progress`);
    const body = (await progress.json()) as { progress: { stages: Record<string, { status: string }> } };
    expect(body.progress.stages["q1"]?.status).toBe("solved");
    await context.close();
  });

  expect(pageErrors).toEqual([]);
});

test("a guest's sign-out warns that the progress will be lost", async ({ page }) => {
  await page.request.post("/api/guest", { data: {} });
  await page.goto("/#/");
  await page.locator(".account-btn").click();
  await page.getByRole("button", { name: /sign out/i }).click();
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toContainText(/can't sign back in/i);
  await prompt.getByRole("button", { name: /cancel/i }).click();
  await expect(page.getByRole("region", { name: /guest mode/i })).toBeVisible();
});

test("a guest's #/me offers the upgrade, not password or recovery-code forms (#207)", async ({ page }) => {
  await page.request.post("/api/guest", { data: {} });
  await page.goto("/#/me");
  const upgrade = page.locator(".stats-upgrade");
  await expect(upgrade.getByRole("heading", { name: "Keep your progress" })).toBeVisible();
  await expect(upgrade.getByRole("button", { name: /create account/i })).toBeVisible();
  await expect(page.locator(".pw-section")).toHaveCount(0);
  await expect(page.locator("#me-pw-current, #me-recovery-current")).toHaveCount(0);
  await expect(page.getByText("Change password")).toHaveCount(0);
});
