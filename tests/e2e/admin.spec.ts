// Instructor dashboard tables on the shared data table (#62) and the #38 trust fixes: header sorting, the
// column picker, bulk approval through row selection, CSV of the current view, the row menu, undo after a
// delete, the one-time password guard, and the Recently deleted table at 390px in Hebrew.
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, approveAccount, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  username: (p: Page) => p.locator("#auth-username"),
  password: (p: Page) => p.locator("#auth-password"),
  signInSubmit: (p: Page) => p.locator("form button[type=submit]").first(),
  acctTable: (p: Page) => p.locator("table.acct-table"),
  acctHeader: (p: Page, name: RegExp) => p.locator("table.acct-table thead th").filter({ has: p.getByRole("button", { name }) }),
  acctRow: (p: Page, name: string) => p.locator("tr.acct-row", { hasText: name }),
  search: (p: Page) => p.locator("input.admin-search").first(),
  columnsButton: (p: Page) => p.getByRole("button", { name: /^columns/i }),
  pendingTable: (p: Page) => p.locator("table.pending-table"),
  selectBox: (p: Page, name: string) => p.getByRole("checkbox", { name: `Select ${name}` }),
  approveSelected: (p: Page) => p.locator("#pending-bulk-approve"),
  actionsFor: (p: Page, name: string) => p.locator(`button[aria-haspopup="menu"][aria-label="Actions for ${name}"]:visible`),
  menuItems: (p: Page) => p.getByRole("menu").getByRole("menuitem"),
  confirm: (p: Page) => p.getByRole("alertdialog"),
  toast: (p: Page) => p.locator(".toast-host .toast"),
  trashTable: (p: Page) => p.locator("table.trash-table"),
};

async function register(request: APIRequestContext, prefix: string): Promise<string> {
  const username = randomUsername(prefix);
  const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  // The admin account list is cached for a moment: wait until the new sign-up shows up in it.
  await expect
    .poll(async () => {
      const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
      return ((await res.json()) as { accounts: Array<{ username: string }> }).accounts.some((a) => a.username === username);
    })
    .toBe(true);
  return username;
}

async function accountStatus(request: APIRequestContext, username: string): Promise<string | null> {
  const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
  const { accounts } = (await res.json()) as { accounts: Array<{ username: string; status: string }> };
  return accounts.find((a) => a.username === username)?.status ?? null;
}

async function signInAdmin(page: Page, lang: "en" | "he" = "en"): Promise<void> {
  await page.goto("/");
  await page.evaluate((l) => {
    localStorage.setItem("il.lang", l);
    localStorage.removeItem("il.adminAcctCols");
  }, lang);
  await page.goto("/#/login");
  await page.reload(); // a hash-only navigation keeps the page: reload so the language applies
  await ui.username(page).fill(ADMIN_USERNAME);
  await ui.password(page).fill(ADMIN_KEY);
  await ui.signInSubmit(page).click();
  await page.waitForURL((url) => !url.hash.startsWith("#/login"));
}

test("accounts: a header sorts the table and the Sort select follows", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  const score = ui.acctHeader(page, /score/i);
  await score.getByRole("button").click();
  await expect(score).toHaveAttribute("aria-sort", "descending");
  const scores = await page.locator("table.acct-table tbody tr.acct-row td.col-score").allTextContents();
  const values = scores.map((s) => Number(s.replace(/[^\d]/g, "")));
  expect(values.length).toBeGreaterThan(1);
  expect([...values].sort((a, b) => b - a)).toEqual(values);
  await score.getByRole("button").click();
  await expect(score).toHaveAttribute("aria-sort", "ascending");
  // Choosing "Sort: name" in the select sorts by the name header.
  await page.getByRole("combobox", { name: /sort players/i }).selectOption("name");
  await expect(ui.acctHeader(page, /username/i)).toHaveAttribute("aria-sort", "ascending");
  await expect(score).toHaveAttribute("aria-sort", "none");
});

test("accounts: the column picker adds a column and remembers it", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await expect(ui.acctTable(page)).toBeVisible();
  await expect(page.locator("table.acct-table thead th", { hasText: /^hints$/i })).toHaveCount(0);
  await ui.columnsButton(page).click();
  await page.getByRole("checkbox", { name: /^hints$/i }).check();
  await expect(page.locator("table.acct-table thead th", { hasText: /^hints/i })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("table.acct-table thead th", { hasText: /^hints/i })).toHaveCount(1);
  await ui.columnsButton(page).click();
  await page.getByRole("button", { name: /default columns/i }).click();
  await expect(page.locator("table.acct-table thead th", { hasText: /^hints/i })).toHaveCount(0);
});

test("pending: tick two sign-ups and approve them together", async ({ page, request }) => {
  const a = await register(request, "e2ebulk");
  const b = await register(request, "e2ebulk");
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await expect(ui.pendingTable(page)).toBeVisible();
  await ui.selectBox(page, a).check();
  await ui.selectBox(page, b).check();
  await expect(ui.approveSelected(page)).toHaveText(/approve 2 selected/i);
  await ui.approveSelected(page).click();
  await expect(ui.selectBox(page, a)).toHaveCount(0);
  await expect(ui.selectBox(page, b)).toHaveCount(0);
  await expect.poll(() => accountStatus(request, a)).toBe("approved");
  await expect.poll(() => accountStatus(request, b)).toBe("approved");
});

test("live and audit: Export CSV downloads the rows on screen", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/#/admin?tab=live");
  await expect(page.locator("table.live-table tbody tr.acct-row").first()).toBeVisible();
  const rows = await page.locator("table.live-table tbody tr.acct-row").count();
  const [live] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^export csv$/i }).click()]);
  const liveCsv = await readFile(await live.path(), "utf8");
  const lines = liveCsv.replace(/^﻿/, "").trim().split(/\r\n/);
  expect(lines[0]).toBe("Name,Progress,Score,Current stage,On stage,Last seen");
  expect(lines).toHaveLength(rows + 1);
  expect(live.suggestedFilename()).toMatch(/^incidentlab-live-.+\.csv$/);

  await page.goto("/#/admin?tab=audit");
  await expect(page.locator("table.audit-table")).toBeVisible();
  const [audit] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^export csv$/i }).click()]);
  const auditCsv = await readFile(await audit.path(), "utf8");
  expect(auditCsv.replace(/^﻿/, "").split(/\r\n/)[0]).toBe("Time,Action,Target / detail,Via");
});

test("row menu: author role, password reset guard, delete with undo", async ({ page, request }) => {
  const username = await register(request, "e2erow");
  await approveAccount(request, username);
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await ui.search(page).fill(username);

  await test.step("the menu lists the actions, Delete last", async () => {
    await ui.actionsFor(page, username).click();
    const labels = await ui.menuItems(page).allTextContents();
    expect(labels).toContain("Make author");
    expect(labels.at(-1)).toMatch(/delete account/i);
    await page.keyboard.press("Escape");
  });

  await test.step("closing the one-time password without copying asks first", async () => {
    await ui.actionsFor(page, username).click();
    await ui.menuItems(page).filter({ hasText: /reset password/i }).click();
    await ui.confirm(page).locator('button[data-action="ok"]').click();
    const pwDialog = page.getByRole("dialog", { name: new RegExp(username) });
    await expect(pwDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ui.confirm(page)).toContainText(/close without copying/i);
    await ui.confirm(page).getByRole("button", { name: /back to the password/i }).click();
    await expect(pwDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await ui.confirm(page).getByRole("button", { name: /close anyway/i }).click();
    await expect(pwDialog).toHaveCount(0);
  });

  await test.step("delete, then Undo in the toast restores the account", async () => {
    await ui.actionsFor(page, username).click();
    await ui.menuItems(page).last().click();
    await ui.confirm(page).locator("input.ov-typed-input").fill(username);
    await ui.confirm(page).locator('button[data-action="ok"]').click();
    const toast = ui.toast(page).filter({ hasText: username });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: /^undo$/i }).click();
    await expect.poll(() => accountStatus(request, username)).toBe("approved");
    await expect(ui.acctRow(page, username)).toBeVisible();
  });
});

test.describe("HE 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Recently deleted stacks into readable cards", async ({ page, request }) => {
    const username = await register(request, "e2etrash390");
    const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
    const id = ((await res.json()) as { accounts: Array<{ accountId: string; username: string }> }).accounts.find((a) => a.username === username)?.accountId;
    const del = await request.delete(`/api/admin/accounts/${id}`, { headers: adminHeaders });
    expect(del.ok()).toBe(true);
    await signInAdmin(page, "he");
    await page.goto("/#/admin?tab=accounts");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const row = ui.trashTable(page).locator("tbody tr", { hasText: `account ${username}` });
    await expect(row).toBeVisible();
    // The item name gets the card's full width (it used to wrap one letter per line), and nothing scrolls sideways.
    const label = row.locator(".trash-label");
    const box = await label.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    const lineCount = await label.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "20")));
    expect(lineCount).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(row.getByRole("button", { name: new RegExp(username) })).toBeVisible();
  });
});
