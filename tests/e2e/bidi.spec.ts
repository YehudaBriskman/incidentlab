// Hebrew bidi (#248): case prose takes the UI direction with its LTR runs isolated, bilingual titles stay in order,
// and search fields keep their magnifier and placeholder on the same side, empty or typed in English.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

async function hebrewPlayerOnStageOne(page: Page): Promise<void> {
  const username = randomUsername("bidi");
  await scheduleToday(page.request, CASE_ID);
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(page.request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
  expect((await page.request.get(`/api/cases/${CASE_ID}/progress`)).status()).toBe(200);
  expect((await page.request.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  await page.addInitScript(() => {
    localStorage.setItem("il.lang", "he");
    localStorage.setItem("il.pref.lookForOpen", "1");
  });
}

/** The search field's resolved direction, its padding sides, the icon's side and the placeholder's text box. */
async function searchGeometry(input: ReturnType<Page["locator"]>) {
  return input.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      direction: s.direction,
      padStart: s.direction === "rtl" ? parseFloat(s.paddingRight) : parseFloat(s.paddingLeft),
      padEnd: s.direction === "rtl" ? parseFloat(s.paddingLeft) : parseFloat(s.paddingRight),
      // "right 12px" computes to "calc(100% - 12px)"
      iconAtRight: s.backgroundPositionX.startsWith("right") || s.backgroundPositionX.includes("100%"),
      textAlign: s.textAlign,
    };
  });
}

async function expectIconBesidePlaceholder(input: ReturnType<Page["locator"]>): Promise<void> {
  // empty: the field reads right to left, the icon sits at its start (right), and the padding makes room for it there
  let g = await searchGeometry(input);
  expect(g.direction).toBe("rtl");
  expect(g.iconAtRight).toBe(true);
  expect(g.padStart).toBeGreaterThan(g.padEnd);
  // typing English does not flip the field away from its icon
  await input.fill("ada");
  g = await searchGeometry(input);
  expect(g.direction).toBe("rtl");
  expect(g.iconAtRight).toBe(true);
  expect(g.padStart).toBeGreaterThan(g.padEnd);
  await input.fill("");
}

test("Hebrew: 'Look for' items and the prompt read right to left, with paths and times isolated", async ({ page }) => {
  await hebrewPlayerOnStageOne(page);
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const items = page.locator(".look-for[open] ul > li");
  await expect(items.first()).toBeVisible();
  const n = await items.count();
  expect(n).toBeGreaterThan(1);
  const rights: number[] = [];
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    await expect(li).toHaveCSS("direction", "rtl");
    rights.push(Math.round((await li.boundingBox())?.x ?? 0) + Math.round((await li.boundingBox())?.width ?? 0));
  }
  // every bullet on one side: the items share their right edge
  expect(new Set(rights).size).toBe(1);
  // the item that starts with a path keeps the path in an LTR run, and its "(+02:00)" offset is isolated too
  const first = items.first();
  await expect(first.locator("code")).toHaveCSS("direction", "ltr");
  await expect(first.locator('bdi[dir="ltr"]', { hasText: "+02:00" })).toHaveCount(1);
  // every Hebrew block of the prompt is right to left
  for (const p of await page.locator(".prose.prompt :is(p, li)").all()) {
    if (/[֐-׿]/.test((await p.textContent()) ?? "")) await expect(p).toHaveCSS("direction", "rtl");
  }
});

test("Hebrew: the toolbox filter keeps its icon beside the placeholder, empty and typed", async ({ page }) => {
  await hebrewPlayerOnStageOne(page);
  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const filter = page.locator(`#tb-filter-${CASE_ID}`);
  await expect(filter).toBeVisible();
  await expectIconBesidePlaceholder(filter);
});

test("Hebrew: the Explorer mirrors (files at the right, Analyze at the left), with the case, file and typed filter isolated", async ({ page }) => {
  await hebrewPlayerOnStageOne(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/case/${CASE_ID}/explorer`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const files = page.getByRole("complementary", { name: "קבצים וזמן" });
  await files.getByRole("button").filter({ hasText: /\.log$/ }).first().click();
  await expect(page.locator(".ex-count")).toHaveText(/מתוך/, { timeout: 60_000 });
  // the header reads right to left: Files, the tool, then the file
  const x = async (sel: string): Promise<number> => (await page.locator(sel).boundingBox())?.x ?? 0;
  expect(await x(".ex-files-btn")).toBeGreaterThan(await x(".ex-heading"));
  expect(await x(".ex-heading")).toBeGreaterThan(await x(".ex-title"));
  await expect(page.locator(".ex-crumb-text")).toHaveAttribute("dir", "auto");
  await expect(page.locator(".ex-title")).toHaveAttribute("dir", "ltr");
  // the quick filter: the Hebrew placeholder reads right to left, a typed pattern left to right
  const quick = page.getByRole("textbox", { name: "טקסט הסינון בשלב 1" });
  await expect(quick).toHaveCSS("direction", "rtl");
  await quick.fill("GET /");
  await expect(quick).toHaveCSS("direction", "ltr");
  // Analyze opens at the inline end, which is the left; the files pane is at the right
  await page.getByRole("button", { name: /^ניתוח/ }).click();
  const panel = await page.locator(".ex-analyze").boundingBox();
  const log = await page.locator(".ex-view").boundingBox();
  const side = await files.boundingBox();
  expect(panel !== null && log !== null && panel.x + panel.width <= log.x + 1).toBe(true);
  expect(side !== null && log !== null && side.x >= log.x + log.width - 1).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Hebrew: the console's user search keeps its icon beside the placeholder, and topics read in order", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } })).ok()).toBe(true);
  await page.addInitScript(() => localStorage.setItem("il.lang", "he"));
  await page.goto("/#/admin?tab=accounts");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const search = page.locator("input.admin-search").first();
  await expect(search).toBeVisible();
  await expectIconBesidePlaceholder(search);

  // the case list: a topic list of English tags is one LTR run with locale commas, and a bilingual title keeps
  // both languages in one link (one flex item), each part isolated
  await page.goto("/#/cases");
  const tags = page.locator(".home-tags > bdi").first();
  await expect(tags).toBeVisible();
  await expect(tags).toHaveAttribute("dir", "ltr");
  expect(await tags.locator("bdi").count()).toBeGreaterThan(1);
  const bilingual = page.locator("a.home-case-link").filter({ hasText: "–" }).first();
  await expect(bilingual).toBeVisible();
  expect(await bilingual.evaluate((a) => a.children.length)).toBe(1);
  expect(await bilingual.locator("bdi").count()).toBe(2);
});

test("Hebrew answer formats keep a path's slash with the path, and free-form answers have a placeholder (#286)", async ({ page }) => {
  const username = randomUsername("bidifmt");
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  expect((await page.request.get("/api/cases/first-shift/progress")).status()).toBe(200);
  expect((await page.request.post("/api/cases/first-shift/setup-done", { data: {} })).status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("il.lang", "he"));
  await page.goto("/#/case/first-shift");
  const format = page.locator(".answer-format").first();
  await expect(format).toBeVisible();
  // the path is one left-to-right isolate, slash included
  await expect(format.locator('bdi[dir="ltr"]', { hasText: "/page.html" })).toHaveCount(1);
  await expect(format).toHaveAttribute("dir", "rtl");
  // the ⓘ stays on the format's line
  const [fmtBox, dotBox] = await Promise.all([format.boundingBox(), page.locator(".answer-format-line .info-dot").first().boundingBox()]);
  expect(fmtBox && dotBox && Math.abs(dotBox.y + dotBox.height / 2 - (fmtBox.y + fmtBox.height - 10)) < 20).toBeTruthy();
  await expect(page.locator(".answer-form input").first()).toHaveAttribute("placeholder", "התשובה שלכם");
});
