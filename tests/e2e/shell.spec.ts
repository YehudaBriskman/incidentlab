// App shell (#59, frame #97): nav aria-current, the language and display settings (persistence; since #220 they
// live in the account menu and on #/settings/display) and reflow at phone width in Hebrew. The account menu's own
// keyboard, sheet and persona behaviour is in account-menu.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { accountButton, accountPanel, switchLanguage } from "./support";

const ui = {
  nav: (p: Page) => p.getByRole("navigation", { name: /^(main|ראשי)$/i }),
  menuRadio: (p: Page, name: string, value: string) => accountPanel(p).locator(`input[name="menu-set-${name}"][value="${value}"]`),
  pageRadio: (p: Page, name: string, value: string) => p.locator(`.settings-section input[name="page-set-${name}"][value="${value}"]`),
};

test.beforeEach(async ({ page }) => {
  await page.goto("/#/");
  await page.evaluate(() => {
    localStorage.removeItem("il.settings");
    localStorage.setItem("il.lang", "en");
  });
  await page.reload();
});

test("theme, text size and contrast survive a reload", async ({ page }) => {
  await accountButton(page).click();
  await expect(accountPanel(page)).toBeVisible();
  await ui.menuRadio(page, "theme", "dark").check();
  await page.keyboard.press("Escape");
  await page.goto("/#/settings/display");
  await ui.pageRadio(page, "text-scale", "125").check();
  await ui.pageRadio(page, "contrast", "on").check();
  await ui.pageRadio(page, "spacing", "wide").check();
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-text-scale", "125");
  await expect(html).toHaveAttribute("data-contrast", "more");

  await page.reload();
  // settings-boot.js applies them before the app runs
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-text-scale", "125");
  await expect(html).toHaveAttribute("data-contrast", "more");
  await expect(html).toHaveAttribute("data-spacing", "wide");
  const rootSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(rootSize).toBe("20px");

  // One stored state: the menu shows what the page set, and a change in the menu shows on the page at once.
  await accountButton(page).click();
  await expect(ui.menuRadio(page, "theme", "dark")).toBeChecked();
  await ui.menuRadio(page, "theme", "system").check();
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
  await expect(ui.pageRadio(page, "theme", "system")).toBeChecked();
});

test("a corrupt settings value falls back to defaults", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("il.settings", JSON.stringify({ theme: "neon", textScale: 112.5 })));
  await page.reload();
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
  await expect(html).toHaveAttribute("data-text-scale", "112.5");
});

test("the language switch goes to Hebrew RTL and back, and survives a reload", async ({ page }) => {
  await switchLanguage(page, "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(ui.nav(page).getByRole("link", { name: "תיקים" })).toBeVisible();
  await accountButton(page).click();
  await expect(accountPanel(page).getByRole("radio", { name: "עברית" })).toBeChecked();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await switchLanguage(page, "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(ui.nav(page).getByRole("link", { name: "Cases" })).toBeVisible();
});

test("navigation marks the current page with aria-current", async ({ page }) => {
  const nav = ui.nav(page);
  // the landing (#/) is no nav item (#279); Home is the dashboard
  await expect(nav.locator("[aria-current]")).toHaveCount(0);
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Cases" }).click();
  await expect(page).toHaveURL(/#\/cases$/);
  await expect(nav.getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Leaderboard" }).click();
  await expect(page).toHaveURL(/#\/leaderboard/);
  await expect(nav.getByRole("link", { name: "Leaderboard" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Cases" })).not.toHaveAttribute("aria-current", /.*/);
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  // The breadcrumb follows the page.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=page]")).toHaveText("Leaderboard");
});

test("no horizontal overflow at 390px in Hebrew; navigation opens from the top bar's menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.reload();
  for (const path of ["/#/", "/#/cases", "/#/leaderboard", "/#/case/ghost-in-the-network"]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  const toggle = page.locator(".topbar-menu");
  await expect(ui.nav(page)).toBeHidden();
  await toggle.click();
  await expect(ui.nav(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ui.nav(page)).toBeHidden();
  await expect(toggle).toBeFocused();
  // the top bar stays one slim row
  const headerHeight = await page.evaluate(() => document.querySelector("header.topbar")?.getBoundingClientRect().height ?? 0);
  expect(headerHeight).toBeLessThan(64);
});

test("reflow: at 320px with 200% text the top bar wraps instead of scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const lang of ["en", "he"]) {
    await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
    await page.goto("/#/login");
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    await expect(accountButton(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${lang}: horizontal overflow`).toBeLessThanOrEqual(0);
    const box = await accountButton(page).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 320, `${lang}: language and display button on screen`).toBe(true);
  }
});
