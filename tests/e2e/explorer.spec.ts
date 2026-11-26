// Evidence Explorer (#44): the row detail drawer and its keyboard use, content-sized sortable CSV columns
// with inline epoch times, histogram bars as time filters, JSON conditions, the grouped file list and the
// download cache that spares a refetch when the worker restarts.
import { expect, test, type Page } from "@playwright/test";

const ROUTE = "/#/case/3am-outage/explorer";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  file: (p: Page, path: string) =>
    p.getByRole("complementary", { name: /files/i }).getByRole("button", { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`) }),
  count: (p: Page) => p.locator(".ex-count"),
  stepText: (p: Page, n: number) => p.getByRole("textbox", { name: `Step ${n} filter text` }),
  lines: (p: Page) => p.getByRole("region", { name: "File lines" }),
  rows: (p: Page) => p.locator(".ex-rows .ex-row[data-row]"),
  cursorRow: (p: Page) => p.locator(".ex-row.is-cursor"),
  drawer: (p: Page) => p.locator("#ex-drawer"),
  drawerHeading: (p: Page) => p.locator("#ex-detail-h"),
  drawerPos: (p: Page) => p.locator(".ex-detail-pos"),
  moreBtn: (p: Page) => p.locator(".ex-actions").getByRole("button", { name: "More line actions" }),
  menuItem: (p: Page, name: string) => p.getByRole("menu", { name: "More line actions" }).getByRole("menuitem", { name }),
  colHeader: (p: Page, name: string) => p.getByRole("group", { name: /^Columns/ }).getByRole("button", { name: new RegExp(`^${name}:`) }),
  plot: (p: Page) => p.getByRole("button", { name: "Plot", exact: true }),
  bars: (p: Page) => p.locator("svg.ex-chart rect"),
  timeChip: (p: Page) => p.locator(".ex-time-chip"),
  removeTime: (p: Page) => p.getByRole("button", { name: "Remove the time filter" }),
  condField: (p: Page, n: number) => p.getByRole("combobox", { name: `Condition ${n} field` }),
  condOp: (p: Page, n: number) => p.getByRole("combobox", { name: `Condition ${n} test` }),
  condValue: (p: Page, n: number) => p.getByRole("textbox", { name: `Condition ${n} value` }),
  addCond: (p: Page) => p.getByRole("button", { name: "+ Condition" }),
};

const LOADED = / of [\d,]+ lines?/;

async function openFile(page: Page, path: string): Promise<void> {
  await ui.file(page, path).click();
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
}

const countOf = async (page: Page): Promise<number> => {
  const m = /^([\d,]+) of/.exec((await ui.count(page).textContent()) ?? "");
  return m ? Number(m[1]?.replace(/,/g, "")) : Number.NaN;
};

test("explorer drawer: Enter opens line details, N and the buttons step, Escape returns to the line", async ({ page }) => {
  await page.goto(ROUTE);
  await openFile(page, "deploys/deploys.log");
  await ui.stepText(page, 1).fill("DEPLOY");
  await expect(ui.count(page)).toHaveText(LOADED);

  await ui.lines(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(ui.cursorRow(page)).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawerHeading(page)).toBeFocused();
  await expect(ui.drawerHeading(page)).toHaveText("Line 1");
  await expect(ui.drawerPos(page)).toHaveText(/^Match 1 of [\d,]+$/);
  // key=value pairs of the line are a field table, and the raw line is shown in full
  await expect(ui.drawer(page).getByRole("rowheader", { name: "service" })).toBeVisible();
  await expect(ui.drawer(page).locator(".ex-detail-raw")).toContainText("DEPLOY");

  await page.keyboard.press("n");
  await expect(ui.drawerHeading(page)).toHaveText("Line 2");
  await expect(ui.drawerPos(page)).toHaveText(/^Match 2 of/);
  await ui.drawer(page).getByRole("button", { name: "Next match" }).click();
  await expect(ui.drawerHeading(page)).toHaveText("Line 3");
  await ui.drawer(page).getByRole("button", { name: "Previous match" }).click();
  await expect(ui.drawerHeading(page)).toHaveText("Line 2");
  await page.keyboard.press("Shift+N");
  await expect(ui.drawerHeading(page)).toHaveText("Line 1");
  // the log's cursor follows the drawer
  await expect(ui.cursorRow(page).locator(".ex-ln")).toHaveText("1");

  await page.keyboard.press("Escape");
  await expect(ui.drawer(page)).toBeHidden();
  await expect(ui.cursorRow(page)).toBeFocused();

  // The toolbar keeps only match stepping; the rest sits in the ⋯ menu (#112).
  const actions = page.locator(".ex-actions");
  await expect(actions.getByRole("button", { name: "Previous match" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Next match" })).toBeVisible();
  await expect(actions.getByRole("button", { name: /^(Line details|Copy line|Link to line|Copy lines|Copy link|First match|Last match)$/ })).toHaveCount(0);
  await ui.moreBtn(page).click();
  await expect(ui.moreBtn(page)).toHaveAttribute("aria-expanded", "true");
  await expect(ui.menuItem(page, "First match")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ui.moreBtn(page)).toBeFocused();

  // A field's Filter button adds a step for that key=value.
  await ui.moreBtn(page).click();
  await ui.menuItem(page, "Line details").click();
  await expect(ui.drawer(page)).toBeVisible();
  await ui.drawer(page).getByRole("button", { name: /^Keep lines where service is / }).click();
  await expect(ui.stepText(page, 2)).toHaveValue(/^service=/);
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(ui.drawer(page)).toBeHidden();
});

test("explorer CSV: epoch times inline, content-sized columns, sortable headers", async ({ page }) => {
  await page.goto(ROUTE);
  await openFile(page, "metrics/checkout_metrics.csv");
  const firstTs = ui.rows(page).first().locator(".ex-cell").first();
  await expect(firstTs).toContainText(/^\d{10} \d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ$/);
  await expect(firstTs.locator(".ex-epoch")).toBeVisible();

  // Columns are sized to their content: the short "rps" column is narrower than the epoch column.
  const tsWidth = (await ui.colHeader(page, "ts_epoch").boundingBox())?.width ?? 0;
  const rpsWidth = (await ui.colHeader(page, "rps").boundingBox())?.width ?? 0;
  expect(rpsWidth).toBeGreaterThan(0);
  expect(rpsWidth).toBeLessThan(tsWidth);

  const p99 = ui.colHeader(page, "http_p99_ms");
  const p99Values = async (): Promise<number[]> =>
    (await ui.rows(page).locator(".ex-cell:nth-of-type(6)").allTextContents()).slice(0, 5).map(Number);

  await expect(p99).toHaveAccessibleName("http_p99_ms: not sorted. Sort ascending");
  await p99.click();
  await expect(p99).toHaveAccessibleName("http_p99_ms: sorted ascending. Sort descending");
  await expect(p99).toBeFocused();
  await expect(page).toHaveURL(/[?&]s=4\b/);
  await expect.poll(async () => { const v = await p99Values(); return v.every((x, i) => i === 0 || (v[i - 1] ?? 0) <= x); }).toBe(true);

  await page.keyboard.press("Enter");
  await expect(p99).toHaveAccessibleName(/sorted descending/);
  await expect(page).toHaveURL(/[?&]s=-4\b/);
  await expect.poll(async () => { const v = await p99Values(); return v.every((x, i) => i === 0 || (v[i - 1] ?? 0) >= x); }).toBe(true);

  await page.keyboard.press("Enter");
  await expect(p99).toHaveAccessibleName(/not sorted/);
  await expect(ui.rows(page).first().locator(".ex-ln")).toHaveText("2");

  // A shared link keeps the sort.
  await page.goto(`${ROUTE}?f=metrics%2Fcheckout_metrics.csv&s=-4`);
  await page.reload();
  await expect(p99).toHaveAccessibleName(/sorted descending/);
  await expect.poll(async () => { const v = await p99Values(); return v.length > 1 && v.every((x, i) => i === 0 || (v[i - 1] ?? 0) >= x); }).toBe(true);
});

test("explorer histogram: a bar click, or arrow keys and Enter, keep only that time", async ({ page }) => {
  await page.goto(ROUTE);
  await openFile(page, "app/checkout-service.log");
  const total = await countOf(page);
  await ui.plot(page).click();
  await expect(ui.bars(page).first()).toBeVisible();

  await ui.bars(page).nth(3).click();
  await expect(ui.timeChip(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]t=\d+-\d+/);
  await expect.poll(() => countOf(page)).toBeLessThan(total);
  await expect(page.locator(".ex-badge")).toHaveText("1");

  await ui.removeTime(page).click();
  await expect(ui.timeChip(page)).toBeHidden();
  await expect.poll(() => countOf(page)).toBe(total);

  // Keyboard: one Tab stop on the chart, arrows move between bars, Enter picks.
  const stop = page.locator('svg.ex-chart rect[tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  await page.keyboard.press("Home");
  await expect(ui.bars(page).first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(ui.bars(page).nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ui.timeChip(page)).toBeVisible();
  await expect.poll(() => countOf(page)).toBeLessThan(total);
  // the chart redraws for the narrower view and keeps keyboard focus
  await expect(page.locator("svg.ex-chart rect:focus")).toHaveCount(1);
});

test("explorer JSON: field picker and several conditions", async ({ page }) => {
  await page.goto(ROUTE);
  await openFile(page, "app/checkout-service.log");
  const total = await countOf(page);
  await expect(page.locator('#ex-json-fields option[value="level"]')).toHaveCount(1);

  await ui.condField(page, 1).fill("level");
  await ui.condValue(page, 1).fill("warn");
  await expect.poll(() => countOf(page)).toBeLessThan(total);
  const errors = await countOf(page);
  expect(errors).toBeGreaterThan(0);

  await ui.addCond(page).click();
  await expect(ui.condField(page, 2)).toBeFocused();
  await ui.condField(page, 2).fill("svc");
  await ui.condOp(page, 2).selectOption("exists");
  await expect(ui.condValue(page, 2)).toBeHidden();
  await expect(page).toHaveURL(/jf=level%3Dwarn&jf=svc%3D\*/);
  await expect.poll(() => countOf(page)).toBeLessThanOrEqual(errors);

  await ui.condOp(page, 2).selectOption("ne");
  await ui.condValue(page, 2).fill("checkout");
  await expect.poll(() => countOf(page)).toBeLessThan(errors);

  await page.getByRole("button", { name: "Remove condition 2" }).click();
  await expect.poll(() => countOf(page)).toBe(errors);
});

test("explorer files: grouped by folder, searchable by path and format", async ({ page }) => {
  await page.goto("/#/case/kubernetes-crime-scene/explorer");
  const side = page.getByRole("complementary", { name: /files/i });
  await expect(side.getByRole("heading", { name: /^helm\// })).toBeVisible();
  await expect(side.getByRole("heading", { name: /^Top level/ })).toBeVisible();
  await side.getByRole("searchbox").fill("helm");
  await expect(side.getByRole("status").filter({ hasText: /of \d+ files/ })).toBeVisible();
  await expect(side.getByRole("heading", { name: /^chat\// })).toHaveCount(0);
  await side.getByRole("searchbox").fill("no-such-file-xyz");
  await expect(side.getByText("No files match.")).toBeVisible();
});

test("explorer cache: a worker restart reloads a big file without downloading it again", async ({ page }) => {
  test.setTimeout(150_000);
  const fetched: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/evidence/3am-outage/files/nginx/access.log")) fetched.push(req.url());
  });
  await page.goto(ROUTE);
  await openFile(page, "nginx/access.log");
  expect(fetched).toHaveLength(1);

  // A catastrophic regex blows the hard time budget: the worker is killed and the file reloaded.
  await page.getByRole("combobox", { name: "Step 1 filter type" }).selectOption("regex");
  await ui.stepText(page, 1).fill("(.+)+@@$");
  await expect(page.locator(".ex-notice")).toContainText(/reloaded/i, { timeout: 60_000 });
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
  expect(fetched).toHaveLength(1);
});

test("explorer on a phone: filters open in a bottom sheet, apply live, and focus returns to the Filters button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ROUTE}?f=deploys/deploys.log`);
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
  const before = await countOf(page);
  const summary = page.locator(".ex-controls-sum");
  await summary.click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox", { name: "Step 1 filter text" }).fill("DEPLOY");
  await sheet.getByRole("button", { name: "Show results" }).click();
  await expect(sheet).toBeHidden();
  await expect(summary).toBeFocused();
  await expect.poll(() => countOf(page)).toBeLessThan(before);
  // the fieldset is back in the page, with the value kept
  await expect(page.locator(".ex-controls .ex-fieldset")).toHaveCount(1);
  // (inside the collapsed inline panel, so query by attribute rather than by role)
  await expect(page.locator('.ex-controls [aria-label="Step 1 filter text"]')).toHaveValue("DEPLOY");
});

test("explorer files: rows show just the name; path, format and description open in a tooltip on hover and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTE);
  const row = ui.file(page, "app/checkout-service.log");
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("JSON"); // no format or description text in the row itself
  const tip = page.getByRole("tooltip");
  await row.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("app/checkout-service.log");
  await expect(row).toHaveAttribute("aria-describedby", /ov-tip/);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await page.mouse.move(0, 0);
  await row.focus(); // programmatic focus after a key press counts as keyboard focus
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(tip).toBeVisible();
});
