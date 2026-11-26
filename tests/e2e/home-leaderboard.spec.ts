// #35 regressions: the projector shows no chrome until the pointer moves, and the header's live strip draws a
// remembered event at first paint instead of shifting the page when /api/event answers.
import { expect, test } from "@playwright/test";
import { adminHeaders } from "./support";

test("projector: the exit link stays hidden until the pointer moves, and Escape still leaves", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/#/leaderboard?projector=1");
  const exit = page.locator(".lb-exit");
  await expect(exit).toHaveCSS("opacity", "0");
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(exit).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/projector=1/);
});

test("live strip: a reload draws the remembered announcement before /api/event answers", async ({ page, request }) => {
  const before = await request.get("/api/admin/event", { headers: adminHeaders });
  expect(before.status()).toBe(200);
  const original = ((await before.json()) as { event: unknown }).event;
  const text = `e2e announcement ${Date.now()}`;
  const put = await request.put("/api/admin/event", {
    headers: adminHeaders,
    data: { name: "", startsAt: null, endsAt: null, freezeAt: null, enforceWindow: false, announcement: { text, level: "info" } },
  });
  expect(put.status(), await put.text()).toBe(200);
  try {
    await page.goto("/#/");
    await expect(page.locator(".announce .banner-text-body")).toHaveText(text); // first load: fetched, then remembered

    // Hold /api/event for 3 s: the banner must already be there from the snapshot.
    await page.route("**/api/event", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.reload();
    await expect(page.locator(".announce .banner-text-body")).toHaveText(text, { timeout: 1500 });
  } finally {
    await request.put("/api/admin/event", { headers: adminHeaders, data: original });
  }
});

test("My stats: every detail label sits above its own value (pairs never split across rows)", async ({ page, request }) => {
  const { approveAccount, randomUsername } = await import("./support");
  const username = randomUsername("e2epairs");
  const reg = await page.request.post("/api/auth/register", { data: { username, password: "e2e-password-123" } });
  expect(reg.status(), await reg.text()).toBe(201);
  await approveAccount(request, username);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/me");
    await expect(page.locator(".detail-list dt").first()).toBeVisible();
    const split = await page.evaluate(() =>
      [...document.querySelectorAll(".detail-list dt")]
        .filter((dt) => {
          const dd = dt.nextElementSibling;
          if (!(dd instanceof HTMLElement) || dd.tagName !== "DD") return true;
          const a = dt.getBoundingClientRect();
          const b = dd.getBoundingClientRect();
          return Math.abs(a.left - b.left) > 2 || b.top < a.top;
        })
        .map((dt) => dt.textContent),
    );
    expect(split, `${width}px`).toEqual([]);
  }
});
