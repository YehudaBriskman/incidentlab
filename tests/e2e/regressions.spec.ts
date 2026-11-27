// Regression locks for recent fixes: trash restore in the admin UI, the Explorer's honest handling of a
// regex that blows the worker's hard timeout, and the `?code=` class-code sign-up link.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, approveAccount, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const INVITE_CODE = "E2E-CODE";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  username: (p: Page) => p.getByLabel("Username", { exact: true }),
  password: (p: Page) => p.getByLabel("Password", { exact: true }),
  classCode: (p: Page) => p.getByLabel(/class code/i),
  createAccount: (p: Page) => p.getByRole("button", { name: /^create account$/i }),
  signInSubmit: (p: Page) => p.locator("form").getByRole("button", { name: /^sign in$/i }),
  pendingTitle: (p: Page) => p.getByText(/waiting for approval/i),
  trashRow: (p: Page, label: string) => p.locator(".trash-table tr", { hasText: label }),
  restoreButton: (p: Page, label: string) => p.getByRole("button", { name: `Restore ${label}` }),
  explorerFile: (p: Page, path: string) => p.getByRole("complementary", { name: /files/i }).getByRole("button", { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`) }),
  stepType: (p: Page, n: number) => p.getByRole("combobox", { name: `Step ${n} filter type` }),
  stepText: (p: Page, n: number) => p.getByRole("textbox", { name: `Step ${n} filter text` }),
  count: (p: Page) => p.locator(".ex-count"),
};

type AccountRow = { accountId: string; username: string; status: string };

async function listAccounts(request: import("@playwright/test").APIRequestContext): Promise<AccountRow[]> {
  const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { accounts: AccountRow[] }).accounts;
}

test("recently deleted: a deleted account is restored from the admin Accounts tab", async ({ page, request }) => {
  const username = randomUsername("e2etrash");

  await test.step("register, approve and delete a player via the API", async () => {
    const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
    expect(reg.status(), await reg.text()).toBe(201);
    await approveAccount(request, username);
    const account = (await listAccounts(request)).find((a) => a.username === username);
    expect(account).toBeTruthy();
    const del = await request.delete(`/api/admin/accounts/${account?.accountId}`, { headers: adminHeaders });
    expect(del.ok(), await del.text()).toBe(true);
    expect((await listAccounts(request)).some((a) => a.username === username)).toBe(false);
  });

  await test.step("admin signs in and restores it from Recently deleted", async () => {
    await page.goto("/#/login");
    await ui.username(page).fill(ADMIN_USERNAME);
    await ui.password(page).fill(ADMIN_KEY);
    await ui.signInSubmit(page).click();
    await page.waitForURL((url) => !url.hash.startsWith("#/login"));
    await page.goto("/#/admin?tab=accounts");
    const label = `account ${username}`;
    await expect(page.getByRole("heading", { name: /recently deleted/i })).toBeVisible();
    await expect(ui.trashRow(page, label)).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept()); // native confirm(), if any
    await ui.restoreButton(page, label).click();
    await expect(ui.trashRow(page, label)).toHaveCount(0);
  });

  await test.step("the account is back and its trash entry is gone", async () => {
    await expect.poll(async () => (await listAccounts(request)).some((a) => a.username === username)).toBe(true);
    const trash = await request.get("/api/admin/trash", { headers: adminHeaders });
    expect(trash.status()).toBe(200);
    // Only this test's entry: other tests or earlier runs may leave their own trash entries behind.
    const labels = ((await trash.json()) as { entries: Array<{ label: string }> }).entries.map((e) => e.label);
    expect(labels).not.toContain(`account ${username}`);
  });
});

test("explorer: a regex that hits the hard timeout is marked not applied, never counted as applied", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/case/3am-outage/explorer");
  await ui.explorerFile(page, "nginx/access.log").click();
  // The ~40 MB log must finish loading before the filter controls enable.
  await expect(ui.stepType(page, 1)).toBeEnabled({ timeout: 60_000 });
  await expect(ui.count(page)).toHaveText(/ of [\d,]+ lines?/, { timeout: 60_000 });

  await ui.stepType(page, 1).selectOption("regex");
  // Nested quantifier + an anchor no access-log line satisfies: catastrophic backtracking on every line.
  await ui.stepText(page, 1).fill("(.+)+@@$");

  await expect(ui.stepText(page, 1)).toHaveAttribute("aria-invalid", "true", { timeout: 60_000 });
  await expect(ui.count(page)).toContainText(/not applied/i, { timeout: 60_000 });
  // Whatever the count shows, a full "N of M lines" must carry the not-applied warning with it.
  const text = (await ui.count(page).textContent()) ?? "";
  if (/ of [\d,]+ lines?/.test(text)) expect(text).toMatch(/step 1 not applied/i);
});

test("class-code link: ?code= prefills the field and sign-up is approved immediately", async ({ page, request }) => {
  const set = await request.put("/api/admin/settings", { headers: adminHeaders, data: { inviteCode: INVITE_CODE } });
  expect(set.status(), await set.text()).toBe(200);
  try {
    const username = randomUsername("e2ecode");
    await page.goto(`/#/signup?code=${INVITE_CODE}`);
    await expect(ui.classCode(page)).toHaveValue(INVITE_CODE);
    await ui.username(page).fill(username);
    await ui.password(page).fill(PASSWORD);
    await ui.createAccount(page).click();
    await page.getByRole("button", { name: /i've saved it, continue/i }).click();

    await page.waitForURL((url) => !url.hash.startsWith("#/signup"));
    await expect(ui.pendingTitle(page)).toHaveCount(0);
    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);
    expect(JSON.stringify(await me.json())).toContain('"status":"approved"');
  } finally {
    await request.put("/api/admin/settings", { headers: adminHeaders, data: { inviteCode: null } });
  }
});
