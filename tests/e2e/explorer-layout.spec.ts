// Explorer layout (#280): the log is the page. One header row, a compact filter toolbar, the Analyze panel beside
// the log behind a window splitter (APG: drag, arrows mirrored in RTL, Home/End, double-click resets, remembered
// per device), a maximized log that Escape restores, a collapsible files pane, a centred empty state, and no empty
// column at any width.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TAGS } from "./a11y-support";

const ROUTE = "/#/case/3am-outage/explorer";
const LOADED = /[\d,]+ (of|מתוך) [\d,]+/;

const ui = {
  count: (p: Page) => p.locator(".ex-count"),
  quick: (p: Page) => p.getByRole("textbox", { name: "Step 1 filter text" }),
  analyze: (p: Page) => p.getByRole("button", { name: /^Analyze/ }),
  panel: (p: Page) => p.getByRole("region", { name: "Analyze" }),
  tab: (p: Page, name: string) => p.getByRole("tab", { name }),
  splitter: (p: Page) => p.getByRole("separator", { name: "Resize the log and the analysis panel" }),
  maximize: (p: Page) => p.getByRole("button", { name: "Maximize log" }),
  chips: (p: Page) => p.getByRole("list", { name: "Active filters" }),
  pane: (p: Page) => p.locator(".ex-view"),
  files: (p: Page) => p.getByRole("complementary", { name: /files/i }),
  filesBtn: (p: Page) => p.locator(".ex-files-btn"),
};

const countOf = async (p: Page): Promise<number> => Number(/^([\d,]+)/.exec((await ui.count(p).textContent()) ?? "")?.[1]?.replace(/,/g, "") ?? "NaN");

async function openLoaded(page: Page, file = "nginx/access.log"): Promise<void> {
  await page.goto(`${ROUTE}?f=${encodeURIComponent(file)}`);
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
}

/** Runs "Count unique values" with the first preset (the panel open beside the log). */
async function countValues(page: Page): Promise<void> {
  if ((await ui.analyze(page).getAttribute("aria-expanded")) !== "true") await ui.analyze(page).click();
  await ui.tab(page, "Count unique values").click();
  await ui.panel(page).getByRole("button", { name: "Count", exact: true }).click();
  await expect(ui.panel(page).locator(".ex-agg-out table")).toBeVisible({ timeout: 30_000 });
}

/** The log pane's height and its share of the viewport, plus how much of the content box the Explorer leaves empty. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const pane = document.querySelector(".ex-view")?.getBoundingClientRect();
    const col = document.querySelector(".ex-col")?.getBoundingClientRect();
    const body = document.querySelector(".ex-body")?.getBoundingClientRect();
    const content = document.querySelector("main.app-content");
    const cs = content ? getComputedStyle(content) : null;
    const inner = content && cs ? content.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0;
    const split = document.querySelector(".ex-split")?.getBoundingClientRect();
    const panel = document.querySelector(".ex-analyze:not([hidden])")?.getBoundingClientRect();
    const splitter = document.querySelector(".ex-splitter:not([hidden])")?.getBoundingClientRect();
    const visible = pane ? Math.min(pane.bottom, vh) - Math.max(pane.top, 0) : 0;
    return {
      share: visible / vh,
      bodyGap: inner - (body?.width ?? 0),
      // the split is filled edge to edge: the log, the splitter and the panel add up to its width
      splitGap: (split?.width ?? 0) - ((pane?.width ?? 0) + (panel?.width ?? 0) + (splitter?.width ?? 0)),
      colGap: (col?.width ?? 0) - (split?.width ?? 0),
      scrolls: content === null ? true : content.scrollHeight > content.clientHeight + 1,
    };
  });
}

for (const lang of ["en", "he"] as const) {
  for (const [w, hgt] of [[1280, 800], [1440, 900], [1760, 900]] as const) {
    test(`${lang} ${w}x${hgt}: the log keeps 60%+ of the screen with filters set and Analyze open, and no column is left empty`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: hgt });
      await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
      await page.goto(ROUTE);
      // empty state first: the pane still fills the width
      await expect(page.locator(".ex-empty-card")).toBeVisible();
      let g = await geometry(page);
      expect(g.bodyGap).toBeLessThanOrEqual(1);
      expect(g.splitGap).toBeLessThanOrEqual(1);
      expect(g.colGap).toBeLessThanOrEqual(1);

      await openLoaded(page);
      await page.getByRole("textbox", { name: lang === "en" ? "Step 1 filter text" : "טקסט הסינון בשלב 1" }).fill(" 404 ");
      await page.getByRole("button", { name: lang === "en" ? "+ add filter" : "+ הוספת סינון" }).click();
      await page.getByRole("textbox", { name: lang === "en" ? "Step 2 filter text" : "טקסט הסינון בשלב 2" }).fill("GET");
      await page.getByRole("tab").nth(1).click();
      await page.locator("#ex-unique").press("Enter");
      await expect(page.locator(".ex-agg-out table")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".ex-analyze")).toBeVisible();

      g = await geometry(page);
      expect(g.share, `log share at ${w}x${hgt}`).toBeGreaterThanOrEqual(0.6);
      expect(g.scrolls).toBe(false);
      expect(g.bodyGap).toBeLessThanOrEqual(1);
      expect(g.splitGap).toBeLessThanOrEqual(1);
      expect(g.colGap).toBeLessThanOrEqual(1);
    });
  }
}

test("the splitter: drag, arrow keys, Home/End and double-click resize the panel, and the size is remembered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLoaded(page, "deploys/deploys.log");
  await ui.analyze(page).click();
  const splitter = ui.splitter(page);
  await expect(splitter).toBeVisible();
  await expect(splitter).toHaveAttribute("aria-orientation", "vertical");
  await expect(splitter).toHaveAttribute("aria-controls", "ex-work");
  const width = async (): Promise<number> => (await page.locator(".ex-analyze").boundingBox())?.width ?? 0;
  const now = async (): Promise<number> => Number(await splitter.getAttribute("aria-valuenow"));
  const start = await width();
  const startValue = await now();
  expect(startValue).toBeGreaterThan(0);

  // drag the splitter 120px toward the log: the panel grows by as much, and the log's share drops
  const box = await splitter.boundingBox();
  if (box === null) throw new Error("no splitter box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(start + 100);
  expect(await now()).toBeLessThan(startValue);

  // keyboard: ArrowRight moves the splitter right (the panel narrows in LTR), Home and End go to the ends
  await splitter.focus();
  const dragged = await width();
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBeLessThan(dragged);
  await page.keyboard.press("End");
  await expect.poll(now).toBe(Number(await splitter.getAttribute("aria-valuemax")));
  await expect.poll(width).toBe(280);
  await page.keyboard.press("Home");
  await expect.poll(now).toBe(Number(await splitter.getAttribute("aria-valuemin")));
  await page.keyboard.press("ArrowRight");
  const kept = await width();

  // remembered on this device
  await page.reload();
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
  await ui.analyze(page).click();
  await expect.poll(width).toBe(kept);

  // a double-click puts it back
  await ui.splitter(page).dblclick();
  await expect.poll(width).toBe(380);
});

test("Hebrew: the panel sits at the left and the splitter's arrows follow it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("il.lang", "he"));
  await openLoaded(page, "deploys/deploys.log");
  await page.getByRole("button", { name: /^ניתוח/ }).click();
  const panel = await page.locator(".ex-analyze").boundingBox();
  const log = await ui.pane(page).boundingBox();
  const files = await page.locator(".ex-filespane").boundingBox();
  expect(panel !== null && log !== null && panel.x < log.x).toBe(true);
  expect(files !== null && log !== null && files.x > log.x).toBe(true);
  const splitter = page.getByRole("separator");
  const width = async (): Promise<number> => (await page.locator(".ex-analyze").boundingBox())?.width ?? 0;
  const before = await width();
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBeGreaterThan(before);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBeLessThan(before);
});

test("maximize: only the log and the filter chips stay; Escape restores the layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLoaded(page, "deploys/deploys.log");
  await ui.quick(page).fill("DEPLOY");
  await expect.poll(() => countOf(page)).toBeGreaterThan(0);
  await ui.analyze(page).click();
  await expect(ui.chips(page)).toBeHidden(); // step 1 is in the quick filter, so it needs no chip

  await ui.maximize(page).click();
  await expect(ui.maximize(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ex-head")).toBeHidden();
  await expect(ui.panel(page)).toBeHidden();
  await expect(ui.quick(page)).toBeHidden();
  await expect(ui.chips(page)).toContainText("contains DEPLOY");
  const share = (await geometry(page)).share;
  expect(share).toBeGreaterThanOrEqual(0.8);

  await page.getByRole("region", { name: "File lines" }).focus();
  await page.keyboard.press("Escape");
  await expect(ui.maximize(page)).toHaveAttribute("aria-pressed", "false");
  await expect(ui.maximize(page)).toBeFocused();
  await expect(page.locator(".ex-head")).toBeVisible();
  await expect(ui.panel(page)).toBeVisible();
  await expect(ui.quick(page)).toHaveValue("DEPLOY");
});

test("an aggregation result stays beside the log, and clicking a value adds it as a filter", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLoaded(page);
  const total = await countOf(page);
  await countValues(page);
  // the results are still there while the log scrolls
  await page.getByRole("region", { name: "File lines" }).evaluate((el) => (el.scrollTop = 4000));
  await expect(ui.panel(page).locator(".ex-agg-out table")).toBeInViewport();
  const value = ui.panel(page).locator(".ex-agg-out tbody .ex-linkish").nth(1);
  const text = (await value.textContent()) ?? "";
  await value.click();
  // step 1 was empty, so the value becomes the quick filter
  await expect(ui.quick(page)).toHaveValue(text);
  await expect.poll(() => countOf(page)).toBeLessThan(total);
  // a second value adds a step 2, shown as a chip
  await ui.panel(page).locator(".ex-agg-out tbody .ex-linkish").first().click();
  await expect(ui.chips(page).getByRole("listitem")).toHaveCount(1);
  await expect(ui.analyze(page)).toHaveText(/Analyze \(1\)/);
});

test("the files pane collapses and stays collapsed; the empty state is centred in the log pane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTE);
  const card = page.locator(".ex-empty-card");
  await expect(card).toBeVisible();
  const c = await card.boundingBox();
  const p = await ui.pane(page).boundingBox();
  if (c === null || p === null) throw new Error("no boxes");
  expect(Math.abs(c.x + c.width / 2 - (p.x + p.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(c.y + c.height / 2 - (p.y + p.height / 2))).toBeLessThanOrEqual(2);
  expect(p.height).toBeGreaterThan(500);

  await expect(ui.filesBtn(page)).toHaveAttribute("aria-expanded", "true");
  const before = p.width;
  await ui.filesBtn(page).click();
  await expect(ui.files(page)).toBeHidden();
  await expect.poll(async () => (await ui.pane(page).boundingBox())?.width ?? 0).toBeGreaterThan(before + 200);
  await page.reload();
  await expect(ui.filesBtn(page)).toHaveAttribute("aria-expanded", "false");
  await expect(ui.files(page)).toBeHidden();
  // "Browse files" brings it back and puts focus in its search
  await page.getByRole("button", { name: "Browse files" }).click();
  await expect(ui.files(page)).toBeVisible();
  await expect(ui.files(page).getByRole("searchbox")).toBeFocused();
});

test("phone: the files and Analyze open as sheets, and the log keeps most of the screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(ROUTE);
  await ui.filesBtn(page).click();
  const files = page.getByRole("dialog", { name: "Files & time" });
  await expect(files).toBeVisible();
  await files.getByRole("button", { name: /^deploys\/deploys\.log\b/ }).click();
  await expect(files).toBeHidden();
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
  const pane = await ui.pane(page).boundingBox();
  expect((pane?.height ?? 0) / 844).toBeGreaterThanOrEqual(0.6);

  await ui.analyze(page).click();
  const sheet = page.getByRole("dialog", { name: "Analyze" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("tab", { name: "Count unique values" }).click();
  await expect(sheet.getByRole("tab", { name: "Count unique values" })).toHaveAttribute("aria-selected", "true");
  await sheet.getByRole("button", { name: "Show results" }).click();
  await expect(sheet).toBeHidden();
  await expect(ui.analyze(page)).toBeFocused();
  await context.close();
});

for (const [width, hgt] of [[1280, 800], [390, 844]] as const) {
  test(`axe: the Explorer with a file, filters, Analyze open and maximized, ${width}px`, async ({ browser }) => {
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height: hgt }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await openLoaded(page, "deploys/deploys.log");
    await ui.quick(page).fill("DEPLOY");
    const failing: string[] = [];
    const scan = async (state: string): Promise<void> => {
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags([...TAGS, "best-practice"]).analyze();
      for (const v of results.violations) {
        if (["moderate", "serious", "critical"].includes(v.impact ?? "")) failing.push(`${state} [${v.impact}] ${v.id}: ${v.help} e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`);
      }
    };
    await scan("filtered");
    await ui.analyze(page).click();
    await page.getByRole("tab", { name: "Lines over time" }).click();
    await scan("analyze");
    if (phone) await page.getByRole("dialog", { name: "Analyze" }).getByRole("button", { name: "Show results" }).click();
    await ui.maximize(page).click();
    await scan("maximized");
    await context.close();
    expect(failing, failing.join("\n")).toEqual([]);
  });
}
