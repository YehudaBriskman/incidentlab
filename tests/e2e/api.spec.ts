// API-only checks through Playwright's request fixture (no browser).
import { expect, test } from "@playwright/test";
import { randomUsername } from "./support";

test.describe("public API contract", () => {
  test("reserved usernames cannot register (409)", async ({ request }) => {
    const res = await request.post("/api/auth/register", { data: { username: "admin", password: "e2e-password-123" } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ code: "reserved" });
  });

  test("a fresh username registers approved, with a one-time recovery code (201)", async ({ request }) => {
    const res = await request.post("/api/auth/register", { data: { username: randomUsername("e2eapi"), password: "e2e-password-123" } });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { account: { status: string }; recoveryCode: string };
    expect(body.account.status).toBe("approved");
    expect(body.recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(JSON.stringify(body)).not.toMatch(/scrypt|Hash/);
  });

  test("leaderboard is public (200)", async ({ request }) => {
    const res = await request.get("/api/leaderboard");
    expect(res.status()).toBe(200);
  });

  test("admin endpoints need auth (401)", async ({ playwright, baseURL }) => {
    // A fresh context: no cookies left over from the registration above.
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.get("/api/admin/accounts");
    expect(res.status()).toBe(401);
    await anon.dispose();
  });
});
