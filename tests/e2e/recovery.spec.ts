// Recovery codes (#174) in a real browser: sign up, save the one-time code (copy and .txt download), sign out,
// "Forgot password?" with the code, then sign in with the new password. Also the regenerate section on
// #/settings/security (#219).
// The new screens get an axe scan of their own (the shared scans can't reach one-time screens).
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TAGS } from "./a11y-support";
import { randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const NEW_PASSWORD = "e2e-new-password-456";
const CODE = /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/;

const ui = {
  username: (p: Page) => p.locator("#auth-username"),
  password: (p: Page) => p.locator("#auth-password"),
  submit: (p: Page) => p.locator("form.gate button[type=submit]"),
  codeHeading: (p: Page) => p.getByRole("heading", { level: 1, name: /save your recovery code/i }),
  code: (p: Page) => p.getByTestId("recovery-code"),
  copy: (p: Page) => p.getByRole("button", { name: /^copy code$/i }),
  download: (p: Page) => p.getByRole("button", { name: /download as \.txt/i }),
  savedContinue: (p: Page) => p.getByRole("button", { name: /i've saved it, continue/i }),
  savedSignIn: (p: Page) => p.getByRole("button", { name: /i've saved it, sign in/i }),
  forgot: (p: Page) => p.getByRole("button", { name: /^forgot password\?$/i }),
  recoverHeading: (p: Page) => p.getByRole("heading", { level: 1, name: /reset your password/i }),
  recoverUsername: (p: Page) => p.locator("#recover-username"),
  recoverCode: (p: Page) => p.locator("#recover-code"),
  recoverPassword: (p: Page) => p.locator("#recover-new"),
  account: (p: Page) => p.getByRole("button", { name: /account:/i }),
  signOut: (p: Page) => p.getByRole("dialog", { name: "Account" }).getByRole("button", { name: /^sign out$/i }),
};

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `[${v.impact ?? "?"}] ${v.id}: ${v.help} e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`);
}

test("sign up, save the recovery code, then reset a forgotten password with it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const username = randomUsername("e2erec");
  let firstCode = "";

  await test.step("sign up -> the code is shown once, with copy and download", async () => {
    await page.goto("/#/signup");
    await ui.username(page).fill(username);
    await ui.password(page).fill(PASSWORD);
    await ui.submit(page).click();
    await expect(ui.codeHeading(page)).toBeVisible();
    firstCode = ((await ui.code(page).textContent()) ?? "").trim();
    expect(firstCode).toMatch(CODE);
    await expect(page.getByText(/won't be shown again/i)).toBeVisible();

    await ui.copy(page).click();
    await expect(page.getByText("Recovery code copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstCode);

    const [download] = await Promise.all([page.waitForEvent("download"), ui.download(page).click()]);
    expect(download.suggestedFilename()).toBe("incidentlab-recovery-code.txt");
    const text = await readFile(await download.path(), "utf8");
    expect(text).toContain(firstCode);
    expect(text).toContain(username);

    expect(await seriousViolations(page)).toEqual([]);
    await ui.savedContinue(page).click();
    await expect(ui.codeHeading(page)).toHaveCount(0);
  });

  await test.step("sign out", async () => {
    await page.goto("/#/");
    await ui.account(page).click();
    await ui.signOut(page).click();
    await expect.poll(async () => ((await (await page.request.get("/api/session")).json()) as { account: unknown }).account).toBeNull();
  });

  await test.step("Forgot password? with a wrong code, then the right one", async () => {
    await page.goto("/#/login");
    await ui.username(page).fill(username);
    await ui.forgot(page).click();
    await expect(ui.recoverHeading(page)).toBeVisible();
    await expect(ui.recoverUsername(page)).toHaveValue(username);
    await expect(page.getByText(/instructor/i)).toHaveCount(0);
    expect(await seriousViolations(page)).toEqual([]);

    await ui.recoverCode(page).fill("AAAAA-BBBBB-CCCCC-DDDDD");
    await ui.recoverPassword(page).fill(NEW_PASSWORD);
    await ui.submit(page).click();
    await expect(page.locator(".error-summary")).toContainText(/wrong username or recovery code/i);

    // typed loosely: lower case, no dashes
    await ui.recoverCode(page).fill(firstCode.replaceAll("-", "").toLowerCase());
    await ui.submit(page).click();
    await expect(ui.codeHeading(page)).toBeVisible();
    const secondCode = ((await ui.code(page).textContent()) ?? "").trim();
    expect(secondCode).toMatch(CODE);
    expect(secondCode).not.toBe(firstCode);
    await ui.savedSignIn(page).click();
  });

  await test.step("sign in with the new password", async () => {
    await expect(ui.username(page)).toHaveValue(username);
    await expect(page.getByText(/password changed\. sign in with your new password/i)).toBeVisible();
    await ui.password(page).fill(NEW_PASSWORD);
    await ui.submit(page).click();
    await expect(ui.account(page)).toBeVisible();
    const me = (await (await page.request.get("/api/session")).json()) as { account: { username: string } | null };
    expect(me.account?.username).toBe(username);
  });
});

test("#/settings/security: a new recovery code needs the current password", async ({ page }) => {
  const username = randomUsername("e2eregen");
  const reg = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);

  await page.goto("/#/settings/security");
  const section = page.locator("section.recovery-section");
  await expect(section.getByRole("heading", { name: "Recovery code" })).toBeVisible();
  await section.getByRole("button", { name: /^make a new code$/i }).click();
  await expect(section.getByText(/enter your current password/i)).toBeVisible();
  await section.getByLabel("Current password", { exact: true }).fill("not-my-password");
  await section.getByRole("button", { name: /^make a new code$/i }).click();
  await expect(section.getByText(/current password is wrong|wrong/i).first()).toBeVisible();

  await section.getByLabel("Current password", { exact: true }).fill(PASSWORD);
  await section.getByRole("button", { name: /^make a new code$/i }).click();
  await expect(section.getByTestId("recovery-code")).toHaveText(CODE);
  await expect(section.getByText(/old code no longer works/i)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await section.getByRole("button", { name: /^i've saved it$/i }).click();
  await expect(section.getByTestId("recovery-code")).toHaveCount(0);
});
