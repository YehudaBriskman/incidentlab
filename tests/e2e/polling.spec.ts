// The event poll is the site's biggest source of function calls (issue #140): it must stop while the tab is
// hidden, catch up once when the tab comes back, and slow down when no event is live.
import { expect, test, type Page } from "@playwright/test";

const IDLE_POLL_MS = 120_000; // EVENT_POLL_IDLE_MS in site/src/lib/clock.ts

const setHidden = (page: Page, hidden: boolean): Promise<void> =>
  page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

test("the event poll pauses in a hidden tab, catches up on return and idles at 2 minutes", async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/event") calls += 1;
  });
  await page.goto("/");
  await expect.poll(() => calls).toBe(1); // the first poll, on load

  // No event is set on a fresh server, so the next poll is the idle one, two minutes later.
  await page.clock.runFor(IDLE_POLL_MS + 1_000);
  await expect.poll(() => calls).toBe(2);

  // Hidden: ten minutes pass without a single request.
  await setHidden(page, true);
  await page.clock.runFor(10 * 60_000);
  expect(calls).toBe(2);

  // Back: one request at once, then the normal cadence again.
  await setHidden(page, false);
  await expect.poll(() => calls).toBe(3);
  await page.clock.runFor(IDLE_POLL_MS + 1_000);
  await expect.poll(() => calls).toBe(4);
});
