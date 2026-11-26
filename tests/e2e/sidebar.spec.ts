// Contextual sidebar (#60): the per-page <aside> landmark and its aria-current marks on desktop, the collapse
// state kept across a reload, the phone drawer (a Sheet: focus trap, Escape returns focus), Hebrew RTL at
// 390px without horizontal overflow, moving between case stages from the sidebar, and the admin sections in the
// phone drawer.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

// ---- selectors: keep every UI hook here so UI changes need edits in one place ----------------
const ui = {
  aside: (p: Page, name: string | RegExp) => p.getByRole("complementary", { name }),
  stages: (p: Page) => p.getByRole("complementary", { name: "Case navigation" }).getByRole("list", { name: "Investigation stages" }),
  stage: (p: Page, n: number) => ui.stages(p).getByRole("button", { name: new RegExp(`^Stage ${n}:`) }),
  collapse: (p: Page) => p.getByRole("button", { name: "Collapse the sidebar" }),
  expand: (p: Page) => p.getByRole("button", { name: "Expand the sidebar" }),
  trigger: (p: Page, name: string) => p.locator(".page-header").getByRole("button", { name }),
  drawer: (p: Page, name: string) => p.getByRole("dialog", { name }),
  stageGoal: (p: Page) => p.locator("#stage .stage-goal"),
  stageKicker: (p: Page) => p.locator("#stage .stage-kicker"),
};

/** A fresh approved player, signed in on `page`, who has solved Stage 1 and is on Stage 2. */
async function playerOnStage2(page: Page, request: APIRequestContext): Promise<void> {
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

test("desktop: each page names its sidebar landmark and marks the current item", async ({ page, request }) => {
  await playerOnStage2(page, request);
  await freshSettings(page);

  await page.goto("/#/");
  await expect(ui.aside(page, "Filter cases")).toBeVisible();
  await expect(ui.aside(page, "Filter cases").getByRole("group", { name: "Difficulty" })).toBeVisible();

  await page.goto(`/#/case/${CASE_ID}`);
  await expect(ui.stages(page)).toBeVisible();
  await expect(ui.stage(page, 2)).toHaveAttribute("aria-current", "step");
  await expect(ui.aside(page, "Case navigation").getByRole("link", { name: "Toolbox: all commands" })).toHaveAttribute("href", `#/case/${CASE_ID}/toolbox`);
  await expect(ui.aside(page, "Case navigation").getByRole("heading", { name: "Hint budget" })).toBeVisible();

  await page.goto(`/#/case/${CASE_ID}/toolbox`);
  const toolbox = ui.aside(page, "Toolbox contents");
  await expect(toolbox.getByRole("searchbox")).toBeVisible();
  const second = toolbox.getByRole("navigation").getByRole("link").nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-current", "location");
  await expect(page.locator(".tb-section h2").nth(1)).toBeFocused();

  // A deep link still opens the file, and the file list marks it.
  await page.goto(`/#/case/${CASE_ID}/explorer?f=README_FIRST.txt`);
  const files = ui.aside(page, "Files & time");
  await expect(files.getByRole("button", { name: /^README_FIRST\.txt\b/ })).toHaveAttribute("aria-current", "true");
});

test("the collapsed sidebar stays collapsed after a reload", async ({ page }) => {
  await freshSettings(page);
  await page.goto("/#/");
  const aside = ui.aside(page, "Filter cases");
  await expect(aside).toBeVisible();
  await expect(ui.collapse(page)).toHaveAttribute("aria-expanded", "true");
  await ui.collapse(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(ui.expand(page)).toBeFocused();
  await expect(ui.expand(page)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(64);

  await page.reload();
  // settings-boot.js sets it before first paint
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(ui.expand(page)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(64);
  await ui.expand(page).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", /.*/);
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(264);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the drawer traps focus, closes on Escape and returns focus; a stage link closes it", async ({ page, request }) => {
    await playerOnStage2(page, request);
    await freshSettings(page);
    await page.goto(`/#/case/${CASE_ID}`);
    await expect(ui.aside(page, "Case navigation")).toBeHidden();
    const trigger = ui.trigger(page, "Stages and score");
    await trigger.click();
    const drawer = ui.drawer(page, "Case navigation");
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
    for (const hash of ["#/", `#/case/${CASE_ID}`, `#/case/${CASE_ID}/toolbox`, `#/case/${CASE_ID}/explorer`]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.locator(".page-header .sidebar-trigger")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${hash} scrolls sideways`).toBe(0);
    }
    await page.goto(`/#/case/${CASE_ID}`);
    await page.locator(".page-header .sidebar-trigger").click();
    const drawer = page.getByRole("dialog", { name: "ניווט בתיק" });
    await expect(drawer).toBeVisible();
    // Anchored to the inline-start edge, which is the right side in Hebrew (a classic scrollbar's gutter
    // may sit between it and the window edge).
    await expect.poll(async () => {
      const box = await drawer.boundingBox();
      return box === null ? null : { leftGap: box.x > 24, rightEdge: box.x + box.width >= 390 - 16 };
    }).toEqual({ leftGap: true, rightEdge: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("admin: the sections open in the drawer; a pick closes it, focuses the section and renames the button", async ({ page }) => {
    const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
    expect(login.status(), await login.text()).toBe(200);
    await freshSettings(page);
    await page.goto("/#/admin?tab=accounts");
    await expect(page.locator("#admin-panel-accounts")).toBeVisible();
    await expect(ui.aside(page, "Dashboard menu")).toBeHidden();
    const trigger = ui.trigger(page, "Sections: Accounts");
    await trigger.click();
    const drawer = ui.drawer(page, "Dashboard menu");
    await expect(drawer.getByRole("navigation", { name: "Dashboard sections" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await drawer.getByRole("link", { name: "Audit log" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator("#admin-panel-audit")).toBeVisible();
    await expect(page.locator("#admin-panel-audit")).toBeFocused();
    await expect(ui.trigger(page, "Sections: Audit log")).toBeVisible();

    await page.goBack();
    await expect(page.locator("#admin-panel-accounts")).toBeVisible();
    await expect(ui.trigger(page, "Sections: Accounts")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("desktop: the sidebar moves between finished stages and back to the current one", async ({ page, request }) => {
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
