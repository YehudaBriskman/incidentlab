// Owner and author tools (#234, #235, #236, #285): the console's Overview (the default section) with its chart, table
// view and budget state, the "Needs you" strip; a forced rename (a taken name keeps the dialog open), hiding a player
// from the boards, a ban with a reason the player reads at sign-in; "Request author access" and the owner's grant;
// and assigning a private case to the author's class (its case list included) from the author page in one step.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { build, fixture } from "../../site/server/test/package-fixture.ts";
import { uploadCasePackage } from "../../site/shared/upload-client.ts";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, randomUsername, searchUsers } from "./support";

const PASSWORD = "e2e-password-123";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const ui = {
  actionsFor: (p: Page, name: string) => p.locator(`button[aria-haspopup="menu"][aria-label="Actions for ${name}"]:visible`),
  menuItem: (p: Page, name: string | RegExp) => p.getByRole("menu").getByRole("menuitem", { name }),
  toast: (p: Page, text: string | RegExp) => p.locator(".toast-host .toast").filter({ hasText: text }),
};

async function signUp(request: APIRequestContext, prefix: string): Promise<{ id: string; username: string }> {
  const username = randomUsername(prefix);
  const res = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const { account } = (await res.json()) as { account: { id: string } };
  return { id: account.id, username };
}

async function asOwner(page: Page): Promise<void> {
  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.ok()).toBe(true);
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ") ?? ""}`);
}

test("overview: the console opens on it; tiles, chart with a table view, the budget state and Needs you", async ({ page, playwright, baseURL }) => {
  const other = await playwright.request.newContext({ baseURL });
  await signUp(other, "e2eovw");
  await asOwner(page);
  await page.goto("/#/admin");
  const panel = page.locator("#admin-panel-overview");
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/tab=overview/);
  await expect(page.getByRole("link", { name: "Overview" }).first()).toHaveAttribute("aria-current", "page");
  await expect(panel.getByText("New accounts, last 7 days")).toBeVisible();
  await expect(panel.getByText("Active players, last 7 days")).toBeVisible();
  await expect(panel.getByRole("heading", { name: /Sign-ups per day, last 30 days: \d+ in all/ })).toBeVisible();
  // The local server has no Netlify token: the budget says so, with the CLI that reads it.
  await expect(panel.locator(".ov-budget")).toContainText("Not configured");
  await expect(panel.locator(".ov-budget code")).toHaveText("node --experimental-strip-types scripts/data.ts usage");
  // The chart has a table view.
  await panel.getByText("Show as a table").click();
  await expect(panel.locator(".ov-table table tbody tr")).toHaveCount(30);
  // "Needs you" sits under the console header on every section.
  await expect(page.getByRole("navigation", { name: "Needs you" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  // Hebrew: the same section reads right to left.
  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.reload();
  await expect(page.locator("#admin-panel-overview").getByText("חשבונות חדשים, 7 הימים האחרונים")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.evaluate(() => localStorage.setItem("il.lang", "en"));
  await other.dispose();
});

test("moderation: rename (taken names stay in the dialog), hide from boards, ban with a reason shown at sign-in", async ({ page, browser, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const player = await playwright.request.newContext({ baseURL });
  const target = await signUp(player, "e2erude");
  const taken = await signUp(player, "e2etaken");
  const renamed = randomUsername("e2enice");
  await asOwner(page);
  await page.goto("/#/admin?tab=accounts");

  await test.step("rename: a taken name is refused on the field, a free one goes through", async () => {
    await searchUsers(page, target.username);
    await ui.actionsFor(page, target.username).click();
    await ui.menuItem(page, "Rename…").click();
    const dialog = page.getByRole("dialog", { name: `Rename ${target.username}` });
    const field = dialog.getByLabel("New username");
    await field.fill(taken.username);
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog.locator(".field-error")).toHaveText("That username is taken. Pick another.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect(await seriousViolations(page)).toEqual([]);
    await field.fill(renamed);
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog).toBeHidden();
    await expect(ui.toast(page, `${target.username} is now ${renamed}.`)).toBeVisible();
    const audit = (await (await page.request.get("/api/admin/audit", { headers: adminHeaders })).json()) as { entries: Array<{ action: string; detail: string | null }> };
    expect(audit.entries.find((e) => e.action === "account.rename")?.detail).toBe(`${target.username} -> ${renamed}`);
  });

  await test.step("hide from boards: confirmed, then the pill shows", async () => {
    await searchUsers(page, renamed);
    await ui.actionsFor(page, renamed).click();
    await ui.menuItem(page, "Hide from boards…").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Hide from boards" }).click();
    await expect(ui.toast(page, `${renamed} is hidden from the boards.`)).toBeVisible();
    await page.getByRole("button", { name: "Refresh" }).first().click();
    await expect(page.locator("tr.acct-row", { hasText: renamed })).toContainText("Hidden from boards");
  });

  const reason = "Offensive names on the class board";
  await test.step("ban with a reason", async () => {
    await ui.actionsFor(page, renamed).click();
    await ui.menuItem(page, "Ban").click();
    const dialog = page.getByRole("alertdialog", { name: `Ban ${renamed}?` });
    await dialog.getByLabel("Reason (optional)").fill(reason);
    expect(await seriousViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Ban" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the player reads the reason when signing in", async () => {
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await visitor.goto("/#/login");
    await visitor.locator("#auth-username").fill(renamed);
    await visitor.locator("#auth-password").fill(PASSWORD);
    await visitor.locator("form.gate button[type=submit]").click();
    await expect(visitor.getByRole("heading", { name: "Account not approved" })).toBeVisible();
    await expect(visitor.locator("[data-ban-reason]")).toHaveText(reason);
    expect(await seriousViolations(visitor)).toEqual([]);
    await context.close();
  });
  await player.dispose();
});

test("author access: a player asks on #/author, the owner grants it from the review queue", async ({ page, browser }) => {
  const context = await browser.newContext();
  const playerPage = await context.newPage();
  const player = await signUp(playerPage.request, "e2ewriter");
  await playerPage.goto("/#/author");
  await expect(playerPage.getByRole("heading", { name: "Want to write a case?" })).toBeVisible();
  await expect(playerPage.getByText("How to make a package")).toBeVisible();
  await playerPage.getByLabel("What would you like to write about? (optional)").fill("A DNS outage case");
  await playerPage.getByTestId("ask-author").click();
  await expect(playerPage.locator(".author-ask-status")).toContainText("is waiting for the site owner");
  expect(await seriousViolations(playerPage)).toEqual([]);

  await asOwner(page);
  await page.goto("/#/admin/reviews");
  // One console header on every console page (#285).
  await expect(page.getByRole("heading", { level: 1, name: "Platform console" })).toBeVisible();
  const section = page.locator("#author-requests");
  await expect(section.locator("tr", { hasText: player.username })).toContainText("A DNS outage case");
  await section.getByRole("button", { name: `Actions for ${player.username}` }).click();
  await ui.menuItem(page, "Grant author access").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Grant author access" }).click();
  await expect(ui.toast(page, `${player.username} is an author now.`)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  // The player's page is now the authoring page.
  await playerPage.reload();
  await expect(playerPage.getByLabel("Case package (.case.zip)")).toBeVisible();
  await context.close();
});

test("author page: assigning a private case to my class also puts it on the class's case list", async ({ page }) => {
  const author = await signUp(page.request, "e2eassign");
  const granted = await page.request.put(`/api/admin/accounts/${author.id}/role`, { headers: adminHeaders, data: { role: "author" } });
  expect(granted.status(), await granted.text()).toBe(200);
  const className = `Assign class ${Math.random().toString(36).slice(2, 6)}`;
  const created = await page.request.post("/api/classes", { data: { name: className } });
  expect(created.status(), await created.text()).toBe(201);
  const { class: cls } = (await created.json()) as { class: { id: string } };
  const caseId = `e2e-assign-${Math.random().toString(36).slice(2, 8)}`;
  await uploadCasePackage(await build(fixture(caseId)), {
    publish: true,
    acceptAnswerChanges: false,
    send: (path, init) =>
      page.request.fetch(path, { method: init.method, headers: { ...init.headers }, ...(init.body === undefined ? {} : { data: typeof init.body === "string" ? init.body : Buffer.from(init.body) }) }),
  });

  await page.goto("/#/author");
  await page.getByRole("button", { name: `Actions for ${caseId}` }).click();
  await page.getByRole("menuitem", { name: "Classes…" }).click();
  const dialog = page.getByRole("dialog", { name: `Classes that may play ${caseId}` });
  await dialog.getByLabel(className).check();
  await expect(dialog.getByLabel("Also add it to each class's case list (its class page and board)")).toBeChecked();
  expect(await seriousViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(ui.toast(page, "Added to the case list of 1 class.")).toBeVisible();
  const detail = (await (await page.request.get(`/api/classes/${cls.id}`)).json()) as { class: { caseIds: string[] } };
  expect(detail.class.caseIds).toContain(caseId);
});
