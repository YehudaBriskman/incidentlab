import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountResponseSchema,
  AdminAccountsResponseSchema,
  ApproveAllResponseSchema,
  AuditResponseSchema,
  EventResponseSchema,
  LeaderboardResponseSchema,
  ProgressResponseSchema,
  ResetPasswordResponseSchema,
  UserStatsResponseSchema,
} from "../../shared/contract.ts";
import { ADMIN_KEY, ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";

const approvedPlayer = async (harness: ReturnType<typeof createHarness>, username: string) => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  return { player, id };
};

test("admin signs in as `admin` with the ADMIN_KEY and uses admin routes by cookie", async () => {
  const harness = createHarness();
  const browser = harness.client();
  await expectStatus(browser.call("/auth/login", { body: { username: "admin", password: "wrong-key-wrong-key" } }), 401, "bad-credentials");
  const res = await browser.call("/auth/login", { body: { username: "Admin", password: ADMIN_KEY } });
  assert.equal(res.status, 200);
  const me = await browser.json(await browser.call("/me"), AccountResponseSchema);
  assert.deepEqual([me.account.role, me.account.username], ["admin", "admin"]);
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=43200/);

  await expectStatus(browser.call("/admin/accounts"), 200); // cookie, no header
  await expectStatus(browser.call("/cases/alpha/progress"), 403, "admin");
  await expectStatus(browser.call("/admin/accounts", { headers: { "x-admin-key": "bad" } }), 401); // a bad header is never ignored
  await expectStatus(harness.client().call("/admin/accounts"), 401);
});

test("reserved usernames can't be registered", async () => {
  const { client } = createHarness();
  for (const name of ["admin", "ADMIN", "root", "instructor"]) {
    await expectStatus(client().call("/auth/register", { body: { username: name, password: "password1" } }), 409, "reserved");
  }
});

test("commands: syntax free, full command -5 on the active stage, re-reveal free, all free after completion", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Cmd");
  await player.call("/cases/alpha/progress");
  await expectStatus(player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx" } }), 403, "locked");
  await player.call("/cases/alpha/setup-done", { body: {} });
  await expectStatus(player.call("/cases/alpha/reveal-command", { body: { toolId: "nope" } }), 404, "unknown-command");

  const first = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx" } }), ProgressResponseSchema);
  assert.equal(first.progress.stages.q1.commandsRevealed, 1);
  assert.equal(first.progress.unlocked.commands["grep-5xx"]?.command, "grep ' 5[0-9][0-9] ' access.log");
  assert.equal(first.progress.unlocked.commands["jq-start"], undefined);
  const again = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx" } }), ProgressResponseSchema);
  assert.equal(again.progress.stages.q1.commandsRevealed, 1);

  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  const q1 = (await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema)).progress.stages.q1;
  assert.equal(q1.breakdown?.commands, -5);
  assert.equal(q1.breakdown?.clean, 0);

  for (const [i, answer] of ALL_ANSWERS.entries()) await player.call("/cases/alpha/answer", { body: { questionId: `q${i + 2}`, answer } });
  const done = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.ok(done.progress.completedAt);
  assert.equal(done.progress.completionBonus, 50);
  assert.deepEqual(Object.keys(done.progress.unlocked.commands).sort(), ["grep-5xx", "jq-start"]);
  assert.equal(done.progress.unlocked.hints.q3?.length, 3); // all hints readable after the case
});

test("hints are served only after payment, in the requested language", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Hinter");
  await player.call("/cases/alpha/setup-done", { body: {} });
  const before = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(before.progress.unlocked.hints.q1, undefined);
  await player.call("/cases/alpha/hint", { body: { questionId: "q1" } });
  const en = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.deepEqual(en.progress.unlocked.hints.q1, ["q1 hint 1"]);
  const he = await player.json(await player.call("/cases/alpha/progress?lang=he"), ProgressResponseSchema);
  assert.deepEqual(he.progress.unlocked.hints.q1, ["q1 רמז 1"]);
});

test("time bonus uses the stage's active time; first blood goes to one player only", async () => {
  let now = new Date("2026-11-25T10:00:00Z");
  const harness = createHarness({ now: () => now });
  const fast = await approvedPlayer(harness, "Fast");
  const slow = await approvedPlayer(harness, "Slow");
  await fast.player.call("/cases/alpha/setup-done", { body: {} });
  await slow.player.call("/cases/alpha/setup-done", { body: {} });
  now = new Date("2026-11-25T10:05:00Z"); // 5 min, target 10 min
  await fast.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } });
  now = new Date("2026-11-25T10:20:00Z"); // 20 min = 2x target
  await slow.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } });
  const f = (await fast.player.json(await fast.player.call("/cases/alpha/progress"), ProgressResponseSchema)).progress.stages.q1.breakdown;
  const s = (await slow.player.json(await slow.player.call("/cases/alpha/progress"), ProgressResponseSchema)).progress.stages.q1.breakdown;
  assert.deepEqual([f?.time, f?.firstBlood, f?.solveSeconds], [30, 15, 300]);
  assert.deepEqual([s?.time, s?.firstBlood], [15, 0]);
});

test("password reset by admin forces a change; change-password works", async () => {
  const harness = createHarness();
  const { player, id } = await approvedPlayer(harness, "Forgetful");
  const reset = await player.json(await harness.admin(`/admin/accounts/${id}/reset-password`, { body: {} }), ResetPasswordResponseSchema);
  assert.match(reset.temporaryPassword, /^[A-Za-z2-9]{10}$/);
  await expectStatus(player.call("/me"), 401); // signed out everywhere
  await expectStatus(player.call("/auth/login", { body: { username: "forgetful", password: "password1" } }), 401);
  await expectStatus(player.call("/auth/login", { body: { username: "forgetful", password: reset.temporaryPassword } }), 200);
  assert.equal((await player.json(await player.call("/me"), AccountResponseSchema)).account.mustChangePassword, true);
  await expectStatus(player.call("/cases/alpha/progress"), 403, "password-change-required");
  await expectStatus(player.call("/me/password", { body: { currentPassword: "nope", newPassword: "new-password-1" } }), 400, "bad-credentials");
  await expectStatus(player.call("/me/password", { body: { currentPassword: reset.temporaryPassword, newPassword: "new-password-1" } }), 200);
  await expectStatus(player.call("/cases/alpha/progress"), 200); // the new cookie keeps working
  await expectStatus(harness.client().call("/auth/login", { body: { username: "forgetful", password: "new-password-1" } }), 200);
});

test("invite code still accepted; wrong code is refused; approve-all finds nothing left to approve", async () => {
  const harness = createHarness();
  await expectStatus(harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: "Class-2026" } }), 200);
  const withCode = harness.client();
  const res = await withCode.json(await withCode.call("/auth/register", { body: { username: "coded", password: "password1", inviteCode: " class-2026 " } }), AccountResponseSchema);
  assert.equal(res.account.status, "approved");
  await expectStatus(harness.client().call("/auth/register", { body: { username: "guess", password: "password1", inviteCode: "nope" } }), 400, "bad-class-code");
  // Sign-up is open (#173): accounts without a code are approved too, so approve-all has nothing to do.
  for (const name of ["open1", "open2", "open3"]) await harness.client().call("/auth/register", { body: { username: name, password: "password1" } });
  const all = await withCode.json(await harness.admin("/admin/accounts/approve-all", { body: {} }), ApproveAllResponseSchema);
  assert.equal(all.approved, 0);
  const list = await withCode.json(await harness.admin("/admin/accounts"), AdminAccountsResponseSchema);
  assert.ok(list.accounts.every((a) => a.status === "approved"));
});

test("CSV export has a header and one row per opened case", async () => {
  const harness = createHarness();
  await approvedPlayer(harness, "Idle_one"); // approved but never opened a case: no rows
  const p2 = await approvedPlayer(harness, "Plain");
  await p2.player.call("/cases/alpha/setup-done", { body: {} });
  const res = await harness.admin("/admin/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.ok(lines[0]?.startsWith("username,status,rank,total_score,case"));
  assert.equal(lines.length, 2); // only Plain opened a case
  assert.ok(lines[1]?.startsWith("Plain,approved,"));
});

test("the global event never refuses play (#180); its freeze still shows standings as of freezeAt", async () => {
  let now = new Date("2026-11-25T09:00:00Z");
  const harness = createHarness({ now: () => now });
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  for (const p of [ada, bob]) await expectStatus(p.player.call("/me/board", { method: "PUT", body: { show: true } }), 200);
  await ada.player.call("/cases/alpha/setup-done", { body: {} });
  await bob.player.call("/cases/alpha/setup-done", { body: {} });
  await expectStatus(harness.admin("/admin/event", { method: "PUT", body: { name: "x", startsAt: "2026-11-25T11:00:00Z", endsAt: "2026-11-25T10:00:00Z", freezeAt: null, enforceWindow: false, announcement: null } }), 400);
  const saved = await ada.player.json(
    await harness.admin("/admin/event", {
      method: "PUT",
      body: { name: "Friday CTF", startsAt: "2026-11-25T10:00:00Z", endsAt: "2026-11-25T11:00:00Z", freezeAt: "2026-11-25T10:45:00Z", enforceWindow: true, announcement: { text: "Hints are half price!", level: "info" } },
    }),
    EventResponseSchema,
  );
  assert.equal(saved.event.announcement?.text, "Hints are half price!");
  const pub = await ada.player.json(await ada.player.call("/event"), EventResponseSchema);
  assert.equal(pub.event.name, "Friday CTF");

  // Before the window, with enforceWindow on: a hint and a wrong answer still go through.
  await expectStatus(ada.player.call("/cases/alpha/hint", { body: { questionId: "q1" } }), 200);
  await expectStatus(ada.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope" } }), 200);
  now = new Date("2026-11-25T10:30:00Z");
  await expectStatus(ada.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  now = new Date("2026-11-25T10:50:00Z"); // after freeze
  await expectStatus(bob.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  const board = await ada.player.json(await ada.player.call("/leaderboard?caseId=alpha"), LeaderboardResponseSchema);
  assert.equal(board.frozen, true);
  assert.deepEqual(board.entries.map((e) => e.username), ["Ada"]); // Bob solved after the freeze
  now = new Date("2026-11-25T11:00:01Z");
  // After the window: hints, command reveals, answers and reveals all still work.
  await expectStatus(bob.player.call("/cases/alpha/hint", { body: { questionId: "q2" } }), 200);
  await expectStatus(bob.player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx" } }), 200);
  await expectStatus(bob.player.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2" } }), 200);
  await expectStatus(bob.player.call("/cases/alpha/reveal", { body: { questionId: "q3" } }), 200);
  // A start outside the window works too.
  const carol = await approvedPlayer(harness, "Carol");
  await expectStatus(carol.player.call("/cases/beta/setup-done", { body: {} }), 200);
  await expectStatus(ada.player.call("/leaderboard?caseId=../x"), 400);
});

test("achievements and daily streaks", async () => {
  let now = new Date("2026-11-23T08:00:00Z");
  const harness = createHarness({ now: () => now });
  await harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "UTC", defaultCaseId: null, days: { "2026-11-23": "alpha", "2026-11-24": "beta", "2026-11-25": "alpha" }, lockToToday: false } });
  const { player } = await approvedPlayer(harness, "Streaker");
  const finish = async (caseId: string): Promise<void> => {
    await player.call(`/cases/${caseId}/setup-done`, { body: {} });
    now = new Date(now.getTime() + 60_000);
    for (const [i, answer] of [`${caseId}-a1`, ...ALL_ANSWERS].entries()) await player.call(`/cases/${caseId}/answer`, { body: { questionId: `q${i + 1}`, answer } });
  };
  await finish("alpha"); // on 23rd, scheduled alpha
  now = new Date("2026-11-24T08:00:00Z");
  await finish("beta"); // on 24th, scheduled beta
  now = new Date("2026-11-25T09:00:00Z");
  const stats = await player.json(await player.call("/me/stats"), UserStatsResponseSchema);
  assert.deepEqual(stats.stats.streak, { current: 2, best: 2, activeToday: false });
  const ids = stats.stats.achievements.map((a) => a.id);
  for (const id of ["first-blood", "clean-case", "speedrun", "no-hints-5", "all-cases"]) assert.ok(ids.includes(id), `${id} in ${ids.join(",")}`);
  assert.ok(!ids.includes("streak-3"));
});

test("a streak counts any solved stage per day, so seven days is reachable with two cases (#212)", async () => {
  let now = new Date("2026-11-23T08:00:00Z");
  const harness = createHarness({ now: () => now });
  await harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "UTC", defaultCaseId: null, days: {}, lockToToday: false } });
  const { player } = await approvedPlayer(harness, "Daily");
  await player.call("/cases/alpha/setup-done", { body: {} });
  await player.call("/cases/beta/setup-done", { body: {} });
  // Day 1: alpha q1 (plus beta q1); days 2-6: one beta stage each; day 7: alpha q2.
  const plan: Array<[string, number, string]> = [["alpha", 1, "alpha-a1"], ...ALL_ANSWERS.slice(0, 5).map((a, i): [string, number, string] => ["beta", i + 2, a])];
  await player.call("/cases/beta/answer", { body: { questionId: "q1", answer: "beta-a1" } });
  for (const [i, [caseId, q, answer]] of plan.entries()) {
    now = new Date(Date.parse("2026-11-23T08:00:00Z") + i * 86_400_000);
    const res = await player.call(`/cases/${caseId}/answer`, { body: { questionId: `q${q}`, answer } });
    assert.equal(res.status, 200);
  }
  now = new Date("2026-11-29T10:00:00Z"); // day 7
  await player.call("/cases/alpha/answer", { body: { questionId: "q2", answer: ALL_ANSWERS[0] } });
  const stats = await player.json(await player.call("/me/stats"), UserStatsResponseSchema);
  assert.deepEqual(stats.stats.streak, { current: 7, best: 7, activeToday: true });
  const ids = stats.stats.achievements.map((a) => a.id);
  assert.ok(ids.includes("streak-3") && ids.includes("streak-7"), ids.join(","));
  // A missed day resets the current streak but keeps the best.
  now = new Date("2026-12-01T10:00:00Z");
  const later = await player.json(await player.call("/me/stats"), UserStatsResponseSchema);
  assert.deepEqual(later.stats.streak, { current: 0, best: 7, activeToday: false });
});

test("audit log records admin actions, newest first", async () => {
  let tick = Date.parse("2026-11-25T10:00:00Z");
  const harness = createHarness({ now: () => new Date((tick += 1000)) });
  const { id } = await approvedPlayer(harness, "Audited");
  await harness.admin(`/admin/accounts/${id}/reject`, { body: {} });
  const browser = harness.client();
  await browser.call("/auth/login", { body: { username: "admin", password: ADMIN_KEY } });
  await browser.call("/admin/reset", { body: { confirm: "RESET", caseId: "alpha" } });
  const log = await browser.json(await harness.admin("/admin/audit?limit=10"), AuditResponseSchema);
  assert.deepEqual(log.entries.map((e) => [e.action, e.via]), [["progress.reset", "session"], ["account.reject", "key"], ["account.approve", "key"]]);
});
