// The landing at #/ and the dashboard at #/home (#279): a visitor gets the landing with one primary (Play now);
// signed in, the one primary goes to the dashboard; the nav's Home is the dashboard; the static hero paints the
// same h1 in the same place the app draws it; the landing spends only CDN-cached API reads.
import { expect, test, type Page } from "@playwright/test";
import { approveAccount, randomUsername } from "./support";

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem("il.lang") === null) localStorage.setItem("il.lang", "en");
  });
}

async function signUpPlayer(page: Page): Promise<void> {
  const username = randomUsername("landing");
  const password = "landing-password-1";
  expect((await page.request.post("/api/auth/register", { data: { username, password } })).status()).toBe(201);
  await approveAccount(page.request, username);
  expect((await page.request.post("/api/auth/login", { data: { username, password } })).ok()).toBe(true);
}

test("a visitor on #/ sees the landing: one h1, one primary, every section and the footer", async ({ page }) => {
  await english(page);
  await page.goto("/#/");
  const main = page.locator("#app");
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Debug realistic production outages, from evidence to root cause.");
  await expect(page).toHaveTitle("IncidentLab: real incidents, real evidence, your RCA");
  await expect(page.locator(".app-frame .btn-primary:visible")).toHaveCount(1);
  await expect(page.locator(".lp-hero .btn-primary")).toHaveText("Play now, no sign-up");
  await expect(page.locator(".lp-hero").getByRole("link", { name: "Create account" })).toHaveAttribute("href", "#/signup");
  await expect(page.locator(".lp-hero").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "#/login");
  for (const name of ["How it works", "The cases", "What you'll practise", "For teachers and classes"]) {
    await expect(main.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  // the cases come from the catalog, the start-here case first, each with difficulty, time and stages
  const cards = page.locator(".lp-case:not(.is-skeleton)");
  await expect(cards.first()).toHaveClass(/is-start/);
  await expect(cards.first()).toContainText(/Easy|Medium|Hard/);
  await expect(cards.first()).toContainText(/min/);
  await expect(page.locator(".lp-teach").getByRole("link", { name: "Set up a class" })).toHaveAttribute("href", "#/classes");
  const foot = page.locator(".lp-foot");
  await expect(foot).toContainText("Free · No email · Nothing to install");
  await expect(foot.getByRole("link", { name: "About" })).toHaveAttribute("href", "#/about");
  await expect(foot.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "#/privacy");
  // the landing is no nav item; the logo is the landing for a visitor
  await expect(page.locator(".nav-link[aria-current=page]")).toHaveCount(0);
  await expect(page.locator(".nav-head .logo")).toHaveAttribute("href", "#/");
});

test("the nav's Home goes to the dashboard at #/home", async ({ page }) => {
  await english(page);
  await page.goto("/#/");
  await page.locator("#app-nav").getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator("#app").getByRole("heading", { level: 1 })).toHaveText("Home");
  await expect(page).toHaveTitle("Home · IncidentLab");
  await expect(page.locator(".nav-item-home .nav-link")).toHaveAttribute("aria-current", "page");
  // a visitor's dashboard keeps the Start-here card as its one primary
  await expect(page.locator(".app-frame .btn-primary:visible")).toHaveCount(1);
});

test("signed in, the landing's one primary goes to the dashboard, and Play now is secondary", async ({ page }) => {
  await english(page);
  await signUpPlayer(page);
  await page.goto("/#/");
  const hero = page.locator(".lp-hero");
  await expect(hero.locator(".btn-primary")).toHaveText("Go to your dashboard");
  await expect(page.locator(".app-frame .btn-primary:visible")).toHaveCount(1);
  await expect(hero.getByRole("button", { name: "Play now" })).not.toHaveClass(/btn-primary/);
  await expect(hero.getByRole("link", { name: "Create account" })).toHaveCount(0);
  await expect(page.locator(".nav-head .logo")).toHaveAttribute("href", "#/home");
  await hero.getByRole("link", { name: "Go to your dashboard" }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator("#app").getByRole("heading", { level: 1 })).toHaveText("Home");
  // breadcrumbs name Home as the dashboard
  await page.goto("/#/leaderboard");
  await expect(page.locator("nav.crumbs").getByRole("link", { name: "Home" })).toHaveAttribute("href", "#/home");
});

test("signing in from the form lands on the dashboard", async ({ page }) => {
  await english(page);
  const username = randomUsername("landing");
  const password = "landing-password-1";
  expect((await page.request.post("/api/auth/register", { data: { username, password } })).status()).toBe(201);
  await approveAccount(page.request, username);
  await page.context().clearCookies();
  await page.goto("/#/login");
  await page.locator("#auth-username").fill(username);
  await page.locator("#auth-password").fill(password);
  await page.locator("form.gate button[type=submit]").click();
  await expect(page).toHaveURL(/#\/home$/);
});

test("the static hero is the landing's first paint and the app's hero takes its place without a shift", async ({ browser }) => {
  type Placed = { h1: { x: number; y: number; width: number; height: number } | null; playTop: number | null };
  // Without JavaScript the page stays at its first paint (English, signed out); with it the app has replaced it.
  const measure = async (js: boolean): Promise<Placed> => {
    const context = await browser.newContext({ javaScriptEnabled: js, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto("/");
    const h1 = page.getByRole("heading", { level: 1, name: /debug realistic production outages/i });
    await expect(h1).toBeVisible();
    if (js) await expect(page.locator(".boot-view")).toHaveCount(0); // the app's own hero replaced it
    const placed: Placed = { h1: await h1.boundingBox(), playTop: (await page.locator(".lp-hero .btn-primary:visible").boundingBox())?.y ?? null };
    await context.close();
    return placed;
  };
  const still = await measure(false);
  const live = await measure(true);
  expect(still.h1).not.toBeNull();
  expect(still.playTop).not.toBeNull();
  expect(still).not.toBeNull();
  expect(live).toEqual(still);
});

test("a signed-in visitor's first paint shows the dashboard call to action", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain('class="btn btn-primary btn-lg lp-go" href="#/home"');
  await page.route("**/src/main.ts", (route) => route.abort());
  await page.route("**/assets/index-*.js", (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("il.lang", "en");
    localStorage.setItem("il.signedIn", "1");
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-signed", "");
  await expect(page.locator(".lp-hero .btn-primary:visible")).toHaveText("Go to your dashboard", { useInnerText: true });
  await expect(page.getByRole("link", { name: "Play now, no sign-up" })).toBeHidden();
});

test("the landing spends only CDN-cached public reads", async ({ page }) => {
  await english(page);
  const calls: string[] = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith("/api/") && res.request().method() === "GET") calls.push(`${url.pathname} ${res.headers()["cache-control"] ?? ""}`);
  });
  await page.goto("/#/");
  await expect(page.locator(".lp-case:not(.is-skeleton)").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  // the shell's own session read is personal (no-store) on every route; everything the landing asks for is public
  const landing = calls.filter((c) => !c.startsWith("/api/session ") && !c.startsWith("/api/me "));
  expect(landing.length).toBeGreaterThan(0);
  for (const call of landing) expect(call, call).toMatch(/public/);
});
