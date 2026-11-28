// Event runs that count only on the class board (#253): a member who finished the assigned case before a live class
// event is told that solve doesn't count tonight, plays the event run, and scores on the class board while the
// global board and My stats stay as they were. Every test makes its own data through the API (CI is unseeded).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { answerFor, randomUsername } from "./support";

const CASE_ID = "ghost-in-the-network";
const PASSWORD = "e2e-password-123";
const STAGES = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;

type Entry = { username: string; score: number };
const entriesOf = async (request: APIRequestContext, path: string): Promise<Entry[]> => {
  const res = await request.get(path);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
};
const statsOf = async (request: APIRequestContext): Promise<Record<string, unknown>> => {
  const res = await request.get("/api/me/stats");
  expect(res.status()).toBe(200);
  const { stats } = (await res.json()) as { stats: Record<string, unknown> };
  return { ...stats, lastSeenAt: null };
};

test("a member who finished the case earlier plays the event run, and only the class board changes", async ({ page, playwright, baseURL }) => {
  // The owner sets a live event on a class with the case assigned.
  const owner = await playwright.request.newContext({ baseURL });
  expect((await owner.post("/api/auth/register", { data: { username: randomUsername("evowner"), password: PASSWORD } })).status()).toBe(201);
  const created = await owner.post("/api/classes", { data: { name: "E2E event class" } });
  expect(created.status()).toBe(201);
  const cls = ((await created.json()) as { class: { id: string; boardToken: string; admin: { joinCode: string } } }).class;
  const now = Date.now();
  const event = { name: "Event night", startsAt: new Date(now - 10 * 60_000).toISOString(), endsAt: new Date(now + 2 * 3600_000).toISOString(), freezeAt: null, announcement: null };
  const patched = await owner.patch(`/api/classes/${cls.id}`, { data: { caseIds: [CASE_ID], event } });
  expect(patched.status(), await patched.text()).toBe(200);

  // The member finished the case on their own run before, and shows on the global board.
  const member = randomUsername("evrun");
  const api = page.request;
  expect((await api.post("/api/auth/register", { data: { username: member, password: PASSWORD } })).status()).toBe(201);
  expect((await api.post("/api/classes/join", { data: { code: cls.admin.joinCode } })).status()).toBe(200);
  expect((await api.post(`/api/cases/${CASE_ID}/setup-done`, { data: {} })).status()).toBe(200);
  for (const q of STAGES) {
    const res = await api.post(`/api/cases/${CASE_ID}/answer`, { data: { questionId: q, answer: answerFor(CASE_ID, q) } });
    expect(res.status(), await res.text()).toBe(200);
  }
  expect((await api.put("/api/me/board", { data: { show: true } })).status()).toBe(200);
  const globalBefore = (await entriesOf(api, "/api/leaderboard")).find((e) => e.username === member);
  expect(globalBefore?.score ?? 0).toBeGreaterThan(0);
  const statsBefore = await statsOf(api);

  // The case page offers the choice and says the earlier solve doesn't count tonight.
  await page.addInitScript(() => localStorage.setItem("il.lang", "en"));
  await page.goto(`/#/case/${CASE_ID}`);
  const choice = page.getByRole("region", { name: "A class event is live on this case" });
  await expect(choice).toBeVisible();
  await expect(choice).toContainText("E2E event class");
  await expect(choice).toContainText("doesn't count on the class board tonight");
  await choice.getByRole("button", { name: /Play the event run for E2E event class/ }).click();

  // The event run starts fresh, and the status line says which run this is.
  const run = page.locator("header.case-status .cs-run");
  await expect(run).toContainText("Event run");
  await expect(run).toContainText("E2E event class");
  await page.getByRole("button", { name: /ready/i }).click();
  await page.locator(".answer-form input").fill(answerFor(CASE_ID, "q1"));
  await page.locator(".answer-form").getByRole("button", { name: "Check" }).click();
  await expect(page.locator("#stage .result-title")).toBeVisible();

  // The rest of the event run through the API, with the run named.
  for (const q of STAGES.slice(1)) {
    const res = await api.post(`/api/cases/${CASE_ID}/answer`, { data: { questionId: q, answer: answerFor(CASE_ID, q), run: { classId: cls.id } } });
    expect(res.status(), await res.text()).toBe(200);
  }

  // The class board shows the event run's score; the global board and My stats didn't move.
  const classEntry = (await entriesOf(owner, `/api/classboard/${encodeURIComponent(cls.boardToken)}`)).find((e) => e.username === member);
  expect(classEntry?.score ?? 0).toBeGreaterThan(0);
  const globalAfter = (await entriesOf(api, "/api/leaderboard")).find((e) => e.username === member);
  expect(globalAfter?.score).toBe(globalBefore?.score);
  expect(await statsOf(api)).toEqual(statsBefore);

  // Switching back shows the own run, finished as before.
  await page.reload();
  await expect(run).toBeVisible();
  await run.getByRole("button", { name: "Switch to your own run" }).click();
  await expect(page.locator("header.case-status .cs-run")).toHaveCount(0);
  await expect(page.locator("header.case-status")).toContainText(/Debrief/);
  await owner.dispose();
});
