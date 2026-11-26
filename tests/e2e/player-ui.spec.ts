// Player UI locks: 44px touch targets on coarse pointers (#126) and the skip link hidden at 200% text (#136).
import { expect, test, type Page } from "@playwright/test";
import { approveAccount, randomUsername } from "./support";

const CASE_ID = "who-deleted-prod";
const PASSWORD = "e2e-password-123";

async function signedInPlayer(page: Page, prefix: string): Promise<string> {
  const username = randomUsername(prefix);
  const reg = await page.request.post("/api/auth/register", { data: { username, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(page.request, username);
  const login = await page.request.post("/api/auth/login", { data: { username, password: PASSWORD } });
  expect(login.status()).toBe(200);
  return username;
}

test.describe("phone with touch (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("case page: small buttons are 44px tall on a coarse pointer", async ({ page }) => {
    await signedInPlayer(page, "touch");
    await page.goto(`/#/case/${CASE_ID}`);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const allCommands = page.locator(".case-head-title a.btn-sm");
    await expect(allCommands).toBeVisible();
    const box = await allCommands.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

test("skip link stays off screen at 200% text and shows on focus", async ({ page }) => {
  await page.goto("/#/");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const skip = page.locator(".skip-link");
  const hidden = await skip.boundingBox();
  expect((hidden?.y ?? 0) + (hidden?.height ?? 0)).toBeLessThanOrEqual(0);
  await skip.focus();
  const shown = await skip.boundingBox();
  expect(shown?.y ?? -1).toBeGreaterThanOrEqual(0);
});
