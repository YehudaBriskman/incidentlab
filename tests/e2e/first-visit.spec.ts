// The first visit (#223, #224, #225): the static hero is in index.html before any script runs; home has one
// primary action, "Play now, no sign-up", which starts a guest and lands in the start-here case; the case gate leads
// with play and never opens the phone keyboard; About and Privacy are real pages in both languages.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Summary = { id: string; title: string; difficulty: "easy" | "medium" | "hard"; estMinutes: number; tags: string[] };

/** English unless the test has switched the language itself. */
async function english(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem("il.lang") === null) localStorage.setItem("il.lang", "en");
  });
}

/** The start-here rule (site/src/lib/startHere.ts) over the live catalog: a `tutorial` case, else easiest, then shortest. */
async function startHereId(request: APIRequestContext): Promise<string> {
  const cases = ((await (await request.get("/api/cases")).json()) as { cases: { en: Summary }[] }).cases.map((c) => c.en);
  const released = ((await (await request.get("/api/today")).json()) as { releasedCaseIds: string[] }).releasedCaseIds;
  const playable = cases.filter((c) => released.includes(c.id));
  const tutorials = playable.filter((c) => c.tags.some((t) => t.toLowerCase() === "tutorial"));
  const rank = { easy: 0, medium: 1, hard: 2 } as const;
  const [first] = (tutorials.length > 0 ? tutorials : playable).sort(
    (a, b) => rank[a.difficulty] - rank[b.difficulty] || a.estMinutes - b.estMinutes || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
  if (first === undefined) throw new Error("no released case");
  return first.id;
}

test("index.html has the static hero with an h1 before any script runs", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = await res.text();
  const app = html.slice(html.indexOf('id="app"'));
  expect(app).toMatch(/<h1 class="home-intro-title">/);
  expect(app).toContain("Debug realistic production outages, from evidence to root cause.");
  expect(app).toContain('href="#/play"');
  expect(app).toContain("Free · No email · Nothing to install");
  expect(html).toContain('<link rel="canonical" href="https://incidentlab-3am-outage.netlify.app/" />');
  expect(html).toContain('<meta property="og:url" content="https://incidentlab-3am-outage.netlify.app/" />');
});

test("without JavaScript the hero still shows, with its call to action", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /debug realistic production outages/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Play now, no sign-up" })).toBeVisible();
  await context.close();
});

test("home has one primary button, and Play now lands a new visitor in the start-here case as a guest", async ({ page, request }) => {
  await english(page);
  const target = await startHereId(request);
  await page.goto("/#/");
  const intro = page.getByRole("region", { name: "About IncidentLab" });
  await expect(intro.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Start here" })).toBeVisible();
  // one primary per view (#223): the top bar's Sign in is secondary
  await expect(page.locator(".app-frame .btn-primary:visible")).toHaveCount(1);
  await expect(intro.locator(".btn-primary")).toHaveText("Play now, no sign-up");
  await expect(intro).toContainText("Free · No email · Nothing to install");
  await expect(page.locator(".home-proof")).toContainText(/\d+ cases?/);

  await intro.getByRole("button", { name: "Play now, no sign-up" }).click();
  await expect(page).toHaveURL(new RegExp(`#/case/${target}`));
  await expect(page.getByRole("button", { name: /ready/i })).toBeVisible();
  await page.locator(".account-btn").click();
  await expect(page.locator(".account-name")).toHaveText("Guest");
});

test("at 360px the intro's buttons stack and no label wraps", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto("/#/");
  const buttons = page.locator(".home-intro-actions .btn");
  await expect(buttons).toHaveCount(2);
  for (const button of await buttons.all()) {
    const lines = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.round(range.getBoundingClientRect().height / Number.parseFloat(style.lineHeight || "20"));
    });
    expect(lines).toBeLessThanOrEqual(1);
  }
  // the h1, the value line and Play now are all in the first screen
  const play = await page.getByRole("button", { name: "Play now, no sign-up" }).boundingBox();
  expect(play).not.toBeNull();
  expect((play?.y ?? 999) + (play?.height ?? 0)).toBeLessThanOrEqual(640);
  await context.close();
});

test("the #/play address starts a guest and opens the start-here case", async ({ page, request }) => {
  await english(page);
  const target = await startHereId(request);
  await page.goto("/#/play");
  await expect(page).toHaveURL(new RegExp(`#/case/${target}`));
  await expect(page.getByRole("button", { name: /ready/i })).toBeVisible();
});

test("the case gate leads with play and doesn't open the keyboard on a phone", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto("/#/case/3am-outage");
  const choice = page.locator(".guest-choice");
  await expect(choice.getByRole("heading", { level: 1, name: "Play this case now" })).toBeVisible();
  await expect(choice.locator(".btn-primary")).toHaveText("Play now, no sign-up");
  await expect(page.locator("form.gate").getByRole("heading", { level: 2, name: "Already have an account? Sign in" })).toBeVisible();
  // the sign-in submit is secondary, and nothing takes focus into the form
  await expect(page.locator("form.gate button[type=submit]")).not.toHaveClass(/btn-primary/);
  await expect(page.locator("#auth-username")).not.toBeFocused();
  // the guest choice sits above the form
  const choiceBox = await choice.boundingBox();
  const formBox = await page.locator("form.gate").boundingBox();
  expect((choiceBox?.y ?? 0) < (formBox?.y ?? 0)).toBe(true);
  await context.close();
});

test("Stage 0 leads with the browser Explorer; the zip is the second path", async ({ page }) => {
  await english(page);
  await page.goto("/#/case/3am-outage");
  await page.locator(".guest-choice").getByRole("button", { name: /play now/i }).click();
  const top = page.locator(".setup-top");
  await expect(top.getByRole("link", { name: "Open the Evidence Explorer" })).toHaveAttribute("href", "#/case/3am-outage/explorer");
  await expect(top.getByRole("link", { name: /download the evidence/i })).toHaveAttribute("download", "");
  await expect(page.locator(".paths a.path-card").first()).toHaveAttribute("href", "#/case/3am-outage/explorer");
});

test("About and Privacy are pages in English and Hebrew, linked from the nav", async ({ page }) => {
  await english(page);
  await page.goto("/#/");
  await page.locator(".nav-foot").getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/#\/about$/);
  await expect(page.getByRole("heading", { level: 1, name: "About IncidentLab" })).toBeVisible();
  await expect(page).toHaveTitle("About IncidentLab · IncidentLab");
  await expect(page.getByRole("heading", { level: 2, name: "What you'll practise" })).toBeVisible();
  await expect(page.locator("nav.crumbs")).toContainText("About");

  await page.locator(".nav-foot").getByRole("link", { name: "Privacy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
  const body = page.locator(".info-page");
  await expect(body).toContainText("a hash of your password");
  await expect(body).toContainText("No email address");
  await expect(body).toContainText("after 30 days without play");
  await expect(body).toContainText("Your recovery code, hashed");

  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "פרטיות" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".info-page")).toContainText("אחרי 30 יום בלי משחק");
  await page.goto("/#/about");
  await expect(page.getByRole("heading", { level: 1, name: "אודות IncidentLab" })).toBeVisible();
});
