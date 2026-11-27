// The author role (#67): the instructor grants and revokes it from the Accounts tab, and the player's own
// session sees it without signing in again.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, approveAccount, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";

const ui = {
  username: (p: Page) => p.getByLabel("Username", { exact: true }),
  password: (p: Page) => p.getByLabel("Password", { exact: true }),
  signInSubmit: (p: Page) => p.locator("form").getByRole("button", { name: /^sign in$/i }),
  actions: (p: Page, name: string) => p.getByRole("button", { name: `Actions for ${name}` }),
  menuItem: (p: Page, name: RegExp) => p.getByRole("menuitem", { name }),
  row: (p: Page, name: string) => p.locator("tr.acct-row", { hasText: name }),
};

const roleOf = async (request: import("@playwright/test").APIRequestContext): Promise<unknown> =>
  ((await (await request.get("/api/session")).json()) as { account: { role: string } | null }).account?.role;

test("admin makes a player an author and back from the Accounts tab", async ({ page, playwright, baseURL }) => {
  const username = randomUsername("e2eauthor");
  const player = await playwright.request.newContext({ baseURL });

  await test.step("a player signs up and is approved", async () => {
    const reg = await player.post("/api/auth/register", { data: { username, password: PASSWORD } });
    expect(reg.status(), await reg.text()).toBe(201);
    await approveAccount(player, username);
    expect(await roleOf(player)).toBe("player");
  });

  await test.step("admin grants the author role from the row menu", async () => {
    await page.goto("/#/login");
    await ui.username(page).fill(ADMIN_USERNAME);
    await ui.password(page).fill(ADMIN_KEY);
    await ui.signInSubmit(page).click();
    await page.waitForURL((url) => !url.hash.startsWith("#/login"));
    await page.goto("/#/admin?tab=accounts");
    // The users list is paged on the server (#185): search for the player.
    await page.locator("input.admin-search").first().fill(username);
    await ui.actions(page, username).click();
    await ui.menuItem(page, /^make author$/i).click();
    await expect(ui.row(page, username).getByText("Author", { exact: true })).toBeVisible();
    await expect.poll(() => roleOf(player)).toBe("author");
  });

  await test.step("admin removes it again", async () => {
    await ui.actions(page, username).click();
    await ui.menuItem(page, /^remove author role$/i).click();
    await expect(ui.row(page, username).getByText("Author", { exact: true })).toHaveCount(0);
    await expect.poll(() => roleOf(player)).toBe("player");
  });

  await player.dispose();
});
