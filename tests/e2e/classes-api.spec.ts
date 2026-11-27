// Classes API (#179) end to end through Playwright's request fixture: create, join by code, approval, members.
// No class UI yet (#182), so nothing here touches a page.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUsername } from "./support";

const PASSWORD = "e2e-password-123";

type ClassBody = {
  class: {
    id: string;
    name: string;
    membership: { role: string; status: string; isOwner: boolean } | null;
    boardToken?: string;
    admin?: { joinCode: string; joinMode: string; memberLimit: number };
  };
};

/** A signed-in player in its own cookie jar. */
async function player(playwright: { request: { newContext(o: { baseURL?: string }): Promise<APIRequestContext> } }, baseURL: string | undefined, prefix: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/register", { data: { username: randomUsername(prefix), password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { account: { id: string; username: string } };
  return { ctx, ...body.account };
}

test("create a class, join by code, request to join with approval, and approve", async ({ playwright, baseURL }) => {
  const owner = await player(playwright, baseURL, "e2eown");
  const member = await player(playwright, baseURL, "e2emem");
  const asker = await player(playwright, baseURL, "e2eask");
  const outsider = await player(playwright, baseURL, "e2eout");

  const created = await owner.ctx.post("/api/classes", { data: { name: "E2E class" } });
  expect(created.status(), await created.text()).toBe(201);
  expect(created.headers()["cache-control"]).toBe("no-store");
  const cls = ((await created.json()) as ClassBody).class;
  expect(cls.membership).toEqual({ role: "admin", status: "active", isOwner: true });
  const code = cls.admin?.joinCode ?? "";
  expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  const joined = await member.ctx.post("/api/classes/join", { data: { code: code.toLowerCase() } });
  expect(joined.status(), await joined.text()).toBe(200);
  expect(((await joined.json()) as ClassBody).class.membership?.status).toBe("active");
  const asMember = (await (await member.ctx.get(`/api/classes/${cls.id}`)).json()) as ClassBody;
  expect(asMember.class.boardToken).toBe(cls.boardToken);
  expect(asMember.class.admin).toBeUndefined();

  expect((await outsider.ctx.get(`/api/classes/${cls.id}`)).status()).toBe(404);
  expect((await outsider.ctx.post("/api/classes/join", { data: { code: "WRONG-CODE2" } })).status()).toBe(404);

  const patched = await owner.ctx.patch(`/api/classes/${cls.id}`, { data: { joinMode: "approval" } });
  expect(patched.status(), await patched.text()).toBe(200);
  const asked = await asker.ctx.post("/api/classes/join", { data: { code } });
  expect(((await asked.json()) as ClassBody).class.membership?.status).toBe("pending");
  expect((await asker.ctx.get(`/api/classes/${cls.id}/members`)).status()).toBe(403);

  const approved = await owner.ctx.post(`/api/classes/${cls.id}/members/${asker.id}/approve`, { data: {} });
  expect(approved.status(), await approved.text()).toBe(200);
  const members = (await (await owner.ctx.get(`/api/classes/${cls.id}/members`)).json()) as { members: Array<{ username: string; status: string }> };
  expect(members.members.map((m) => m.username).sort()).toEqual([owner.username, member.username, asker.username].sort());
  expect(members.members.every((m) => m.status === "active")).toBe(true);

  const mine = (await (await asker.ctx.get("/api/classes")).json()) as { classes: Array<{ id: string }> };
  expect(mine.classes.map((c) => c.id)).toContain(cls.id);

  for (const p of [owner, member, asker, outsider]) await p.ctx.dispose();
});
