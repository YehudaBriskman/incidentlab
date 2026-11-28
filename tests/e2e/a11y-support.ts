// Shared helpers for the axe accessibility scans (*-a11y.spec.ts, one file per role so CI shards balance).
// Automated accessibility scan (axe-core, WCAG 2.2 AA rules) of every main page: signed out, as a player and
// as the instructor, in English and Hebrew, light and dark, on a desktop (1280) and a phone (390, touch). It is the
// automatable part of #135; the manual screen-reader and 200% zoom pass still needs a person. Moderate, serious and
// critical violations fail the test (#249), best-practice rules included (one h1, heading order, unique landmarks);
// minor ones are attached to the report.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, approveAccount, randomUsername } from "./support";

export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** The page scans add axe's best-practice rules: the outline and landmark checks live there. */
const SCAN_TAGS = [...TAGS, "best-practice"];
const FAILING = new Set(["moderate", "serious", "critical"]);
/** A desktop, and a phone with a coarse pointer (the 44px touch sizes and the stacked tables apply there). */
export const WIDTHS = [1280, 390] as const;
export type Width = (typeof WIDTHS)[number];
const CASE = "ghost-in-the-network";

export type Who = "visitor" | "guest" | "player" | "admin";
// The class pages (#182): `:class` and `:board` become the id and board token of a class the signed-in player (or
// the site admin) creates before the scan.
export const PAGES: Record<Who, readonly string[]> = {
  visitor: ["/#/", "/#/cases", "/#/login", "/#/signup", "/#/leaderboard", `/#/case/${CASE}`, `/#/case/${CASE}/explorer`, "/#/classes", "/#/join/ABCDE-FGHJK"],
  // a guest (#176) sees the guest banner on every page, and the account menu says "Guest"
  guest: ["/#/", `/#/case/${CASE}`, `/#/case/${CASE}/toolbox`, "/#/me", "/#/classes"],
  player: [
    "/#/",
    `/#/case/${CASE}`,
    `/#/case/${CASE}/toolbox`,
    `/#/case/${CASE}/explorer`,
    "/#/me",
    "/#/leaderboard",
    "/#/classes",
    "/#/class/:class",
    "/#/class/:class/manage?tab=members",
    "/#/class/:class/manage?tab=live",
    "/#/class/:class/manage?tab=settings",
    "/#/classboard/:board?projector=1",
  ],
  admin: [
    "/#/admin",
    "/#/author",
    "/#/admin/reviews",
    "/#/admin?tab=classes",
    "/#/admin?tab=live",
    "/#/admin?tab=stats",
    "/#/admin?tab=event",
    "/#/admin?tab=schedule",
    "/#/admin?tab=audit",
    `/#/case/${CASE}`,
    `/#/case/${CASE}/present`,
    "/#/classes",
    "/#/class/:class/manage?tab=cases",
    "/#/class/:class/manage?tab=schedule",
    "/#/class/:class/manage?tab=event",
  ],
};

/** Creates a class for the signed-in player or admin (the class pages need one). */
async function classFor(page: Page): Promise<{ id: string; board: string }> {
  const res = await page.request.post("/api/classes", { data: { name: "A11y class" } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { class: { id: string; boardToken?: string } };
  return { id: body.class.id, board: body.class.boardToken ?? "" };
}

export async function signIn(page: Page, who: Who): Promise<void> {
  if (who === "visitor") return;
  if (who === "guest") {
    expect((await page.request.post("/api/guest", { data: {} })).status()).toBe(201);
    return;
  }
  if (who === "admin") {
    const res = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
    expect(res.ok()).toBe(true);
    return;
  }
  const username = randomUsername("a11y");
  const password = "a11y-password-1";
  expect((await page.request.post("/api/auth/register", { data: { username, password } })).status()).toBe(201);
  await approveAccount(page.request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password } })).ok()).toBe(true);
}

/** Switches to Hebrew through the account menu (#220: the language radios live there), then closes it. */
export async function toHebrew(page: Page): Promise<void> {
  if ((await page.locator("html").getAttribute("lang")) !== "he") {
    const menu = page.locator(".account-btn:visible").first();
    if ((await menu.count()) > 0) {
      await menu.click();
      await page.locator(".account-panel").getByRole("radio", { name: "עברית" }).check();
      await page.keyboard.press("Escape");
    } else {
      // no visible account button (a narrow layout): choose Hebrew the way the radios store it
      await page.evaluate(() => window.localStorage.setItem("il.lang", "he"));
      await page.reload();
    }
  }
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

/**
 * The body of one scan: every page of `who` in one language and colour scheme. Each *-a11y.spec.ts declares its
 * own tests with it, so CI's shards (which group tests by the file that declares them) spread the scans out.
 */
export function axeScan(who: Who, lang: "en" | "he", scheme: "light" | "dark", width: Width = 1280) {
  return async ({ browser }: { browser: Browser }, testInfo: TestInfo): Promise<void> => {
    test.setTimeout(120_000);
    const phone = width < 600;
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width, height: phone ? 844 : 900 },
      ...(phone ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    await signIn(page, who);
    const needsClass = PAGES[who].some((p) => p.includes(":class") || p.includes(":board"));
    const cls = needsClass ? await classFor(page) : null;
    const failing: string[] = [];
    for (const [i, template] of PAGES[who].entries()) {
      const path = cls === null ? template : template.replace(":class", cls.id).replace(":board", encodeURIComponent(cls.board));
      await page.goto(path);
      if (i === 0 && lang === "he") await toHebrew(page);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400); // let the first render settle (fonts, lazy views)
      const results = await new AxeBuilder({ page }).withTags(SCAN_TAGS).analyze();
      for (const v of results.violations) {
        const line = `${width}px ${path} [${v.impact ?? "?"}] ${v.id}: ${v.help} (${v.nodes.length}×) e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`;
        if (FAILING.has(v.impact ?? "")) failing.push(line);
        else await testInfo.attach(`${v.id} ${path}`, { body: line, contentType: "text/plain" });
      }
    }
    await context.close();
    expect(failing, failing.join("\n")).toEqual([]);
  };
}
