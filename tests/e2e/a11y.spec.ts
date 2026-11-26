// Automated accessibility scan (axe-core, WCAG 2.2 AA rules) of every main page: signed out, as a player and
// as the instructor, in English and Hebrew, light and dark. It is the automatable part of #135; the manual
// screen-reader and 200% zoom pass still needs a person. Serious and critical violations fail the test;
// anything else is attached to the report.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, approveAccount, randomUsername } from "./support";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const CASE = "ghost-in-the-network";

type Who = "visitor" | "player" | "admin";
const PAGES: Record<Who, readonly string[]> = {
  visitor: ["/#/", "/#/login", "/#/signup", "/#/leaderboard", `/#/case/${CASE}`, `/#/case/${CASE}/explorer`],
  player: ["/#/", `/#/case/${CASE}`, `/#/case/${CASE}/toolbox`, `/#/case/${CASE}/explorer`, "/#/me", "/#/leaderboard"],
  admin: ["/#/admin", "/#/admin?tab=live", "/#/admin?tab=stats", "/#/admin?tab=event", "/#/admin?tab=schedule", "/#/admin?tab=audit", `/#/case/${CASE}`, `/#/case/${CASE}/present`],
};

async function signIn(page: Page, who: Who): Promise<void> {
  if (who === "visitor") return;
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

async function toHebrew(page: Page): Promise<void> {
  const he = page.locator("button.lang-btn[lang=he]:visible").first();
  if ((await he.count()) > 0 && (await he.getAttribute("aria-pressed")) !== "true") await he.click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["en", "he"] as const) {
    for (const who of ["visitor", "player", "admin"] as const) {
      test(`axe: ${who}, ${lang}, ${scheme}`, async ({ browser }, testInfo) => {
        test.setTimeout(120_000);
        const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        await signIn(page, who);
        const serious: string[] = [];
        for (const [i, path] of PAGES[who].entries()) {
          await page.goto(path);
          if (i === 0 && lang === "he") await toHebrew(page);
          await page.waitForLoadState("networkidle");
          await page.waitForTimeout(400); // let the first render settle (fonts, lazy views)
          const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          for (const v of results.violations) {
            const line = `${path} [${v.impact ?? "?"}] ${v.id}: ${v.help} (${v.nodes.length}×) e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`;
            if (v.impact === "serious" || v.impact === "critical") serious.push(line);
            else await testInfo.attach(`${v.id} ${path}`, { body: line, contentType: "text/plain" });
          }
        }
        await context.close();
        expect(serious, serious.join("\n")).toEqual([]);
      });
    }
  }
}
