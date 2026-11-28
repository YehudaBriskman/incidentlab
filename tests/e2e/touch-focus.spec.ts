// Accessibility foundations: focus moves to the new page's h1 on a route change and phone tables leave no
// invisible tab stops (#246); every control is 44px on a coarse pointer (#247); the frame never scrolls blank
// canvas past the content area (#249).
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, approveAccount, randomUsername } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";

async function signedInPlayer(page: Page, prefix: string): Promise<void> {
  const username = randomUsername(prefix);
  const reg = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(page.request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).status()).toBe(200);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

/**
 * Interactive elements whose hit area is under 44x44: the element's box, grown by an absolutely placed ::before
 * or ::after and by a wrapping <label>. Inline links inside running text are exempt (WCAG 2.5.8 inline).
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest("[inert], [hidden], dialog:not([open]), [aria-hidden=true]") !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !el.checkVisibility({ visibilityProperty: true })) continue;
      const style = getComputedStyle(el);
      if (el.tagName === "A" && style.display === "inline") continue;
      let w = r.width;
      let h = r.height;
      for (const p of ["::before", "::after"]) {
        const ps = getComputedStyle(el, p);
        if (ps.content === "none" || ps.content === "normal" || ps.position !== "absolute") continue;
        w = Math.max(w, parseFloat(ps.width) || 0);
        h = Math.max(h, parseFloat(ps.height) || 0);
      }
      const label = el.closest("label");
      if (label !== null && el.tagName === "INPUT") {
        const lr = label.getBoundingClientRect();
        w = Math.max(w, lr.width);
        h = Math.max(h, lr.height);
      }
      if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").join(".")} "${(el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
}

test.describe("phone with touch (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("player pages: every control has a 44px hit area on a coarse pointer", async ({ page }) => {
    await signedInPlayer(page, "touch44");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const path of ["/#/", "/#/home", `/#/case/${CASE_ID}`, `/#/case/${CASE_ID}/toolbox`, "/#/me", "/#/leaderboard", "/#/classes"]) {
      await page.goto(path);
      await settle(page);
      expect(await smallTargets(page), path).toEqual([]);
    }
  });

  test("admin pages: inputs, row menus and calendar selects are 44px on a coarse pointer", async ({ page }) => {
    expect((await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } })).ok()).toBe(true);
    for (const path of ["/#/admin?tab=accounts", "/#/admin?tab=classes", "/#/admin?tab=schedule", "/#/author"]) {
      await page.goto(path);
      await settle(page);
      expect(await smallTargets(page), path).toEqual([]);
    }
    // an open row menu: its items are touch targets too
    await page.goto("/#/admin?tab=accounts");
    await settle(page);
    await page.locator(".row-menu-btn:visible").first().click();
    await expect(page.locator(".ov-menu-item").first()).toBeVisible();
    await page.waitForTimeout(400); // the menu grows in (a scale transform) before it is measured
    expect(await smallTargets(page), "row menu").toEqual([]);
  });

  test("home: Tab never lands on an invisible control (the stacked table's header)", async ({ page }) => {
    await page.goto("/#/home");
    await settle(page);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const box = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, what: `${el.tagName} ${(el.textContent ?? "").trim().slice(0, 20)}` };
      });
      if (box === null) continue;
      expect(box.w > 2 && box.h > 2, `focus on an invisible element: ${box.what}`).toBe(true);
    }
  });
});

test("a route change moves focus to the new page's h1; a query change does not", async ({ page }) => {
  await signedInPlayer(page, "focus");
  await page.goto("/#/");
  await settle(page);
  // a pointer click: focus moves, but no ring is drawn
  await page.locator("nav#app-nav a[href='#/leaderboard']").click();
  await expect(page.locator("h1").first()).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(false);
  // the keyboard: focus moves and the ring shows
  await page.locator("nav#app-nav a[href='#/me']").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main.app-content h1").first()).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true);
  // the same page with another query (a leaderboard filter) keeps focus where the player put it
  await page.goto("/#/leaderboard");
  await settle(page);
  const search = page.locator("main.app-content a, main.app-content button, main.app-content select").first();
  await search.focus();
  await page.evaluate(() => (window.location.hash = "#/leaderboard?x=1"));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.activeElement?.tagName === "H1")).toBe(false);
});

test("the document never scrolls past the frame (hidden text stays in the content scroller)", async ({ page }) => {
  await signedInPlayer(page, "frame");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ["/#/me", `/#/case/${CASE_ID}/explorer`, `/#/case/${CASE_ID}`]) {
    await page.goto(path);
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
