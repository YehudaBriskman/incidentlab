// Instructor dashboard tables on the shared data table (#62) and the #38 trust fixes: header sorting, the
// column picker, bulk approval through row selection, CSV of the current view, the row menu, undo after a
// delete, the one-time password guard, and the Recently deleted table at 390px in Hebrew.
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, adminHeaders, answerFor, approveAccount, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
/** Every test makes its own data (CI starts an empty server): players on this case, scored by solving stages. */
const CASE_ID = "3am-outage";

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

/**
 * An approved player who opened CASE_ID and solved `solve` stages (each solve scores), in its own cookie session.
 * Returns the username.
 */
async function playingPlayer(
  pw: PlaywrightWorkerArgs["playwright"],
  baseURL: string | undefined,
  request: APIRequestContext,
  prefix: string,
  solve: number,
): Promise<string> {
  const session = await pw.request.newContext({ baseURL });
  const username = randomUsername(prefix);
  const reg = await session.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(request, username);
  // The public board lists only players who opted in (#175).
  const board = await session.put("/api/me/board", { data: { show: true } });
  expect(board.status(), await board.text()).toBe(200);
  const c = (path: string): string => `/api/cases/${CASE_ID}${path}`;
  expect((await session.get(c("/progress"))).status()).toBe(200);
  expect((await session.post(c("/setup-done"), { data: {} })).status()).toBe(200);
  for (const q of ["q1", "q2", "q3", "q4", "q5", "q6"].slice(0, solve)) {
    const res = await session.post(c("/answer"), { data: { questionId: q, answer: answerFor(CASE_ID, q) } });
    expect(res.status(), await res.text()).toBe(200);
  }
  await session.dispose();
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

test("accounts: a header sorts the table and the Sort select follows", async ({ page, playwright, baseURL, request }) => {
  await playingPlayer(playwright, baseURL, request, "e2esort", 0);
  await playingPlayer(playwright, baseURL, request, "e2esort", 1);
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

test("accounts: the column picker adds a column and remembers it", async ({ page, request }) => {
  await approveAccount(request, await register(request, "e2ecols"));
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await expect(ui.acctTable(page)).toBeVisible();
  await expect(page.locator("table.acct-table thead th", { hasText: /^hints$/i })).toHaveCount(0);
  // closed until asked for (a display rule once kept the popover open from page load)
  await expect(page.getByRole("checkbox", { name: /^hints$/i })).toBeHidden();
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

test("live and audit: Export CSV downloads the rows on screen", async ({ page, playwright, baseURL, request }) => {
  // A player on the case for Live; the approval is an audit entry.
  await playingPlayer(playwright, baseURL, request, "e2ecsv", 1);
  await signInAdmin(page);
  await page.goto(`/#/admin?tab=live&case=${CASE_ID}`);
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

test("row menu: Revoke asks first, and Cancel changes nothing (#128)", async ({ page, request }) => {
  const username = await register(request, "e2erevoke");
  await approveAccount(request, username);
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await ui.search(page).fill(username);
  // The account menu in the top bar carries Sign out; the page header no longer repeats it.
  await expect(page.locator(".admin-head").getByRole("button", { name: /^sign out$/i })).toHaveCount(0);
  await expect(page.locator(".admin-head")).not.toContainText(/signed in as admin/i);

  await test.step("Cancel keeps the account approved", async () => {
    await ui.actionsFor(page, username).click();
    await ui.menuItems(page).filter({ hasText: /^revoke$/i }).click();
    await expect(ui.confirm(page)).toContainText(username);
    await ui.confirm(page).getByRole("button", { name: /^cancel$/i }).click();
    await expect(ui.confirm(page)).toHaveCount(0);
    await expect(ui.actionsFor(page, username)).toBeFocused();
    expect(await accountStatus(request, username)).toBe("approved");
  });

  await test.step("confirming revokes it", async () => {
    await ui.actionsFor(page, username).click();
    await ui.menuItems(page).filter({ hasText: /^revoke$/i }).click();
    await ui.confirm(page).getByRole("button", { name: /^revoke access$/i }).click();
    await expect.poll(() => accountStatus(request, username)).toBe("rejected");
  });
});

test.describe("projector board at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the whole top 10 on one screen, then +N more (#127)", async ({ page, playwright, baseURL, request }) => {
    // Top the board up to 11 scored players (earlier specs may already have made some).
    const res = await request.get("/api/leaderboard");
    const have = ((await res.json()) as { entries: unknown[] }).entries.length;
    for (let i = have; i < 11; i += 1) await playingPlayer(playwright, baseURL, request, "e2eboard", 1);
    await signInAdmin(page);
    await page.goto("/#/admin?tab=accounts");
    await side.head(page).getByRole("button", { name: "Projector board" }).click();
    const rows = page.locator(".admin-board-row");
    await expect(rows).toHaveCount(10);
    await expect(page.locator(".admin-board-more")).toHaveText(/^\+\d+ more players?$/);
    await expect(page.locator(".admin-board-state")).toContainText(/live standings|frozen/i);
    // Every row and the "+N more" line sit inside the viewport, with nothing to scroll.
    const fits = await page.evaluate(() => {
      const bottoms = [...document.querySelectorAll(".admin-board-row, .admin-board-more")].map((el) => el.getBoundingClientRect().bottom);
      const body = document.querySelector(".admin-board .ov-body");
      return { inView: bottoms.every((b) => b <= window.innerHeight), scrolls: body !== null && body.scrollHeight > body.clientHeight + 1 };
    });
    expect(fits).toEqual({ inView: true, scrolls: false });
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

// ---- sections as nested items under Admin in the global nav (app frame, #97) ----------------------
const side = {
  main: (p: Page) => p.getByRole("navigation", { name: "Main" }),
  nav: (p: Page) => side.main(p).getByRole("list", { name: "Dashboard sections" }),
  link: (p: Page, name: RegExp) => side.nav(p).getByRole("link", { name }),
  panel: (p: Page, tab: string) => p.locator(`#admin-panel-${tab}`),
  head: (p: Page) => p.locator(".admin-head"),
};

test("sections: the sidebar links switch sections, mark the current one, and Back walks them", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/#/admin?tab=accounts");
  await expect(side.panel(page, "accounts")).toBeVisible();
  await expect(side.link(page, /^Accounts/)).toHaveAttribute("aria-current", "page");
  // Admin is the ancestor of the section; the quick actions sit in the page header; Authoring is a nav item.
  await expect(side.main(page).getByRole("link", { name: "Admin", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(side.head(page).getByRole("button", { name: "Projector board" })).toBeVisible();
  await expect(side.main(page).getByRole("link", { name: "Authoring" })).toHaveAttribute("href", "#/author");

  await side.link(page, /^Stats$/).click();
  await expect(page).toHaveURL(/#\/admin\?tab=stats$/);
  await expect(side.panel(page, "stats")).toBeVisible();
  await expect(side.panel(page, "accounts")).toBeHidden();
  await expect(side.link(page, /^Stats$/)).toHaveAttribute("aria-current", "page");
  await expect(side.link(page, /^Accounts/)).not.toHaveAttribute("aria-current", /.*/);

  await side.link(page, /^Audit log$/).click();
  await expect(side.panel(page, "audit")).toBeVisible();
  await expect(side.panel(page, "stats")).toBeHidden();

  await page.goBack();
  await expect(page).toHaveURL(/tab=stats/);
  await expect(side.panel(page, "stats")).toBeVisible();
  await expect(side.link(page, /^Stats$/)).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/tab=accounts/);
  await expect(side.panel(page, "accounts")).toBeVisible();
  await page.goForward();
  await expect(side.panel(page, "stats")).toBeVisible();
});

test("sections: a deep link opens its section (and the Live case) on a fresh load", async ({ page }) => {
  await signInAdmin(page);
  await page.goto(`/#/admin?tab=live&case=${CASE_ID}`);
  await page.reload();
  await expect(side.panel(page, "live")).toBeVisible();
  await expect(side.link(page, /^Live$/)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#admin-live-case")).toHaveValue(CASE_ID);
  await page.goto("/#/admin?tab=schedule");
  await expect(side.panel(page, "schedule")).toBeVisible();
  await expect(side.link(page, /^Schedule$/)).toHaveAttribute("aria-current", "page");
});

test("sections: leaving unsaved Schedule edits through the sidebar asks first", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/#/admin?tab=schedule");
  await page.locator("#sched-lock").click();
  await expect(page.locator("#sched-save")).toBeEnabled();

  await side.link(page, /^Live$/).click();
  await expect(ui.confirm(page)).toContainText(/discard unsaved changes/i);
  await ui.confirm(page).getByRole("button", { name: /keep editing/i }).click();
  await expect(side.panel(page, "schedule")).toBeVisible();
  await expect(page).toHaveURL(/tab=schedule/);
  await expect(side.link(page, /^Schedule$/)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#sched-save")).toBeEnabled();

  // The Authoring nav item leaves #/admin: the same guard.
  await side.main(page).getByRole("link", { name: "Authoring" }).click();
  await ui.confirm(page).getByRole("button", { name: /keep editing/i }).click();
  await expect(page).toHaveURL(/#\/admin\?tab=schedule/);

  await side.link(page, /^Live$/).click();
  await ui.confirm(page).getByRole("button", { name: /discard changes/i }).click();
  await expect(side.panel(page, "live")).toBeVisible();
  await expect(page).toHaveURL(/tab=live/);
});

test.describe("tablet rail", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("the rail shows every section as a named icon link", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/#/admin?tab=accounts");
    const rail = side.nav(page);
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("link")).toHaveCount(6);
    await expect.poll(async () => (await side.main(page).boundingBox())?.width).toBe(64);
    const event = rail.getByRole("link", { name: "Event" });
    await expect(event).toHaveAttribute("title", "Event");
    await event.click();
    await expect(side.panel(page, "event")).toBeVisible();
    await expect(event).toHaveAttribute("aria-current", "page");
  });
});
