// A tooltip belongs to the page it was opened on (#282): navigating away hides it, so it never covers the next page.
import { expect, test } from "@playwright/test";

const CASE_ID = "ghost-in-the-network";

test("a tooltip open on the Explorer is gone after going to the case page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/case/${CASE_ID}/explorer`);
  const file = page.locator("#ex-files button").first();
  await expect(file).toBeVisible();
  await file.hover();
  const tip = page.locator(".ov-tooltip");
  await expect(tip).toBeVisible();
  await page.evaluate((id) => { window.location.hash = `#/case/${id}`; }, CASE_ID);
  await expect(page.locator("header.case-status, .center-card").first()).toBeVisible();
  await expect(tip).toBeHidden();
});
