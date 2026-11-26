// The instructor's case preview and presentation mode (views/present.ts): public content only, slides move with
// the buttons and arrow keys, and the live board / back links point at the right places.
import { expect, test } from "@playwright/test";
import { ADMIN_KEY, ADMIN_USERNAME, answerFor } from "./support";

const CASE = "3am-outage";

test("instructor previews a case and presents it without leaking answers", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.ok()).toBe(true);

  await page.goto(`/#/case/${CASE}`);
  const present = page.getByRole("link", { name: "Present to class" }).first();
  await expect(present).toBeVisible();
  await expect(page.getByRole("heading", { name: "The story" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Live leaderboard" }).first()).toHaveAttribute("href", `#/leaderboard?case=${CASE}&projector=1`);
  // short numeric answers ("9") would match any text; the distinctive ones prove nothing sealed is shown
  const answers = ["q1", "q2", "q3", "q4", "q5", "q6"].map((q) => answerFor(CASE, q)).filter((a) => a.length >= 4);
  expect(answers.length).toBeGreaterThan(2);
  const previewText = (await page.locator("#app").innerText()).toLowerCase();
  for (const a of answers) expect(previewText.includes(a.toLowerCase()), `preview leaks ${a}`).toBe(false);

  await present.click();
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE}/present$`));
  await expect(page.locator(".slide-pos")).toHaveText(/^1 of \d+$/);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide-pos")).toHaveText(/^2 of \d+$/);
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator(".slide-pos")).toHaveText(/^1 of \d+$/);
  await page.keyboard.press("End");
  const deckText = (await page.locator(".slide").innerText()).toLowerCase();
  for (const a of answers) expect(deckText.includes(a.toLowerCase()), `slides leak ${a}`).toBe(false);

  await page.getByRole("link", { name: "Back to case preview" }).click();
  await expect(page.getByRole("link", { name: "Present to class" }).first()).toBeVisible();
});

test("presentation keys: arrows move slides, the long body scrolls inside, controls stay on screen, Esc exits", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const login = await page.request.post("/api/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_KEY } });
  expect(login.ok()).toBe(true);
  await page.goto(`/#/case/${CASE}/present`);
  const pos = page.locator(".slide-pos");
  await expect(pos).toHaveText(/^1 of \d+$/);
  // the evidence slide is long: it scrolls inside the slide, never the page
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(pos).toHaveText(/^4 of \d+$/);
  const body = page.locator(".slide-body");
  await expect.poll(() => body.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(0);
  await page.keyboard.press("PageDown");
  await expect.poll(() => body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  const pageScroll = await page.locator("main.app-content").evaluate((e) => e.scrollHeight - e.clientHeight);
  expect(pageScroll).toBe(0);
  await expect(page.getByRole("button", { name: "Next" })).toBeInViewport();
  await expect(page.getByRole("link", { name: "Live leaderboard" })).toBeInViewport();
  // ArrowDown scrolls, it does not change slides; ArrowLeft goes back one
  await page.keyboard.press("ArrowDown");
  await expect(pos).toHaveText(/^4 of \d+$/);
  await page.keyboard.press("ArrowLeft");
  await expect(pos).toHaveText(/^3 of \d+$/);
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE}$`));
});

test("presentation mode is for the instructor only", async ({ page }) => {
  await page.goto(`/#/case/${CASE}/present`);
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE}$`));
});
