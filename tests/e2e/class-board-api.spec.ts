// Class boards (#181) and class scoring windows (#180) end to end through Playwright's request fixture: a class,
// two members who solve, the public class board (no cookie), the freeze, token rotation and live progress.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { answerFor, randomUsername } from "./support";

const PASSWORD = "e2e-password-123";
const CASE_ID = "3am-outage";

type ClassBody = { class: { id: string; boardToken?: string; admin?: { joinCode: string } } };
type BoardBody = {
  caseId: string | null;
  frozen: boolean;
  frozenAt: string | null;
  classId: string;
  className: string;
  event: { name: string };
  entries: Array<{ username: string; score: number; stagesSolved: number; firstBloods: number }>;
};
type ProgressBody = { players: Array<{ username: string; stages: Record<string, { status: string }> }> };

async function player(playwright: { request: { newContext(o: { baseURL?: string }): Promise<APIRequestContext> } }, baseURL: string | undefined, prefix: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/register", { data: { username: randomUsername(prefix), password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { account: { id: string; username: string } };
  return { ctx, ...body.account };
}

async function solve(ctx: APIRequestContext, questionId: string): Promise<void> {
  const res = await ctx.post(`/api/cases/${CASE_ID}/answer`, { data: { questionId, answer: answerFor(CASE_ID, questionId) } });
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { correct: boolean }).correct).toBe(true);
}

test("class board: two members solve, the public board shows both, then the freeze holds it", async ({ playwright, baseURL }) => {
  const owner = await player(playwright, baseURL, "e2ecbo");
  const ada = await player(playwright, baseURL, "e2ecba");
  const bob = await player(playwright, baseURL, "e2ecbb");
  const anon = await playwright.request.newContext({ baseURL }); // the projector: no cookie at all

  const created = await owner.ctx.post("/api/classes", { data: { name: "E2E board night" } });
  expect(created.status(), await created.text()).toBe(201);
  const cls = ((await created.json()) as ClassBody).class;
  const code = cls.admin?.joinCode ?? "";
  const token = cls.boardToken ?? "";
  for (const p of [ada, bob]) expect((await p.ctx.post("/api/classes/join", { data: { code } })).status()).toBe(200);

  const now = Date.now();
  const event = { name: "E2E night", startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), freezeAt: null, announcement: null };
  const patched = await owner.ctx.patch(`/api/classes/${cls.id}`, { data: { caseIds: [CASE_ID], event } });
  expect(patched.status(), await patched.text()).toBe(200);

  for (const p of [ada, bob]) {
    expect((await p.ctx.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
    await solve(p.ctx, "q1");
  }

  const live = await anon.get(`/api/classboard/${token}`);
  expect(live.status(), await live.text()).toBe(200);
  expect(live.headers()["set-cookie"]).toBeUndefined();
  expect(live.headers()["netlify-cache-tag"]).toBe(`class:${cls.id}`);
  const board = (await live.json()) as BoardBody;
  expect(board.classId).toBe(cls.id);
  expect(board.className).toBe("E2E board night");
  expect(board.event.name).toBe("E2E night");
  expect(board.frozen).toBe(false);
  expect(board.entries.map((e) => e.username).sort()).toEqual([ada.username, bob.username].sort());
  expect(board.entries.find((e) => e.username === ada.username)?.firstBloods).toBe(1); // Ada solved q1 first in the class
  // Members aren't on the global board unless they opt in.
  const global = (await (await anon.get("/api/leaderboard")).json()) as BoardBody;
  expect(global.entries.map((e) => e.username)).not.toContain(ada.username);

  // Freeze now: Bob's next solve still plays, but doesn't count.
  const freezeAt = new Date().toISOString();
  expect((await owner.ctx.patch(`/api/classes/${cls.id}`, { data: { event: { ...event, freezeAt } } })).status()).toBe(200);
  await solve(bob.ctx, "q2");
  const frozen = (await (await anon.get(`/api/classboard/${token}`)).json()) as BoardBody;
  expect(frozen.frozen).toBe(true);
  expect(frozen.frozenAt).toBe(freezeAt);
  expect(frozen.entries.find((e) => e.username === bob.username)?.stagesSolved).toBe(1);

  // Live progress: the class admin sees both members; a member can't.
  const progress = await owner.ctx.get(`/api/classes/${cls.id}/progress?caseId=${CASE_ID}`);
  expect(progress.status(), await progress.text()).toBe(200);
  expect(progress.headers()["cache-control"]).toBe("no-store");
  const view = (await progress.json()) as ProgressBody;
  expect(view.players.map((p) => p.username).sort()).toEqual([ada.username, bob.username].sort());
  expect(view.players.find((p) => p.username === bob.username)?.stages["q2"]?.status).toBe("solved");
  expect((await ada.ctx.get(`/api/classes/${cls.id}/progress?caseId=${CASE_ID}`)).status()).toBe(403);

  // Rotating the token kills the old URL.
  const rotated = await owner.ctx.post(`/api/classes/${cls.id}/board-token/rotate`, { data: {} });
  expect(rotated.status()).toBe(200);
  const newToken = ((await rotated.json()) as ClassBody).class.boardToken ?? "";
  expect((await anon.get(`/api/classboard/${token}`)).status()).toBe(404);
  expect((await anon.get(`/api/classboard/${newToken}`)).status()).toBe(200);

  for (const c of [owner.ctx, ada.ctx, bob.ctx, anon]) await c.dispose();
});
