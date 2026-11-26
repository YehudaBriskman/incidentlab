// Onboarding locks (#34, #52): field-level errors and focus on sign-in / sign-up, the language toggle keeping
// typed input, a refresh after sign-up landing on the pending screen, and pending -> rejected.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminHeaders, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  username: (p: Page) => p.locator("#auth-username"),
  password: (p: Page) => p.locator("#auth-password"),
  classCode: (p: Page) => p.locator("#auth-invite"),
  submit: (p: Page) => p.locator("form.gate button[type=submit]"),
  summary: (p: Page) => p.locator(".error-summary"),
  fieldError: (p: Page, id: string) => p.locator(`#${id}-error`),
  toSignUp: (p: Page) => p.getByRole("button", { name: /create an account/i }),
  langButton: (p: Page, label: "EN" | "עב") => p.getByRole("group", { name: /^(language|שפה)$/i }).getByRole("button", { name: label }),
  pendingHeading: (p: Page) => p.getByRole("heading", { level: 1, name: /waiting for approval/i }),
  rejectedHeading: (p: Page) => p.getByRole("heading", { level: 1, name: /account not approved/i }),
};

async function rejectAccount(request: APIRequestContext, username: string): Promise<void> {
  const list = await request.get("/api/admin/accounts", { headers: adminHeaders });
  expect(list.status()).toBe(200);
  const { accounts } = (await list.json()) as { accounts: { accountId: string; username: string }[] };
  const account = accounts.find((a) => a.username === username.toLowerCase());
  expect(account, `account ${username} should exist`).toBeTruthy();
  const res = await request.post(`/api/admin/accounts/${account?.accountId}/reject`, { headers: adminHeaders, data: {} });
  expect(res.status(), await res.text()).toBe(200);
}

test("sign-in: empty submit marks both fields and focuses the summary; one problem focuses its field", async ({ page }) => {
  await page.goto("/#/login");
  await ui.submit(page).click();
  await expect(ui.summary(page)).toBeFocused();
  for (const [field, id] of [[ui.username(page), "auth-username"], [ui.password(page), "auth-password"]] as const) {
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", new RegExp(`\\b${id}-error\\b`));
    await expect(ui.fieldError(page, id)).toBeVisible();
  }
  await expect(page).toHaveTitle(/^Error: /);

  await ui.username(page).fill("someone");
  await expect(ui.username(page)).not.toHaveAttribute("aria-invalid", "true");
  await ui.submit(page).click();
  await expect(ui.password(page)).toBeFocused();
  await expect(ui.fieldError(page, "auth-password")).toHaveText(/enter your password/i);
});

test("sign-in: wrong credentials keep the username, clear the password and keep focus off <body>", async ({ page }) => {
  await page.goto("/#/login");
  await ui.username(page).fill(randomUsername("nobody"));
  await ui.password(page).fill("wrong-password-1");
  await ui.submit(page).click();
  await expect(ui.summary(page)).toBeFocused();
  await expect(ui.summary(page)).toContainText(/wrong username or password/i);
  await expect(ui.password(page)).toHaveValue("");
  await expect(ui.username(page)).not.toHaveValue("");
  await expect(ui.username(page)).toHaveAttribute("aria-invalid", "true");
  await expect(ui.password(page)).toHaveAttribute("aria-invalid", "true");
});

test("sign-up: every invalid field shows its error at once", async ({ page }) => {
  await page.goto("/#/signup");
  await ui.username(page).fill("a b");
  await ui.password(page).fill("short");
  await ui.submit(page).click();
  await expect(ui.summary(page)).toBeFocused();
  await expect(ui.summary(page).getByRole("link")).toHaveCount(2);
  await expect(ui.fieldError(page, "auth-username")).toBeVisible();
  await expect(ui.fieldError(page, "auth-password")).toBeVisible();
  await ui.summary(page).getByRole("link").nth(1).click();
  await expect(ui.password(page)).toBeFocused();
});

test("language toggle re-labels the form and keeps what was typed, including the sign-up mode", async ({ page }) => {
  await page.goto("/#/signup?code=CLASS-42");
  await expect(ui.classCode(page)).toHaveValue("CLASS-42");
  await ui.username(page).fill("typed_user");
  await ui.password(page).fill("typed-password");
  await ui.langButton(page, "עב").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(ui.submit(page)).toHaveText("פתיחת חשבון");
  await expect(ui.username(page)).toHaveValue("typed_user");
  await expect(ui.password(page)).toHaveValue("typed-password");
  await expect(ui.classCode(page)).toHaveValue("CLASS-42");

  // #/login switched to sign-up in place: the switch keeps the mode, not just the values.
  await ui.langButton(page, "EN").click();
  await page.goto("/#/login");
  await ui.toSignUp(page).click();
  await ui.username(page).fill("second_user");
  await ui.langButton(page, "עב").click();
  await expect(ui.submit(page)).toHaveText("פתיחת חשבון");
  await expect(ui.username(page)).toHaveValue("second_user");
});

test("refresh after sign-up shows the pending screen; a rejection while waiting shows the rejected screen", async ({ page, request }) => {
  const username = randomUsername("e2ewait");
  await page.goto("/#/signup");
  await ui.username(page).fill(username);
  await ui.password(page).fill(PASSWORD);
  await ui.submit(page).click();
  await expect(ui.pendingHeading(page)).toBeVisible();

  await page.reload();
  await expect(ui.pendingHeading(page)).toBeVisible();
  await expect(page).toHaveTitle(/waiting for approval/i);
  // The polite status region stays silent while polling (it speaks only on a state change).
  await expect(page.locator(".pending-status")).toHaveText("");

  await rejectAccount(request, username);
  await page.getByRole("button", { name: /check now/i }).click();
  await expect(ui.rejectedHeading(page)).toBeVisible();
  await expect(ui.rejectedHeading(page)).toBeFocused();
  await expect(page.getByRole("button", { name: /create a new account/i })).toBeVisible();
});
