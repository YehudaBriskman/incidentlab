// The platform owner console (#185): the owner searches a user, bans and unbans them, raises their class limit,
// lists the classes and changes one's member limit, sees the review badge on the Reviews link, and sees actor
// ids in the audit log. The users list is fetched on demand, so nothing here waits for a poll.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { build, fixture } from "../../site/server/test/package-fixture.ts";
import { uploadCasePackage } from "../../site/shared/upload-client.ts";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, randomUsername, searchUsers } from "./support";

const PASSWORD = "e2e-password-123";

const ui = {
  row: (p: Page, name: string) => p.locator("tr.acct-row", { hasText: name }),
  actionsFor: (p: Page, name: string) => p.locator(`button[aria-haspopup="menu"][aria-label="Actions for ${name}"]:visible`),
  classActions: (p: Page, name: string) => p.locator(`button[aria-haspopup="menu"][aria-label="Actions for class ${name}"]:visible`),
  menuItem: (p: Page, name: RegExp) => p.getByRole("menu").getByRole("menuitem", { name }),
  confirm: (p: Page) => p.getByRole("alertdialog"),
  nav: (p: Page) => p.getByRole("navigation", { name: "Main" }).getByRole("list", { name: "Dashboard sections" }),
  toast: (p: Page, text: string | RegExp) => p.locator(".toast-host .toast").filter({ hasText: text }),
};

async function signUp(request: APIRequestContext, prefix: string): Promise<{ id: string; username: string }> {
  const username = randomUsername(prefix);
  const res = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const { account } = (await res.json()) as { account: { id: string } };
  return { id: account.id, username };
}

type UserRow = { username: string; status: string; classLimit: number | null };
async function userRow(request: APIRequestContext, username: string): Promise<UserRow | undefined> {
  const res = await request.get(`/api/admin/users?q=${encodeURIComponent(username)}`, { headers: adminHeaders });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { accounts: UserRow[] }).accounts.find((a) => a.username === username);
}

/** An author's private case, uploaded through the API and submitted for the owner's review. */
async function submittedCase(request: APIRequestContext): Promise<string> {
  const author = await signUp(request, "e2econauth");
  const granted = await request.put(`/api/admin/accounts/${author.id}/role`, { headers: adminHeaders, data: { role: "author" } });
  expect(granted.status(), await granted.text()).toBe(200);
  const caseId = `e2e-console-${Math.random().toString(36).slice(2, 8)}`;
  await uploadCasePackage(await build(fixture(caseId)), {
    publish: true,
    acceptAnswerChanges: false,
    send: (path, init) =>
      request.fetch(path, { method: init.method, headers: { ...init.headers }, ...(init.body === undefined ? {} : { data: typeof init.body === "string" ? init.body : Buffer.from(init.body) }) }),
  });
  const submitted = await request.post(`/api/author/cases/${caseId}/submit-review`, { data: {} });
  expect(submitted.status(), await submitted.text()).toBe(200);
  return caseId;
}

test("owner console: search, ban and unban, class limit, classes and member limit, review badge, audit actors", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const player = await playwright.request.newContext({ baseURL });
  const author = await playwright.request.newContext({ baseURL });
  const target = await signUp(player, "e2econsole");
  const className = `Console class ${Math.random().toString(36).slice(2, 6)}`;
  const created = await player.post("/api/classes", { data: { name: className } });
  expect(created.status(), await created.text()).toBe(201);
  await submittedCase(author);

  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.ok()).toBe(true);
  await page.goto("/#/admin?tab=accounts");

  await test.step("search finds the user (server-side)", async () => {
    await searchUsers(page, target.username);
    await expect(ui.row(page, target.username)).toBeVisible();
    await expect(page.locator("tr.acct-row")).toHaveCount(1);
  });

  await test.step("Ban asks first, then the row says Banned; Unban brings it back", async () => {
    await ui.actionsFor(page, target.username).click();
    await ui.menuItem(page, /^ban$/i).click();
    await expect(ui.confirm(page)).toContainText(target.username);
    await ui.confirm(page).getByRole("button", { name: /^ban$/i }).click();
    await expect(ui.row(page, target.username)).toContainText("Banned");
    await expect.poll(async () => (await userRow(page.request, target.username))?.status).toBe("rejected");

    await ui.actionsFor(page, target.username).click();
    await ui.menuItem(page, /^unban$/i).click();
    await expect(ui.row(page, target.username)).toContainText("Approved");
    await expect.poll(async () => (await userRow(page.request, target.username))?.status).toBe("approved");
  });

  await test.step("the class limit goes up from the row menu", async () => {
    await ui.actionsFor(page, target.username).click();
    await ui.menuItem(page, /set class limit/i).click();
    const dialog = page.getByRole("dialog", { name: new RegExp(`class limit for ${target.username}`, "i") });
    await dialog.getByLabel(/active classes this account may own/i).fill("5");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(ui.toast(page, /up to 5 active classes/)).toBeVisible();
    expect((await userRow(page.request, target.username))?.classLimit).toBe(5);
  });

  await test.step("Classes lists the class with its owner; the member limit changes", async () => {
    await ui.nav(page).getByRole("link", { name: /^Classes/ }).click();
    const panel = page.locator("#admin-panel-classes");
    await panel.getByRole("searchbox").fill(className);
    const row = panel.locator("tr.owner-class-row", { hasText: className });
    await expect(row).toContainText(target.username);
    await expect(row).toContainText("1 / 60");
    await ui.classActions(page, className).click();
    await ui.menuItem(page, /set member limit/i).click();
    const dialog = page.getByRole("dialog", { name: new RegExp(`member limit for ${className}`, "i") });
    await dialog.getByLabel(/members, counting pending/i).fill("80");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(row).toContainText("1 / 80");
  });

  await test.step("the Reviews link carries the number waiting", async () => {
    const reviews = ui.nav(page).getByRole("link", { name: /^Reviews/ });
    await expect(reviews).toHaveAttribute("href", "#/admin/reviews");
    const badge = reviews.locator(".nav-sub-badge");
    await expect(badge).toBeVisible();
    expect(Number(await badge.textContent())).toBeGreaterThanOrEqual(1);
  });

  await test.step("the audit log names the actors", async () => {
    await ui.nav(page).getByRole("link", { name: /^Audit log$/ }).click();
    const table = page.locator("table.audit-table");
    // The player's own class create: their name and account id. The owner's ban: "Site owner".
    const create = table.locator("tbody tr", { hasText: className }).filter({ hasText: target.id }).first();
    await expect(create).toContainText(target.username);
    await expect(table.locator("tbody tr", { hasText: "Site owner" }).first()).toBeVisible();
  });

  await player.dispose();
  await author.dispose();
});
