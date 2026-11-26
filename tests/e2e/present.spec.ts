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

test("presentation mode is for the instructor only", async ({ page }) => {
  await page.goto(`/#/case/${CASE}/present`);
  await expect(page).toHaveURL(new RegExp(`#/case/${CASE}$`));
});
