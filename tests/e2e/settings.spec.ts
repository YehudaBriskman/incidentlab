// The settings page (#219): #/settings/{account,security,privacy,display}. Every section renders with one h1, its
// crumb and title; password change, a new recovery code and the board opt-in work from their sections; a guest
// gets the create-account card and no security forms; Display shares its state with the ⚙ panel; and an axe scan
// covers every section at 1280 and 390 px in English and Hebrew.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TAGS } from "./a11y-support";
import { approveAccount, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const NEW_PASSWORD = "e2e-new-password-456";
const SECTIONS = [
  { id: "account", en: "Account", he: "חשבון" },
  { id: "security", en: "Security", he: "אבטחה" },
  { id: "privacy", en: "Privacy", he: "פרטיות" },
  { id: "display", en: "Display & language", he: "תצוגה ושפה" },
] as const;

/** An approved player, signed in on `page`. */
async function player(page: Page): Promise<string> {
  const username = randomUsername("e2eset");
  const reg = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(page.request, username);
  return username;
}

async function english(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("il.lang", "en"));
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${page.url()} [${v.impact ?? "?"}] ${v.id}: ${v.help} e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`);
}

const sectionList = (page: Page) => page.locator("aside.page-aside .settings-nav");

test("#/settings goes to Account, and every section renders with one h1, a crumb and a title", async ({ page }) => {
  const username = await player(page);
  await english(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/settings");
  await expect(page).toHaveURL(/#\/settings\/account$/);
  await expect(sectionList(page).getByRole("link")).toHaveText(SECTIONS.map((s) => s.en));

  for (const s of SECTIONS) {
    await page.goto(`/#/settings/${s.id}`);
    await expect(page.getByRole("heading", { level: 2, name: s.en })).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page).toHaveTitle(`${s.en} · Settings · IncidentLab`);
    await expect(page.locator(".crumbs .crumb")).toHaveText(["Home", "Settings", s.en]);
    await expect(sectionList(page).getByRole("link", { name: s.en })).toHaveAttribute("aria-current", "page");
  }

  await page.goto("/#/settings/account");
  const details = page.locator(".settings-details");
  await expect(details).toContainText(username);
  await expect(details).toContainText("Usernames can't be changed yet.");
  await expect(details).toContainText("Player");
  await expect(page.getByRole("region", { name: "Your classes" })).toContainText("You're not in a class yet.");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.goto("/#/settings/nope");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("not on the runbook");
});

test("Account lists your classes with your role, and signs you out", async ({ page }) => {
  await player(page);
  await english(page);
  const res = await page.request.post("/api/classes", { data: { name: "Settings class" } });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto("/#/settings/account");
  const row = page.locator(".settings-class").filter({ hasText: "Settings class" });
  await expect(row).toContainText("Owner");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/#\/$/);
  const session = (await (await page.request.get("/api/session")).json()) as { account: unknown };
  expect(session.account).toBeNull();
});

test("Security: change the password, then make a new recovery code", async ({ page }) => {
  const username = await player(page);
  await english(page);
  await page.goto("/#/settings/security");
  const pw = page.getByRole("region", { name: "Change password" });
  await pw.locator("#settings-pw-current").fill(PASSWORD);
  await pw.locator("#settings-pw-new").fill(NEW_PASSWORD);
  await pw.getByRole("button", { name: "Save new password" }).click();
  await expect(pw.getByText("Password changed.")).toBeVisible();
  const login = await page.request.post("/api/auth/login", { data: { username, password: NEW_PASSWORD } });
  expect(login.ok(), await login.text()).toBe(true);

  const recovery = page.locator("section.recovery-section");
  await recovery.getByLabel("Current password", { exact: true }).fill(NEW_PASSWORD);
  await recovery.getByRole("button", { name: /^make a new code$/i }).click();
  await expect(recovery.getByTestId("recovery-code")).toHaveText(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  await recovery.getByRole("button", { name: /^i've saved it$/i }).click();
  await expect(recovery.getByTestId("recovery-code")).toHaveCount(0);
});

test("Privacy: the board opt-in saves and the account menu follows", async ({ page }) => {
  await player(page);
  await english(page);
  await page.goto("/#/settings/privacy");
  const toggle = page.getByRole("switch", { name: "Show me on the global leaderboard" });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("#settings-board-note")).toContainText("your username and score are public");
  await toggle.check();
  await expect(page.locator(".toast-host .toast")).toContainText("You're on the global leaderboard.");
  const session = (await (await page.request.get("/api/session")).json()) as { account: { showOnGlobalBoard: boolean } };
  expect(session.account.showOnGlobalBoard).toBe(true);
  await page.getByRole("button", { name: /Account:/ }).click();
  const menu = page.getByRole("dialog", { name: "Account" });
  await expect(menu).not.toContainText("Hidden from the board");
  await expect(menu.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings/account");
});

test("a guest sees the create-account card and no security section or forms", async ({ page }) => {
  expect((await page.request.post("/api/guest", { data: {} })).status()).toBe(201);
  await english(page); // after the guest session starts: the page reads the session once, on load
  await page.goto("/#/settings/account");
  const card = page.getByRole("region", { name: "Keep your progress" });
  await expect(card.getByRole("button", { name: "Create account" })).toBeVisible();
  await expect(sectionList(page).getByRole("link")).toHaveText(["Account", "Privacy", "Display & language"]);
  await expect(page.locator(".pw-form, .recovery-section")).toHaveCount(0);
  await card.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("dialog", { name: /create your account/i })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/#/settings/security");
  await expect(page.getByRole("region", { name: "Keep your progress" })).toBeVisible();
  await expect(page.locator(".pw-form, .recovery-section, #settings-pw-current, #settings-recovery-current")).toHaveCount(0);
  await page.goto("/#/settings/privacy");
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.locator(".settings-section")).toContainText("Guests aren't listed on the leaderboard.");
});

test("Display shares its settings with the ⚙ panel, and the language radio keeps focus", async ({ page }) => {
  await english(page);
  await page.goto("/#/settings/display");
  const section = page.locator(".settings-section");
  await section.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Display settings" }).click();
  const panel = page.locator("#settings-panel");
  await expect(panel.getByRole("radio", { name: "Dark" })).toBeChecked();
  await panel.getByRole("radio", { name: "Light" }).check();
  await page.keyboard.press("Escape");
  await expect(section.getByRole("radio", { name: "Light" })).toBeChecked();
  const stored = await page.evaluate(() => localStorage.getItem("il.settings"));
  expect(stored).toContain('"theme":"light"');

  await section.getByRole("radio", { name: "עברית" }).check();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 2, name: "תצוגה ושפה" })).toBeVisible();
  await expect(page.locator(".settings-section").getByRole("radio", { name: "עברית" })).toBeFocused();
});

test("signed out: Display works and Account asks to sign in", async ({ page }) => {
  await english(page);
  await page.goto("/#/settings/display");
  await expect(page.getByRole("heading", { level: 2, name: "Display & language" })).toBeVisible();
  await page.goto("/#/settings/account");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to manage your account" })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
});

test("phones: the sections show as one segmented row", async ({ page }) => {
  await player(page);
  await english(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/settings/privacy");
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(tabs.getByRole("link")).toHaveText(["Account", "Security", "Privacy", "Display"]);
  await expect(tabs.getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".aside-trigger")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  for (const link of await tabs.getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await tabs.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/#\/settings\/security$/);
  await expect(page.getByRole("heading", { level: 2, name: "Security" })).toBeVisible();
});

for (const lang of ["en", "he"] as const) {
  for (const width of [1280, 390]) {
    test(`axe: #/settings sections, ${lang}, ${width}px`, async ({ page }) => {
      test.setTimeout(120_000);
      await player(page);
      await page.goto("/");
      await page.evaluate((l) => localStorage.setItem("il.lang", l), lang);
      await page.setViewportSize({ width, height: 900 });
      const serious: string[] = [];
      for (const s of SECTIONS) {
        await page.goto(`/#/settings/${s.id}`);
        await expect(page.getByRole("heading", { level: 2, name: s[lang] })).toBeVisible();
        await page.waitForLoadState("networkidle");
        serious.push(...(await seriousViolations(page)));
      }
      expect(serious, serious.join("\n")).toEqual([]);
    });
  }
}
