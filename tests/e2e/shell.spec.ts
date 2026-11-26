// App shell (#59): navbar aria-current, language toggle, the ⚙ display settings (persistence and keyboard)
// and reflow at phone width in Hebrew.
import { expect, test, type Page } from "@playwright/test";

const ui = {
  nav: (p: Page) => p.getByRole("navigation", { name: /^(main|ראשי)$/i }),
  settingsButton: (p: Page) => p.locator(".settings-btn"),
  settingsPanel: (p: Page) => p.locator("#settings-panel"),
  radio: (p: Page, name: string, value: string) => p.locator(`#settings-panel input[name="set-${name}"][value="${value}"]`),
  langButton: (p: Page, label: "EN" | "עב") => p.getByRole("group", { name: /^(language|שפה)$/i }).getByRole("button", { name: label }),
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
  await ui.settingsButton(page).click();
  await expect(ui.settingsPanel(page)).toBeVisible();
  await ui.radio(page, "theme", "dark").check();
  await ui.radio(page, "text-scale", "125").check();
  await ui.radio(page, "contrast", "on").check();
  await ui.radio(page, "spacing", "wide").check();
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

  await ui.settingsButton(page).click();
  await expect(ui.radio(page, "theme", "dark")).toBeChecked();
  await ui.radio(page, "theme", "system").check();
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
});

test("a corrupt settings value falls back to defaults", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("il.settings", JSON.stringify({ theme: "neon", textScale: 112.5 })));
  await page.reload();
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
  await expect(html).toHaveAttribute("data-text-scale", "112.5");
});

test("language toggle switches to Hebrew RTL and back", async ({ page }) => {
  await ui.langButton(page, "עב").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(ui.nav(page).getByRole("link", { name: "תיקים" })).toBeVisible();
  await expect(ui.langButton(page, "עב")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await ui.langButton(page, "EN").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(ui.nav(page).getByRole("link", { name: "Cases" })).toBeVisible();
});

test("settings menu works from the keyboard", async ({ page }) => {
  const button = ui.settingsButton(page);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(ui.settingsPanel(page)).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  // focus lands on the checked theme radio; arrows move within the group and apply the setting
  await expect(ui.radio(page, "theme", "system")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(ui.radio(page, "theme", "light")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // Tab moves to the next group
  await page.keyboard.press("Tab");
  await expect(ui.radio(page, "text-scale", "100")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ui.settingsPanel(page)).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("navigation marks the current page with aria-current", async ({ page }) => {
  const nav = ui.nav(page);
  await expect(nav.getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Leaderboard" }).click();
  await expect(page).toHaveURL(/#\/leaderboard/);
  await expect(nav.getByRole("link", { name: "Leaderboard" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Cases" })).not.toHaveAttribute("aria-current", /.*/);
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
});

test("no horizontal overflow at 390px in Hebrew; navigation folds behind a menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.reload();
  for (const path of ["/#/", "/#/leaderboard", "/#/case/ghost-in-the-network"]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  const toggle = page.locator(".nav-toggle");
  await expect(ui.nav(page)).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(ui.nav(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ui.nav(page)).toBeHidden();
  // the header stays two short rows at most (navbar + live strip)
  const headerHeight = await page.evaluate(() => document.querySelector("header.navbar")?.getBoundingClientRect().height ?? 0);
  expect(headerHeight).toBeLessThan(140);
});

test("reflow: at 320px with 200% text the navbar wraps instead of scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const lang of ["en", "he"]) {
    await page.addInitScript((l) => localStorage.setItem("il.lang", l), lang);
    await page.goto("/#/login");
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    await expect(ui.settingsButton(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${lang}: horizontal overflow`).toBeLessThanOrEqual(0);
    const box = await ui.settingsButton(page).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 320, `${lang}: settings button on screen`).toBe(true);
  }
});
