// Teacher-vouched password reset (#254) with three browsers: the student asks from "Forgot password?", the teacher
// vouches on the class Members tab (and never sees a password), the owner approves in the console and copies the
// one-time temporary password, and the student signs in with it, must set a new password, then saves a new
// recovery code.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const NEW_PASSWORD = "e2e-reset-password-789";
const CODE = /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/;

async function person(browser: Browser, prefix: string): Promise<{ context: BrowserContext; page: Page; username: string }> {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  const username = randomUsername(prefix);
  const res = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return { context, page, username };
}

test("reset request: the student asks, the teacher vouches, the owner approves, the student sets a new password", async ({ browser }) => {
  test.setTimeout(120_000);
  const teacher = await person(browser, "e2ertch");
  const student = await person(browser, "e2erstu");
  const ownerContext = await browser.newContext();
  await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const owner = await ownerContext.newPage();

  // The teacher's class, joined by the student (API: the class UI has its own spec).
  const created = await teacher.page.request.post("/api/classes", { data: { name: "Reset class" } });
  expect(created.status(), await created.text()).toBe(201);
  const cls = ((await created.json()) as { class: { id: string; admin: { joinCode: string } } }).class;
  const joined = await student.page.request.post("/api/classes/join", { data: { code: cls.admin.joinCode } });
  expect(joined.status(), await joined.text()).toBe(200);
  const me = (await (await student.page.request.get("/api/me")).json()) as { account: { id: string } };
  // The student "forgets" everything: signed out, no recovery code.
  await student.page.request.post("/api/auth/logout", { data: {} });

  await test.step("student: Forgot password? -> No recovery code? Ask your teacher", async () => {
    await student.page.goto("/#/login");
    await student.page.locator("#auth-username").fill(student.username);
    await student.page.getByRole("button", { name: /^forgot password\?$/i }).click();
    await student.page.getByRole("button", { name: "No recovery code? Ask your teacher" }).click();
    await expect(student.page.getByRole("heading", { level: 1, name: "Ask your teacher for a reset" })).toBeVisible();
    await expect(student.page.locator("#ask-username")).toHaveValue(student.username);
    await student.page.getByRole("button", { name: "Send request" }).click();
    const sent = student.page.getByTestId("reset-request-sent");
    await expect(sent.getByRole("heading", { name: "Request sent" })).toBeFocused();
    await expect(sent.getByText(/Tell your teacher/)).toBeVisible();
    await expect(sent.getByText(/temporary password/)).toBeVisible();
  });

  await test.step("teacher: vouches on the Members tab, and sees no password", async () => {
    await teacher.page.goto(`/#/class/${cls.id}/manage`);
    const panel = teacher.page.locator(".class-reset-panel");
    await expect(panel.getByRole("heading", { name: /Password reset requests/ })).toBeVisible();
    let row = panel.locator(".class-request", { hasText: student.username });
    // A student who joined today can't be vouched for yet (#254: a week in the class first).
    await expect(row.getByTestId("vouch-later")).toContainText("Can vouch from");
    await expect(row.getByRole("button", { name: "Vouch" })).toHaveCount(0);
    // The local server's test hook moves the join date back a week.
    const back = await teacher.page.request.post("/__local/backdate-member", { data: { classId: cls.id, accountId: me.account.id, days: 8 } });
    expect(back.status()).toBe(204);
    await teacher.page.reload();
    row = teacher.page.locator(".class-reset-panel .class-request", { hasText: student.username });
    await row.getByRole("button", { name: "Vouch" }).click();
    const confirm = teacher.page.getByRole("alertdialog");
    await expect(confirm).toContainText("Only vouch for a student you know in person");
    await confirm.getByRole("button", { name: `I know ${student.username}, vouch` }).click();
    await expect(row.getByText("Vouched")).toBeVisible();
    await expect(teacher.page.getByTestId("temp-password")).toHaveCount(0);
    await expect(teacher.page.locator(".class-manage")).not.toContainText(/temporary password:/i);
  });

  let temporaryPassword = "";
  await test.step("owner: approves in the console and copies the one-time password", async () => {
    const login = await owner.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
    expect(login.status()).toBe(200);
    await owner.goto("/#/admin?tab=accounts");
    const panel = owner.locator(".reset-requests-panel");
    const row = panel.locator(".reset-request", { hasText: student.username });
    await expect(row).toContainText(`Vouched by ${teacher.username} in Reset class`);
    await row.getByRole("button", { name: "Approve" }).click();
    await owner.getByRole("alertdialog").getByRole("button", { name: `Reset ${student.username}'s password` }).click();
    const dialog = owner.getByRole("dialog", { name: `Temporary password for ${student.username}` });
    temporaryPassword = ((await dialog.getByTestId("temp-password").textContent()) ?? "").trim();
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(10);
    await dialog.getByRole("button", { name: "Copy password" }).click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(temporaryPassword);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.locator(".reset-request", { hasText: student.username })).toHaveCount(0);
  });

  await test.step("student: signs in with it, must set a new password, then saves a new recovery code", async () => {
    // The request screen's own way back (the page is still on #/login).
    await student.page.getByTestId("reset-request-sent").getByRole("button", { name: "Back to sign in" }).click();
    await student.page.locator("#auth-username").fill(student.username);
    await student.page.locator("#auth-password").fill(temporaryPassword);
    await student.page.locator("form.gate button[type=submit]").click();
    await expect(student.page.getByRole("heading", { level: 1, name: /new password/i })).toBeVisible();
    // Until the change, the session can do nothing else.
    const blocked = await student.page.request.get("/api/me/stats");
    expect(blocked.status()).toBe(403);
    await student.page.locator("#forced-pw-new").fill(NEW_PASSWORD);
    await student.page.locator("form.pw-form button[type=submit]").click();
    await expect(student.page.getByRole("heading", { level: 1, name: /save your recovery code/i })).toBeVisible();
    await expect(student.page.getByText(/old recovery code no longer works/i)).toBeVisible();
    expect(((await student.page.getByTestId("recovery-code").textContent()) ?? "").trim()).toMatch(CODE);
    await student.page.getByRole("button", { name: /^copy code$/i }).click();
    await student.page.getByRole("button", { name: /i've saved it, continue/i }).click();
    await expect(student.page.getByRole("heading", { level: 1, name: /save your recovery code/i })).toHaveCount(0);
    expect((await student.page.request.get("/api/me/stats")).status()).toBe(200);
    // the temporary password is spent
    const again = await ownerContext.request.post("/api/auth/login", { data: { username: student.username, password: temporaryPassword } });
    expect(again.status()).toBe(401);
  });

  await Promise.all([teacher.context.close(), student.context.close(), ownerContext.close()]);
});
