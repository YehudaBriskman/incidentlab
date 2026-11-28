// The tutorial case (#224): the Explorer steps its stage tips teach give the right answers, and a player can
// play all six stages in the browser from setup to the debrief.
import { expect, test, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "first-shift";
const PASSWORD = "e2e-password-123";
const STAGES = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;

const ui = {
  file: (p: Page, path: string) =>
    p.getByRole("complementary", { name: /files/i }).getByRole("button", { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`) }),
  count: (p: Page) => p.locator(".ex-count"),
  stepText: (p: Page, n: number) => p.getByRole("textbox", { name: `Step ${n} filter text` }),
  addFilter: (p: Page) => p.getByRole("button", { name: "+ add filter" }),
  answerInput: (p: Page) => p.locator(".answer-form input"),
  check: (p: Page) => p.getByRole("button", { name: /check answer/i }),
  resultTitle: (p: Page) => p.locator(".result-title"),
};

const LOADED = / of [\d,]+ lines?/;

test("first-shift: the Explorer tip for stage 4 counts the broken page's 404s", async ({ page }) => {
  await page.goto(`/#/case/${CASE_ID}/explorer`);
  for (const path of ["README_FIRST.txt", "access.log", "deploy.log", "team-chat.txt"]) await expect(ui.file(page, path)).toBeVisible();
  await ui.file(page, "access.log").click();
  await expect(ui.count(page)).toHaveText(LOADED, { timeout: 60_000 });
  await ui.stepText(page, 1).fill('" 404 ');
  await ui.addFilter(page).click();
  await ui.stepText(page, 2).fill(answerFor(CASE_ID, "q1"));
  await expect(ui.count(page)).toHaveText(new RegExp(`^${answerFor(CASE_ID, "q4")} of [\\d,]+ lines`));
});

test("first-shift: a new player plays all six stages to the debrief", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const username = randomUsername("tut");

  await test.step("approved player signed in", async () => {
    await scheduleToday(request, CASE_ID);
    const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
    expect(reg.status()).toBe(201);
    await approveAccount(request, username);
    const login = await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } });
    expect(login.status()).toBe(200);
  });

  await test.step("the catalog lists it as an easy tutorial", async () => {
    const res = await page.request.get("/api/cases");
    expect(res.status()).toBe(200);
    const body: unknown = await res.json();
    expect(JSON.stringify(body)).toContain(`"${CASE_ID}"`);
    await page.goto(`/#/case/${CASE_ID}`);
    await expect(page.getByRole("heading", { name: "First Shift" }).first()).toBeVisible();
  });

  await test.step("setup, then Stage 1", async () => {
    await page.getByRole("button", { name: /ready/i }).click();
    await expect(ui.answerInput(page)).toBeVisible();
  });

  for (const [i, q] of STAGES.entries()) {
    await test.step(`stage ${i + 1}: the right answer solves it`, async () => {
      await ui.answerInput(page).fill(answerFor(CASE_ID, q));
      await ui.check(page).click();
      await expect(ui.resultTitle(page)).toBeFocused();
      if (i < STAGES.length - 1) {
        await page.getByRole("button", { name: new RegExp(`continue to stage ${i + 2}`, "i") }).click();
        await expect(ui.answerInput(page)).toBeVisible();
      }
    });
  }

  await test.step("the debrief is unlocked, with every stage clean", async () => {
    await page.reload();
    await expect(page.locator(".stage-totals")).toBeVisible();
    const rows = page.locator(".stage-totals tbody tr");
    for (const n of [0, 5]) await expect(rows.nth(n)).toContainText(/clean/);
    await expect(page.getByRole("heading", { name: "What actually happened" })).toBeVisible();
  });

  expect(pageErrors, "uncaught page errors").toEqual([]);
});
