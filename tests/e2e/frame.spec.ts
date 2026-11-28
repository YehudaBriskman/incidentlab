// App frame (#97): the global nav (landmark "Main", aria-current), a case's nested items (stages, Toolbox,
// Explorer) under Cases, the page panel (Explorer files, toolbox contents), the rail and its persisted collapse,
// the phone drawer (a Sheet: focus trap, Escape returns focus), the top-bar account menu and status chip,
// Hebrew RTL at 390px, and no page-level scroll: the frame is 100dvh and only the nav and content scroll.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  nav: (p: Page) => p.getByRole("navigation", { name: /^(main|ראשי)$/i }),
  stages: (p: Page) => ui.nav(p).getByRole("list", { name: "Investigation stages" }),
  stage: (p: Page, n: number) => ui.stages(p).getByRole("button", { name: new RegExp(`^Stage ${n}:`) }),
  aside: (p: Page, name: string | RegExp) => p.getByRole("complementary", { name }),
  collapse: (p: Page) => p.getByRole("button", { name: "Collapse navigation" }),
  expand: (p: Page) => p.getByRole("button", { name: "Expand navigation" }),
  menu: (p: Page) => p.locator(".topbar-menu"),
  drawer: (p: Page, name: string | RegExp) => p.getByRole("dialog", { name }),
  account: (p: Page) => p.getByRole("button", { name: /Account:/ }),
  statusChip: (p: Page) => p.locator(".topbar .status-chip"),
  stageGoal: (p: Page) => p.locator("#stage .stage-goal"),
  stageKicker: (p: Page) => p.locator("#stage .stage-kicker"),
};

/** A fresh approved player, signed in on `page`, who has solved Stage 1 and is on Stage 2. Returns the name. */
async function playerOnStage2(page: Page, request: APIRequestContext): Promise<string> {
  const username = randomUsername("side");
  await scheduleToday(request, CASE_ID);
  expect((await request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
  const api = (path: string): string => `/api/cases/${CASE_ID}${path}`;
  expect((await page.request.get(api("/progress"))).status()).toBe(200);
  expect((await page.request.post(api("/setup-done"), { data: {} })).status()).toBe(200);
  const answer = await page.request.post(api("/answer"), { data: { questionId: "q1", answer: answerFor(CASE_ID, "q1") } });
  expect(answer.status(), await answer.text()).toBe(200);
  return username;
}

/** First load of the page (after any sign-in, so the app reads the session) with default settings. */
async function freshSettings(page: Page, lang: "en" | "he" = "en"): Promise<void> {
  await page.goto("/#/");
  await page.evaluate((l) => {
    localStorage.removeItem("il.settings");
    localStorage.setItem("il.lang", l);
  }, lang);
  await page.reload();
}

test("desktop: the nav marks the page, nests the case's stages and tools, and keeps panels as page content", async ({ page, request }) => {
  await playerOnStage2(page, request);
  await freshSettings(page);

  await expect(ui.nav(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");

  await page.goto(`/#/case/${CASE_ID}`);
  await expect(ui.stages(page)).toBeVisible();
  await expect(ui.stage(page, 2)).toHaveAttribute("aria-current", "step");
  // Cases is the ancestor of the page; the nested section is headed by the case title.
  await expect(ui.nav(page).getByRole("link", { name: "Cases", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(ui.nav(page).getByRole("link", { name: "Toolbox: all commands" })).toHaveAttribute("href", `#/case/${CASE_ID}/toolbox`);
  await expect(page.locator(".case-budget")).toContainText(/hints used/);
  // The breadcrumb names the case.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Ghost in the Network");

  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  await expect(ui.nav(page).getByRole("link", { name: "Toolbox: all commands" })).toHaveAttribute("aria-current", "page");
  const toolbox = ui.aside(page, "Toolbox contents");
  await expect(toolbox.getByRole("searchbox")).toBeVisible();
  const second = toolbox.getByRole("navigation").getByRole("link").nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-current", "location");
  await expect(page.locator(".tb-section h2").nth(1)).toBeFocused();

  // A deep link still opens the file, and the file list (a page panel, not the nav) marks it.
  await page.goto(`/#/case/${CASE_ID}/explorer?f=README_FIRST.txt`);
  await expect(ui.nav(page).getByRole("link", { name: "Evidence Explorer" })).toHaveAttribute("aria-current", "page");
  const files = ui.aside(page, "Files & time");
  await expect(files.getByRole("button", { name: /^README_FIRST\.txt\b/ })).toHaveAttribute("aria-current", "true");
  // Only one top-level page mark at a time.
  await page.goto("/#/leaderboard");
  await expect(ui.nav(page).locator(".nav-link[aria-current]")).toHaveCount(1);
  await expect(ui.nav(page).getByRole("link", { name: "Leaderboard" })).toHaveAttribute("aria-current", "page");
});

test("desktop: the stages in the nav move between finished stages and back to the current one", async ({ page, request }) => {
  await playerOnStage2(page, request);
  await freshSettings(page);
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(ui.stageKicker(page)).toContainText(/stage 2 of 6/i);

  await ui.stage(page, 1).click();
  await expect(ui.stageKicker(page)).toContainText(/stage 1 of 6/i);
  await expect(ui.stage(page, 1)).toHaveAccessibleName(/viewing/);
  await expect(ui.stageGoal(page)).toBeFocused();

  // Locked stages stay readable (focusable, aria-disabled) but do nothing.
  await expect(ui.stage(page, 4)).toHaveAttribute("aria-disabled", "true");
  await ui.stage(page, 4).dispatchEvent("click");
  await expect(ui.stageKicker(page)).toContainText(/stage 1 of 6/i);

  await ui.stage(page, 2).click();
  await expect(ui.stageKicker(page)).toContainText(/stage 2 of 6/i);
  await expect(ui.stage(page, 2)).toHaveAttribute("aria-current", "step");
});

test("the rail: collapse persists across a reload and the icons keep their names", async ({ page }) => {
  await freshSettings(page);
  const nav = ui.nav(page);
  await expect(ui.collapse(page)).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => (await nav.boundingBox())?.width).toBe(240);
  await ui.collapse(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-nav", "collapsed");
  await expect(ui.expand(page)).toBeFocused();
  await expect.poll(async () => (await nav.boundingBox())?.width).toBe(64);
  // Labels are visually hidden, not removed: the links keep their names, and a title shows them on hover.
  await expect(nav.getByRole("link", { name: "Leaderboard" })).toHaveAttribute("title", "Leaderboard");

  await page.reload();
  // settings-boot.js sets it before first paint
  await expect(page.locator("html")).toHaveAttribute("data-nav", "collapsed");
  await expect(ui.expand(page)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await nav.boundingBox())?.width).toBe(64);
  await ui.expand(page).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-nav", /.*/);
  await expect.poll(async () => (await nav.boundingBox())?.width).toBe(240);
  await expect(nav.getByRole("link", { name: "Leaderboard" })).not.toHaveAttribute("title", /.*/);
});

test("top bar: the account menu shows the name, My stats and Sign out; the status chip links today's case", async ({ page, request }) => {
  const username = await playerOnStage2(page, request);
  await freshSettings(page);
  await expect(ui.statusChip(page)).toBeVisible();
  await expect(ui.statusChip(page)).toHaveAttribute("href", `#/case/${CASE_ID}`);
  await expect(ui.statusChip(page)).toHaveAccessibleName(/Today's case: .*Ghost in the Network/);

  const button = ui.account(page);
  // initials of the first two words: "side_mber3p" -> "SM"
  const [w1 = "", w2 = ""] = username.split("_");
  await expect(button).toHaveText(`${w1[0] ?? ""}${w2[0] ?? ""}`.toUpperCase());
  await button.click();
  const panel = page.getByRole("dialog", { name: "Account" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(username);
  // focus starts on the identity header, the link to the account settings (#220)
  await expect(panel.locator(".account-head")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await panel.getByRole("link", { name: "My stats" }).click();
  await expect(page).toHaveURL(/#\/me$/);
  await expect(panel).toBeHidden();
  await expect(ui.nav(page).getByRole("link", { name: "My stats" })).toHaveAttribute("aria-current", "page");

  await button.click();
  await panel.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".topbar").getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("a dashboard page fits 1440x900: no page-level or content-area scroll; its section scrolls inside", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.status(), await login.text()).toBe(200);
  await freshSettings(page);
  await page.goto("/#/admin?tab=live");
  await expect(page.locator("#admin-panel-live")).toBeVisible();
  const sizes = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".app-content");
    return {
      doc: document.documentElement.scrollHeight - window.innerHeight,
      content: content === null ? -1 : content.scrollHeight - content.clientHeight,
      overflow: content === null ? "" : getComputedStyle(content).overflowY,
    };
  });
  expect(sizes.doc, "the document scrolls").toBeLessThanOrEqual(0);
  expect(sizes.content, "the content area scrolls").toBeLessThanOrEqual(0);
  expect(sizes.overflow).toBe("hidden");
});

test("reading pages scroll inside the content area, never the document", async ({ page, request }) => {
  await playerOnStage2(page, request);
  await freshSettings(page);
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(ui.stageKicker(page)).toBeVisible();
  const sizes = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".app-content");
    return { doc: document.documentElement.scrollHeight - window.innerHeight, content: content === null ? 0 : content.scrollHeight - content.clientHeight };
  });
  expect(sizes.doc).toBeLessThanOrEqual(0);
  expect(sizes.content).toBeGreaterThan(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the nav drawer traps focus, closes on Escape and returns focus; a stage pick closes it", async ({ page, request }) => {
    await playerOnStage2(page, request);
    await freshSettings(page);
    await page.goto(`/#/case/${CASE_ID}`);
    await expect(ui.nav(page)).toBeHidden();
    const trigger = ui.menu(page);
    await trigger.click();
    const drawer = ui.drawer(page, "Navigation");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("list", { name: "Investigation stages" })).toBeVisible();

    // Tab and Shift+Tab never leave the drawer
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();

    // Picking a stage in the drawer shows it and closes the drawer; focus lands on the stage heading.
    await trigger.click();
    await drawer.getByRole("button", { name: /^Stage 1:/ }).click();
    await expect(drawer).toBeHidden();
    await expect(ui.stageKicker(page)).toContainText(/stage 1 of 6/i);
    await expect(ui.stageGoal(page)).toBeFocused();
  });

  test("Hebrew: the drawer opens from the right and no page scrolls sideways", async ({ page, request }) => {
    await playerOnStage2(page, request);
    await freshSettings(page, "he");
    for (const hash of ["#/", `#/case/${CASE_ID}`, `#/case/${CASE_ID}/toolbox`, `#/case/${CASE_ID}/explorer`, "#/leaderboard"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(ui.menu(page)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${hash} scrolls sideways`).toBeLessThanOrEqual(0); // a reserved scrollbar gutter makes it negative
    }
    // The page panel opens from its page-header button.
    await page.goto(`/#/case/${CASE_ID}/toolbox`);
    await expect(page.locator(".page-header .aside-trigger")).toBeVisible();

    await page.goto(`/#/case/${CASE_ID}`);
    await ui.menu(page).click();
    const drawer = page.getByRole("dialog", { name: "ניווט" });
    await expect(drawer).toBeVisible();
    // The language lives in the account menu on every width (#220), not in the drawer.
    await expect(drawer.getByRole("group", { name: "שפה" })).toHaveCount(0);
    await expect.poll(async () => {
      const box = await drawer.boundingBox();
      return box === null ? null : { leftGap: box.x > 24, rightEdge: box.x + box.width >= 390 - 16 };
    }).toEqual({ leftGap: true, rightEdge: true });
  });

  test("admin: the sections open in the drawer; a pick closes it and focuses the section", async ({ page }) => {
    const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
    expect(login.status(), await login.text()).toBe(200);
    await freshSettings(page);
    await page.goto("/#/admin?tab=accounts");
    await expect(page.locator("#admin-panel-accounts")).toBeVisible();
    await ui.menu(page).click();
    const drawer = ui.drawer(page, "Navigation");
    await expect(drawer.getByRole("list", { name: "Dashboard sections" })).toBeVisible();
    await drawer.getByRole("link", { name: "Audit log" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator("#admin-panel-audit")).toBeVisible();
    await expect(page.locator("#admin-panel-audit")).toBeFocused();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Audit log");

    await page.goBack();
    await expect(page.locator("#admin-panel-accounts")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
