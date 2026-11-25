#!/usr/bin/env node
// Seeds a running IncidentLab (normally tests/local-server.ts) with realistic demo state for UI work:
// approved players at different stages of different cases, a pending and a rejected sign-up, an
// incident-of-the-day schedule, a live event with an announcement, and a class invite code.
// Usage: node tests/seed-demo.mjs <baseUrl> [adminKey]
// Prints the demo credentials as JSON (all players share the password below).
import { readFileSync } from "node:fs";
import { createSession } from "./api-client.mjs";

const base = (process.argv[2] ?? "http://localhost:8888").replace(/\/$/, "");
const adminKey = process.argv[3] ?? process.env.ADMIN_KEY ?? "local-admin-key-0123456789";
const PASSWORD = "demo-password-1";
const answers = JSON.parse(readFileSync(new URL("../build/truth/all-answers.json", import.meta.url), "utf8")).cases;
const admin = createSession(base);
const adminCall = (method, path, body) => admin.call(method, path, { admin: adminKey, body });
const QUESTIONS = ["q1", "q2", "q3", "q4", "q5", "q6"];

async function account(username, status = "approved") {
  const s = createSession(base);
  const res = await s.call("POST", "/api/auth/register", { body: { username, password: PASSWORD } });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${JSON.stringify(res.json)}`);
  const id = res.json.account.id;
  if (status !== "pending") await adminCall("POST", `/api/admin/accounts/${id}/${status === "approved" ? "approve" : "reject"}`, {});
  return { s, id, username };
}

/** Plays `solveCount` stages of a case: some wrong answers, hints and paid commands along the way. */
async function play(player, caseId, solveCount, style = {}) {
  const c = (path) => `/api/cases/${caseId}${path}`;
  await player.s.call("GET", c("/progress"));
  await player.s.call("POST", c("/setup-done"), { body: {} });
  for (const [i, q] of QUESTIONS.slice(0, solveCount).entries()) {
    if (style.wrong && i % 2 === 0) await player.s.call("POST", c("/answer"), { body: { questionId: q, answer: "not-it" } });
    if (style.hints && i % 3 === 1) await player.s.call("POST", c("/hint"), { body: { questionId: q } });
    if (style.reveal && i === 2) {
      await player.s.call("POST", c("/reveal"), { body: { questionId: q } });
      continue;
    }
    await player.s.call("POST", c("/answer"), { body: { questionId: q, answer: answers[caseId][q] } });
  }
}

const players = {
  ada: await account("ada_lovelace"),
  noa: await account("noa_shapira"),
  amir: await account("amir.t"),
  dana: await account("dana_k"),
  yossi: await account("יוסי_בן"),
  lior: await account("lior-m"),
};
await account("waiting_wendy", "pending");
await account("new_student_2", "pending");
await account("spam_bot_99", "rejected");

const today = (await (await fetch(`${base}/api/today`)).json()).date;
await adminCall("PUT", "/api/admin/schedule", {
  timezone: "Asia/Jerusalem",
  defaultCaseId: "3am-outage",
  days: { [today]: "ghost-in-the-network" },
  lockToToday: false,
});

await play(players.ada, "3am-outage", 6, {});
await play(players.ada, "ghost-in-the-network", 3, { hints: true });
await play(players.noa, "3am-outage", 6, { wrong: true, hints: true, reveal: true });
await play(players.noa, "ghost-in-the-network", 1, { wrong: true });
await play(players.amir, "ghost-in-the-network", 4, { wrong: true });
await play(players.dana, "who-deleted-prod", 2, { hints: true });
await play(players.yossi, "ghost-in-the-network", 0, {});
await players.lior.s.call("GET", "/api/cases/kubernetes-crime-scene/progress"); // opened, still on setup

const now = Date.now();
await adminCall("PUT", "/api/admin/event", {
  name: "Friday Incident Night",
  startsAt: new Date(now - 20 * 60_000).toISOString(),
  endsAt: new Date(now + 40 * 60_000).toISOString(),
  freezeAt: new Date(now + 30 * 60_000).toISOString(),
  enforceWindow: false,
  announcement: { text: "Stage 3 is the hard one. Read the chat export before you grep.", level: "info" },
});
await adminCall("PUT", "/api/admin/settings", { inviteCode: "FRIDAY-2026" });

console.log(JSON.stringify({
  baseUrl: base,
  adminLogin: { username: "admin", password: adminKey },
  playerPassword: PASSWORD,
  players: Object.fromEntries(Object.entries(players).map(([k, p]) => [k, p.username])),
  pending: ["waiting_wendy", "new_student_2"],
  rejected: ["spam_bot_99"],
  notes: {
    ada_lovelace: "3am-outage completed; ghost-in-the-network at q4 (used hints)",
    noa_shapira: "3am-outage completed with a revealed stage and wrong answers; ghost at q2",
    "amir.t": "ghost-in-the-network at q5, wrong answers",
    dana_k: "who-deleted-prod at q3",
    "יוסי_בן": "ghost-in-the-network just started (q1 active), Hebrew username",
    "lior-m": "kubernetes-crime-scene opened, still on setup",
    today: `ghost-in-the-network is the incident of the day (${today})`,
    event: "Friday Incident Night is live with an announcement; leaderboard freezes in 30 min",
    inviteCode: "FRIDAY-2026",
  },
}, null, 2));
