// The one account menu (#220), the nav per persona (#221) and one h1 plus a real title per route (#222).
// - The menu: a disclosure button (aria-haspopup=dialog, aria-expanded) and a non-modal panel of links, buttons and
//   native radio groups (language, theme); Escape closes it and focus returns to the button; on phones the same
//   content is a bottom Sheet. Signed out it is the "Language and display" button beside Sign in.
// - The nav: the sitemap's items per persona (visitor, guest, player, class admin, author, owner).
// - Every main route: exactly one visible h1 and a title that names the page (never just "IncidentLab").
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, accountButton, accountPanel, adminHeaders, approveAccount, randomUsername } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const ui = {
  nav: (p: Page) => p.getByRole("navigation", { name: /^(main|ראשי)$/i }),
  navLabels: (p: Page) => ui.nav(p).locator(".nav-item:not([hidden]) > .nav-link .nav-label"),
  sheet: (p: Page) => p.locator("dialog.account-sheet"),
  crumbLeaf: (p: Page) => p.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=page]"),
};

type Persona = "visitor" | "guest" | "player" | "classAdmin" | "author" | "owner";

async function accountId(request: APIRequestContext, username: string): Promise<string> {
  const res = await request.get("/api/admin/accounts", { headers: adminHeaders });
  const { accounts } = (await res.json()) as { accounts: { accountId: string; username: string }[] };
  const found = accounts.find((a) => a.username === username.toLowerCase());
  if (found === undefined) throw new Error(`no account ${username}`);
  return found.accountId;
}

/** Signs `page` in as the persona (through the API). A fresh context is English (the browser's language). */
async function as(page: Page, who: Persona): Promise<string | null> {
  if (who === "visitor") return null;
  if (who === "guest") {
    expect((await page.request.post("/api/guest", { data: {} })).status()).toBe(201);
    return null;
  }
  if (who === "owner") {
    expect((await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } })).ok()).toBe(true);
    return ADMIN_USERNAME;
  }
  const username = randomUsername("menu");
  expect((await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } })).status()).toBe(201);
  await approveAccount(page.request, username);
  if (who === "author") {
    const id = await accountId(page.request, username);
    const res = await page.request.put(`/api/admin/accounts/${id}/role`, { headers: adminHeaders, data: { role: "author" } });
    expect(res.status(), await res.text()).toBe(200);
  }
  expect((await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } })).ok()).toBe(true);
  if (who === "classAdmin") {
    const res = await page.request.post("/api/classes", { data: { name: "Menu class" } });
    expect(res.status(), await res.text()).toBe(201);
  }
  return username;
}

/* ---------------- the menu ---------------- */

test("signed out: a Language and display button beside Sign in; keyboard, language and Escape", async ({ page }) => {
  await as(page, "visitor");
  await page.goto("/#/");
  const button = page.getByRole("button", { name: "Language and display" });
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".topbar").getByRole("link", { name: "Sign in" })).toBeVisible();
  // the old separate controls are gone
  await expect(page.locator(".lang-toggle, .settings-btn, #settings-panel")).toHaveCount(0);

  await button.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Language and display" });
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  // no identity and no session for a visitor: the preferences only
  await expect(panel.getByRole("button", { name: /sign out/i })).toHaveCount(0);
  await expect(panel.getByRole("group", { name: "Language" })).toBeVisible();
  await expect(panel.getByRole("group", { name: "Theme" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Display options…" })).toHaveAttribute("href", "#/settings/display");
  // focus starts on the checked language; Tab goes on to the theme group
  await expect(panel.getByRole("radio", { name: "English" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("radio", { name: "System" })).toBeFocused();

  // The language switch: arrow to Hebrew, the page re-labels, the panel stays open with focus on the radio.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const hePanel = page.getByRole("dialog", { name: "שפה ותצוגה" });
  await expect(hePanel).toBeVisible();
  await expect(hePanel.getByRole("radio", { name: "עברית" })).toBeFocused();
  await expect(ui.nav(page).getByRole("link", { name: "תיקים" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(hePanel).toBeHidden();
  await expect(page.getByRole("button", { name: "שפה ותצוגה" })).toBeFocused();
  await expect(page.getByRole("button", { name: "שפה ותצוגה" })).toHaveAttribute("aria-expanded", "false");
});

test("signed in: identity first, then My stats, Settings, language, theme, display options and Sign out, in Tab order", async ({ page }) => {
  const username = (await as(page, "player")) ?? "";
  await page.goto("/#/");
  const button = accountButton(page);
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await button.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Account" });
  await expect(panel).toBeVisible();
  const head = panel.locator(".account-head");
  await expect(head).toBeFocused();
  await expect(head).toHaveAttribute("href", "#/settings/account");
  await expect(head).toContainText(username);
  await expect(head).toContainText("Player");
  await expect(head).toContainText("Hidden from the board");

  // Tab walks the panel in reading order, one stop per radio group.
  const order: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) return `radio:${el.name}`;
      return (el?.textContent ?? "").trim();
    }));
  }
  expect(order).toEqual(["My stats", "Settings", "radio:menu-set-lang", "radio:menu-set-theme", "Display options…", "Sign out", "Accessibility statement"]);

  // Escape from deep inside closes it and returns focus to the button.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  // Sign out is ordinary, not a danger button.
  await button.click();
  await expect(panel.getByRole("button", { name: "Sign out" })).not.toHaveClass(/danger/);
});

test("the theme switch applies at once, survives a reload, and the settings page agrees", async ({ page }) => {
  await as(page, "player");
  await page.goto("/#/");
  await accountButton(page).click();
  await accountPanel(page).getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(accountPanel(page)).toBeVisible(); // choosing a radio keeps the panel open
  await accountPanel(page).getByRole("link", { name: "Display options…" }).click();
  await expect(page).toHaveURL(/#\/settings\/display$/);
  await expect(accountPanel(page)).toBeHidden();
  await expect(page.locator(".settings-section").getByRole("radio", { name: "Dark" })).toBeChecked();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("a guest's menu leads with Create account", async ({ page }) => {
  await as(page, "guest");
  await page.goto("/#/");
  await accountButton(page).click();
  const panel = page.getByRole("dialog", { name: "Account", exact: true });
  await expect(panel.locator(".account-name")).toHaveText("Guest");
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Create account" })).toBeFocused();
  await panel.getByRole("button", { name: "Create account" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("dialog", { name: /create your account/i })).toBeVisible();
});

test("a class owner's header names the class role", async ({ page }) => {
  await as(page, "classAdmin");
  await page.goto("/#/");
  await accountButton(page).click();
  await expect(page.getByRole("dialog", { name: "Account" }).locator(".account-head")).toContainText("Owner of 1 class");
});

test("phones: the same menu opens as a bottom sheet with 44px rows; Escape returns focus", async ({ page }) => {
  await as(page, "guest");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  const button = accountButton(page);
  await button.click();
  const sheet = ui.sheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/is-bottom/);
  await expect(accountPanel(page)).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(sheet.locator(".account-head")).toBeFocused();
  await expect(sheet.getByRole("button", { name: "Create account" })).toBeVisible();
  // the whole sheet is on screen once it has slid in (Sign out never falls off the bottom)
  await expect.poll(() => sheet.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight + 1)).toBe(true);
  for (const row of await sheet.locator(".account-item, .settings-option").all()) {
    const box = await row.boundingBox();
    expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44); // subpixel layout can give 43.99
  }
  await expect(sheet.getByRole("button", { name: "Sign out" })).toBeInViewport();
  await sheet.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  // A link inside closes it and goes there.
  await button.click();
  await ui.sheet(page).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#\/settings\/account$/);
  await expect(ui.sheet(page)).toHaveCount(0);
});

for (const lang of ["en", "he"] as const) {
  for (const width of [1280, 390]) {
    test(`axe: the account menu open, ${lang}, ${width}px`, async ({ page }) => {
      for (const who of ["visitor", "player"] as const) {
        await page.context().clearCookies();
        if (who === "player") await as(page, "player");
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/#/");
        await page.evaluate((l) => localStorage.setItem("il.lang", l), lang);
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
        await accountButton(page).click();
        await expect(width === 390 ? ui.sheet(page) : accountPanel(page)).toBeVisible();
        await page.waitForTimeout(400);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${who}: ${v.id} ${v.nodes[0]?.target.join(" ") ?? ""}`);
        expect(serious, serious.join("\n")).toEqual([]);
        await page.keyboard.press("Escape");
      }
    });
  }
}

/* ---------------- the nav per persona (the sitemap, #221) ---------------- */

const NAV: Record<Persona, readonly string[]> = {
  visitor: ["Home", "Cases", "Leaderboard", "Classes"],
  guest: ["Home", "Cases", "Leaderboard", "Classes", "My stats"],
  player: ["Home", "Cases", "Leaderboard", "Classes", "My stats"],
  classAdmin: ["Home", "Cases", "Leaderboard", "Classes", "My stats"],
  author: ["Home", "Cases", "Leaderboard", "Classes", "My stats", "Authoring"],
  owner: ["Home", "Cases", "Leaderboard", "Classes", "Authoring", "Platform console"],
};

for (const who of Object.keys(NAV) as Persona[]) {
  test(`nav for the ${who} matches the sitemap`, async ({ page }) => {
    await as(page, who);
    await page.goto("/#/leaderboard");
    await expect(ui.navLabels(page)).toHaveText([...NAV[who]]);
  });
}

test("Home and Cases are different pages; Classes explains itself to visitors", async ({ page }) => {
  await as(page, "visitor");
  await page.goto("/#/");
  await expect(page.getByRole("link", { name: "Browse all cases" })).toHaveAttribute("href", "#/cases");
  expect(await page.locator("table.home-cases-table tbody tr[data-case]").count()).toBeLessThanOrEqual(5);
  await expect(page.getByRole("searchbox", { name: "Search cases" })).toHaveCount(0);
  await page.getByRole("link", { name: "Browse all cases" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cases");
  await expect(page.getByRole("searchbox", { name: "Search cases" })).toBeVisible();
  await expect(ui.nav(page).getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");

  await ui.nav(page).getByRole("link", { name: "Classes" }).click();
  await expect(page.getByRole("heading", { name: "How classes work" })).toBeVisible();
  await expect(page.locator(".classes-body").getByRole("link", { name: /sign in/i })).toBeVisible();
  await expect(page.locator(".classes-body").getByRole("link", { name: "Create account" })).toBeVisible();
});

test("the admin area: visitors never see the key form; Reviews lives inside the console", async ({ page }) => {
  await as(page, "visitor");
  await page.goto("/#/admin");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator("#admin-key")).toHaveCount(0);

  await page.context().clearCookies();
  await as(page, "owner");
  await page.goto("/#/author/reviews");
  await expect(page).toHaveURL(/#\/admin\/reviews$/);
  await page.reload(); // the page above still had the visitor's session cached
  await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
  await expect(ui.nav(page).getByRole("link", { name: "Platform console", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(ui.nav(page).locator(".nav-sub").getByRole("link", { name: /^Reviews/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator(".crumb")).toHaveText(["Home", "Platform console", "Reviews"]);
  await expect(page).toHaveTitle("Review queue · Platform console · IncidentLab");
  await page.getByRole("link", { name: "Back to the console" }).click();
  await expect(page).toHaveURL(/#\/admin/);
  await expect(page.getByRole("heading", { level: 1, name: "Platform console" })).toBeVisible();
  await expect(page).toHaveTitle(/ · Platform console · IncidentLab$/);
});

test("Hebrew: the console, authoring and class management have three different names", async ({ page }) => {
  await as(page, "owner");
  await page.goto("/#/");
  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.reload();
  await expect(ui.nav(page).getByRole("link", { name: "קונסולת הפלטפורמה" })).toBeVisible();
  await expect(ui.nav(page).getByRole("link", { name: "כתיבת תיקים" })).toBeVisible();
  await expect(ui.nav(page).getByRole("link", { name: /^ניהול/ })).toHaveCount(0);
});

/* ---------------- one h1 and a real title per route (#222) ---------------- */

async function checkRoute(page: Page, path: string, title: RegExp): Promise<string> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(title);
  await expect(page.locator("h1:visible"), `one visible h1 on ${path}`).toHaveCount(1);
  const text = await page.title();
  expect(text, `${path}: the title names the page`).not.toBe("IncidentLab");
  return text;
}

test("visitor routes: one visible h1 each and a title of their own", async ({ page }) => {
  await as(page, "visitor");
  const titles = [
    await checkRoute(page, "/#/", /^IncidentLab: /),
    await checkRoute(page, "/#/cases", /^Cases · IncidentLab$/),
    await checkRoute(page, "/#/leaderboard", /^Leaderboard · IncidentLab$/),
    await checkRoute(page, "/#/classes", /^Classes · IncidentLab$/),
    await checkRoute(page, "/#/login", /^Sign in · IncidentLab$/),
    await checkRoute(page, "/#/signup", /Create account · IncidentLab$/),
    await checkRoute(page, "/#/join/ABCDE-FGHJK", /Join a class · IncidentLab$/),
    await checkRoute(page, `/#/case/${CASE_ID}/explorer`, /^Evidence · Ghost in the Network · IncidentLab$/),
    await checkRoute(page, "/#/settings/display", /Settings · IncidentLab$/),
  ];
  expect(new Set(titles).size).toBe(titles.length);
  // the leaf crumb of #/signup names the page
  await page.goto("/#/signup");
  await expect(ui.crumbLeaf(page)).toHaveText("Create account");
});

test("player routes: one visible h1 each and a title of their own; no back link that says Cases and goes home", async ({ page }) => {
  await as(page, "player");
  const titles = [
    await checkRoute(page, "/#/", /^IncidentLab: /),
    await checkRoute(page, "/#/cases", /^Cases · IncidentLab$/),
    await checkRoute(page, `/#/case/${CASE_ID}`, /Ghost in the Network · IncidentLab$/),
    await checkRoute(page, `/#/case/${CASE_ID}/toolbox`, /Ghost in the Network/),
    await checkRoute(page, `/#/case/${CASE_ID}/explorer`, /^Evidence · Ghost in the Network · IncidentLab$/),
    await checkRoute(page, "/#/leaderboard", /^Leaderboard · IncidentLab$/),
    await checkRoute(page, "/#/classes", /^Classes · IncidentLab$/),
    await checkRoute(page, "/#/me", /^Your stats · IncidentLab$/),
    await checkRoute(page, "/#/settings/account", /^Account · Settings · IncidentLab$/),
  ];
  expect(new Set(titles).size).toBe(titles.length);
  for (const path of ["/#/me", "/#/leaderboard", `/#/case/${CASE_ID}`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#app a.back-link[href='#/']"), `${path}: no back link to home`).toHaveCount(0);
  }
  // The case page's way back to the catalog is the breadcrumb (#266 replaced the header's back link with the status line).
  await page.goto(`/#/case/${CASE_ID}`);
  await expect(page.locator("nav.crumbs a.crumb-link[href='#/cases']")).toBeVisible();
});

test("owner routes: one visible h1 each; the console's title names its section", async ({ page }) => {
  await as(page, "owner");
  const titles = [
    await checkRoute(page, "/#/admin?tab=accounts", /^Users · Platform console · IncidentLab$/),
    await checkRoute(page, "/#/admin?tab=live", /· Platform console · IncidentLab$/),
    await checkRoute(page, "/#/admin/reviews", /^Review queue · Platform console · IncidentLab$/),
    await checkRoute(page, "/#/author", /^Case authoring · IncidentLab$/),
  ];
  expect(new Set(titles).size).toBe(titles.length);
});
