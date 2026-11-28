// Case play: focus after every action (solve, hint, reveal, Continue), the bonus losses disclosed before
// a paid action, the answer form's invalid state, and the context kept on finished stages and the debrief.
import { expect, test, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername, scheduleToday } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";
const STAGES = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;

/** Focused element's class list, so a failure says where focus went instead of "false". */
const focusedClass = (page: Page): Promise<string> =>
  page.evaluate(() => (document.activeElement === null ? "none" : `${document.activeElement.tagName}.${document.activeElement.className}`));

test("case play keeps focus, discloses bonus losses and explains finished stages", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const username = randomUsername("play");

  await test.step("approved player signed in", async () => {
    await scheduleToday(request, CASE_ID);
    const reg = await request.post("/api/auth/register", { data: { username, password: PASSWORD } });
    expect(reg.status()).toBe(201);
    await approveAccount(request, username);
    const login = await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } });
    expect(login.status()).toBe(200);
  });

  await test.step("setup states every bonus and cost before Stage 1", async () => {
    await page.goto(`/#/case/${CASE_ID}`);
    const rules = page.locator("details.scoring-rules");
    await expect(rules).toHaveAttribute("open", "");
    await expect(rules).toContainText(/\+50 completion bonus/);
    await expect(rules).toContainText(/ends its \+10 clean bonus/);
    // Both paths are links: the terminal one opens the command list.
    await expect(page.locator(".paths a.path-card")).toHaveCount(2);
    // the browser Explorer leads (#224); the terminal path is second
    await expect(page.locator(".paths a.path-card").first()).toHaveAttribute("href", `#/case/${CASE_ID}/explorer`);
    await expect(page.locator(".paths a.path-card").nth(1)).toHaveAttribute("href", `#/case/${CASE_ID}/toolbox`);
    await page.getByRole("button", { name: /ready/i }).click();
    await expect(page.locator(".answer-form input")).toBeVisible();
    await expect.poll(() => focusedClass(page)).toContain("stage-goal");
  });

  await test.step("a hint asks first, names the clean bonus, then focuses the new hint", async () => {
    const trigger = page.locator(".hint-trigger");
    await expect(trigger).toContainText(/ends the \+10 clean bonus/);
    await trigger.click();
    const prompt = page.getByRole("alertdialog"); // the shared confirm dialog (lib/overlay.ts)
    await expect(prompt).toContainText(/also ends the \+10 clean bonus/);
    await expect(prompt.getByRole("button", { name: /cancel/i })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".hint-trigger")).toBeFocused();
    await page.locator(".hint-trigger").click();
    await page.getByRole("alertdialog").getByRole("button", { name: /^yes, spend/i }).click();
    await expect(page.locator('.hint[data-hint="0"]')).toBeFocused();
  });

  await test.step("a wrong answer marks the field invalid; a right one focuses the result", async () => {
    const input = page.locator(".answer-form input");
    await input.fill("not a time");
    await page.getByRole("button", { name: /check answer/i }).click();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(".feedback")).toContainText(/nothing was charged/i);
    await input.fill("00:00:00");
    await page.getByRole("button", { name: /check answer/i }).click();
    await expect(page.locator(".feedback")).toContainText(/right format, wrong value/i);
    await expect(input).toHaveAttribute("aria-invalid", "true");

    await input.fill(answerFor(CASE_ID, "q1"));
    await page.getByRole("button", { name: /check answer/i }).click();
    await expect(page.locator(".result-title")).toBeFocused();
    // The 0 bonus says why, and the bought hint stays readable.
    await expect(page.locator(".breakdown")).toContainText(/lost: hint, wrong answer/);
    await expect(page.locator(".hints-used .hint")).toHaveCount(1);
  });

  await test.step("Continue focuses the next stage heading", async () => {
    await page.getByRole("button", { name: /continue to stage 2/i }).click();
    await expect.poll(() => focusedClass(page)).toContain("stage-goal");
  });

  await test.step("reveal answer discloses the lost completion bonus, then focuses the result", async () => {
    const trigger = page.locator(".reveal-trigger");
    await expect(trigger).toContainText(/−50 completion bonus/);
    await trigger.click();
    const prompt = page.getByRole("alertdialog");
    await expect(prompt).toContainText(/lose the \+50 completion bonus/);
    await expect(prompt.getByRole("button", { name: /keep trying/i })).toBeFocused();
    await prompt.getByRole("button", { name: /yes, reveal/i }).click();
    await expect(page.locator(".result-title")).toBeFocused();
    await expect(page.locator(".answer-line .btn-copy")).toBeVisible();
  });

  await test.step("debrief shows per-stage costs and where to go next", async () => {
    for (const q of STAGES.slice(2)) {
      const res = await page.request.post(`/api/cases/${CASE_ID}/answer`, { data: { questionId: q, answer: answerFor(CASE_ID, q) } });
      expect(res.status(), await res.text()).toBe(200);
    }
    await page.reload();
    await expect(page.locator(".stage-totals")).toBeVisible();
    const rows = page.locator(".stage-totals tbody tr");
    await expect(rows.nth(0)).toContainText(/1 hint · 1 wrong/);
    await expect(rows.nth(1)).toContainText(/answer revealed/);
    await expect(rows.nth(2)).toContainText(/clean/);
    await expect(page.locator(".debrief-next a[href='#/leaderboard']")).toBeVisible();
    await expect(page.locator(".debrief-next a[href='#/cases']")).toBeVisible();
  });

  await test.step("debrief: the On this page contents jump to a heading and move focus there", async () => {
    const toc = page.locator(".reading .toc");
    await expect(toc).toBeVisible();
    await toc.locator("summary").click();
    const first = toc.locator(".toc-list a").first();
    const target = (await first.getAttribute("href"))?.slice(1) ?? "";
    expect(target).toMatch(/^debrief-/);
    await first.click();
    await expect(page.locator(`[id="${target}"]`)).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#/case/${CASE_ID}`)); // hash routing untouched
  });

  expect(pageErrors, "uncaught page errors").toEqual([]);
});
