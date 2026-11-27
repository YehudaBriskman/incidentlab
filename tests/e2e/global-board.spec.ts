// The opt-in global leaderboard (#175): a player is off the public board until they turn on the switch on
// #/me, and turning it off removes them again.
import { expect, test, type Page } from "@playwright/test";
import { answerFor, approveAccount, randomUsername } from "./support";

const CASE_ID = "3am-outage";

/** An approved player (signed in on `page`) who solved the first stage of CASE_ID. */
async function scoringPlayer(page: Page): Promise<string> {
  const username = randomUsername("e2eglobal");
  const reg = await page.request.post("/api/auth/register", { data: { username, password: "e2e-password-123" } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(page.request, username);
  const c = (path: string): string => `/api/cases/${CASE_ID}${path}`;
  expect((await page.request.get(c("/progress"))).status()).toBe(200);
  expect((await page.request.post(c("/setup-done"), { data: {} })).status()).toBe(200);
  const res = await page.request.post(c("/answer"), { data: { questionId: "q1", answer: answerFor(CASE_ID, "q1") } });
  expect(res.status(), await res.text()).toBe(200);
  return username;
}

const boardRow = (page: Page, username: string) => page.locator(".lb-table tbody tr").filter({ hasText: username });

test("opting in puts you on #/leaderboard, and opting out removes you", async ({ page }) => {
  const username = await scoringPlayer(page);

  await test.step("off by default: not listed, and the page says how to appear", async () => {
    await page.goto("/#/leaderboard");
    const note = page.locator(".lb-optin");
    await expect(note).toContainText("Only players who chose to appear are listed.");
    await expect(note).toContainText("You're hidden from this board.");
    await expect(page.locator(".lb-body")).toHaveAttribute("aria-busy", "false");
    await expect(boardRow(page, username)).toHaveCount(0);
    await page.getByRole("button", { name: /Account:/ }).click();
    await expect(page.getByRole("dialog", { name: "Account" })).toContainText("Hidden from the board");
    await page.keyboard.press("Escape");
    await note.getByRole("link", { name: "Show me on the board" }).click();
    await expect(page).toHaveURL(/#\/me$/);
  });

  const toggle = page.getByRole("switch", { name: "Show me on the global leaderboard" });
  await test.step("turn the switch on: the rank tile and the board follow", async () => {
    await expect(toggle).not.toBeChecked();
    await expect(page.locator(".stat-tile").filter({ hasText: "Global rank" })).toContainText("Not on the board");
    await expect(page.locator("#me-board-note")).toContainText("your username and score are public");
    await toggle.check();
    await expect(page.locator(".toast-host .toast")).toContainText("You're on the global leaderboard.");
    await expect(toggle).toBeChecked();
    await expect(page.locator(".stat-tile").filter({ hasText: "Global rank" })).not.toContainText("Not on the board");
    await page.goto("/#/leaderboard");
    await expect(boardRow(page, username)).toHaveCount(1);
    await expect(boardRow(page, username)).toHaveClass(/is-me/);
    await expect(page.locator(".lb-optin")).not.toContainText("You're hidden");
  });

  await test.step("turn it off: gone from the board", async () => {
    await page.goto("/#/me");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator(".toast-host .toast").last()).toContainText("You're hidden from the global leaderboard.");
    await page.goto("/#/leaderboard");
    await expect(page.locator(".lb-body")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".lb-optin")).toContainText("You're hidden from this board.");
    await expect(boardRow(page, username)).toHaveCount(0);
  });
});

test("the switch keeps working in Hebrew (RTL)", async ({ page }) => {
  await scoringPlayer(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("il.lang", "he"));
  await page.goto("/#/me");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const toggle = page.getByRole("switch", { name: "הציגו אותי בטבלת המובילים העולמית" });
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.locator(".toast-host .toast")).toContainText("אתם מופיעים בטבלת המובילים העולמית.");
});
