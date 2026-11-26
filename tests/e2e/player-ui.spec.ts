// Player UI locks: 44px touch targets on coarse pointers (#126).
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
