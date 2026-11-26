// Player UI locks: 44px touch targets on coarse pointers (#126), no home layout shift at 390px (#124) and the
// skip link hidden at 200% text (#136).
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

  test("home, signed out: cumulative layout shift stays under 0.1 while the API is slow", async ({ page }) => {
    // Production answers in about a second; the local server in a few milliseconds. Hold every API call back so
    // the late answers (who is signed in, today's case, the catalog) land after the first paint, as they do there.
    await page.route("**/api/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) w.__cls += shift.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/#/");
    await expect(page.locator(".home-intro")).toBeVisible();
    await expect(page.locator(".home-today[aria-busy]")).toHaveCount(0);
    await page.waitForTimeout(500); // let the last answer's redraw settle
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls).toBeLessThan(0.1);
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
