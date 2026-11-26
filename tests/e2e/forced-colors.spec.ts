// Forced colours (Windows High Contrast) erase fills: the one primary action and the Explorer cursor line
// must keep a cue of their own (#130).
import { expect, test } from "@playwright/test";

test.use({ forcedColors: "active" });

test("the primary button stands out from secondary buttons in forced colours", async ({ page }) => {
  await page.goto("/#/login");
  const primary = page.locator(".btn-primary").first();
  await expect(primary).toBeVisible();
  const bg = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
  const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg, "primary is filled with the text colour, not the canvas").not.toBe(canvas);
});

test("the Explorer cursor line is a system highlight in forced colours", async ({ page }) => {
  await page.goto("/#/case/ghost-in-the-network/explorer");
  await page.getByText("README_FIRST.txt").first().click();
  await page.locator(".ex-row").nth(2).click();
  const cursor = page.locator(".ex-row.is-cursor").first();
  await expect(cursor).toBeVisible();
  await expect.poll(() => cursor.evaluate((el) => getComputedStyle(el).forcedColorAdjust)).toBe("none");
  const box = await cursor.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(box).toBe("none");
});
