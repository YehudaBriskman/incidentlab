#!/usr/bin/env node
// End-to-end API smoke test against a deployed IncidentLab (preview or prod).
// Usage: node tests/smoke-api.mjs <baseUrl> [adminKeyFile] [caseId=3am-outage]
// Reads plaintext answers from build/truth/all-answers.json (instructor machine only).
// Creates two throwaway accounts and deletes them at the end.
import { createSession, readAdminKey, readAllAnswers } from "./api-client.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) { console.error("usage: smoke-api.mjs <baseUrl> [adminKeyFile] [caseId]"); process.exit(2); }
const adminKey = readAdminKey(process.argv[3]);
const caseId = process.argv[4] ?? "3am-outage";
const answers = readAllAnswers()[caseId];
if (!answers) { console.error(`no answers for ${caseId}`); process.exit(2); }

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const admin = createSession(base);
const adminCall = (method, path, body) => admin.call(method, path, { admin: adminKey, body });
const cases = (path) => `/api/cases/${caseId}${path}`;
const suffix = Math.random().toString(36).slice(2, 8);

// Static + security headers
const home = await fetch(base + "/");
check("home 200", home.status === 200);
check("CSP header present", (home.headers.get("content-security-policy") ?? "").includes("connect-src"));
check("no secrets reference in html", !(await (await fetch(base + "/")).text()).includes("secrets.json"));
const today = await admin.call("GET", "/api/today");
check("today lists the case as released", today.status === 200 && today.json?.releasedCaseIds?.includes(caseId), JSON.stringify(today.json?.releasedCaseIds));
// Case content and evidence come only from the content API and the location it names (#68).
const catalog = await (await fetch(`${base}/api/cases`)).json();
check("catalog lists the case", catalog?.cases?.some((c) => c.en?.id === caseId), JSON.stringify(catalog?.cases?.map((c) => c.en?.id)));
const contentRes = await fetch(`${base}/api/cases/${caseId}/content?lang=en`);
const content = contentRes.status === 200 ? await contentRes.json() : null;
check("case content served", content?.id === caseId && Array.isArray(content?.content?.questions), String(contentRes.status));
const hintTexts = (content?.content?.questions ?? []).flatMap((q) => (q.hints ?? []).filter((h) => "text" in h));
const commands = (content?.content?.toolbox ?? []).flatMap((s) => (s.items ?? []).filter((it) => "command" in it || "powershell" in it));
check("case content carries no paid content (hint texts, commands)", content !== null && hintTexts.length === 0 && commands.length === 0, `${hintTexts.length} hint texts, ${commands.length} commands`);
const location = content?.evidence;
check("content names its evidence location", typeof location?.filesBase === "string" && typeof location?.zip === "string", JSON.stringify(location));
const abs = (url) => new URL(url, base + "/").toString();
const zipHead = location ? await fetch(abs(location.zip), { method: "HEAD" }) : null;
check("evidence zip served", zipHead?.status === 200 && (zipHead.headers.get("content-disposition") ?? "").includes(`${caseId}-evidence.zip`), String(zipHead?.status));
check("explorer README served", location ? (await fetch(abs(location.filesBase + "README_FIRST.txt"))).status === 200 : false);
check("no static evidence on the site", (await fetch(`${base}/evidence/${caseId}-evidence.zip`, { method: "HEAD" })).headers.get("content-type")?.includes("zip") !== true);

// Accounts
const player = createSession(base);
const username = `smoke_${suffix}`;
check("XSS username rejected", (await player.call("POST", "/api/auth/register", { body: { username: "<script>x", password: "password1" } })).status === 400);
const reg = await player.call("POST", "/api/auth/register", { body: { username, password: "smoke-password-1" } });
check("register 201 + cookie", reg.status === 201 && player.hasCookie(), String(reg.status));
check("cookie is HttpOnly", /HttpOnly/i.test(reg.headers.get("set-cookie") ?? ""));
const accountId = reg.json?.account?.id;
check("duplicate username (other case) -> 409", (await createSession(base).call("POST", "/api/auth/register", { body: { username: username.toUpperCase(), password: "password1" } })).status === 409);
check("pending can't play -> 403", (await player.call("GET", cases("/progress"))).status === 403);
check("signed out -> 401", (await createSession(base).call("GET", "/api/me")).status === 401);
check("admin approve", (await adminCall("POST", `/api/admin/accounts/${accountId}/approve`, {})).status === 200);
check("logout 204", (await player.call("POST", "/api/auth/logout", { body: {} })).status === 204);
check("after logout -> 401", (await player.call("GET", "/api/me")).status === 401);
check("wrong password -> 401", (await player.call("POST", "/api/auth/login", { body: { username, password: "nope-nope" } })).status === 401);
check("login 200", (await player.call("POST", "/api/auth/login", { body: { username, password: "smoke-password-1" } })).status === 200);

// Gameplay
check("progress 200", (await player.call("GET", cases("/progress"))).status === 200);
check("answer before setup -> 403", (await player.call("POST", cases("/answer"), { body: { questionId: "q1", answer: "x" } })).status === 403);
check("reveal-command unknown tool -> 404", (await player.call("POST", cases("/reveal-command"), { body: { toolId: "no-such-tool" } })).status === 404);
check("setup-done 200", (await player.call("POST", cases("/setup-done"), { body: {} })).status === 200);
const progressNow = (await player.call("GET", cases("/progress"))).json?.progress;
check("paid content hidden before payment", progressNow && Object.keys(progressNow.unlocked.commands).length === 0 && !progressNow.unlocked.hints.q1);
check("answer q2 out of order -> 403", (await player.call("POST", cases("/answer"), { body: { questionId: "q2", answer: answers.q2 } })).status === 403);
const wrong = await player.call("POST", cases("/answer"), { body: { questionId: "q1", answer: "definitely-wrong" } });
check("wrong answer rejected", wrong.status === 200 && wrong.json?.correct === false);
const hinted = await player.call("POST", cases("/hint"), { body: { questionId: "q1" } });
check("hint q1 returns its text", hinted.status === 200 && (hinted.json?.progress?.unlocked?.hints?.q1?.[0] ?? "").length > 10);

const q1 = await player.call("POST", cases("/answer"), { body: { questionId: "q1", answer: `  ${answers.q1} ` } });
check("q1 correct (whitespace-normalized)", q1.json?.correct === true);
const bd = q1.json?.progress?.stages?.q1?.breakdown;
check("q1 has a score breakdown (hint −cost, wrong −2)", bd && bd.hints < 0 && bd.wrong === -2 && bd.total === q1.json.progress.stages.q1.points, JSON.stringify(bd));
const rev = await player.call("POST", cases("/reveal"), { body: { questionId: "q2" } });
check("reveal q2 gives answer, 0 pts", rev.json?.progress?.stages?.q2?.revealedAnswer?.toLowerCase() === answers.q2.toLowerCase() && rev.json?.progress?.stages?.q2?.points === 0);
check("debrief locked before finish -> 403", (await player.call("GET", cases("/debrief"))).status === 403);
for (const q of ["q3", "q4", "q5", "q6"]) {
  const r = await player.call("POST", cases("/answer"), { body: { questionId: q, answer: answers[q].toUpperCase() } });
  check(`${q} correct (case-insensitive)`, r.json?.correct === true);
}
const deb = await player.call("GET", cases("/debrief"));
check("debrief unlocked", deb.status === 200 && (deb.json?.markdown ?? "").length > 500);
const stats = await player.call("GET", "/api/me/stats");
check("my stats count the completed case", stats.json?.stats?.cases?.find((c) => c.caseId === caseId)?.status === "completed");
const done = (await player.call("GET", cases("/progress"))).json?.progress;
check("every command free after completion", done && Object.keys(done.unlocked.commands).length > 5, String(Object.keys(done?.unlocked?.commands ?? {}).length));

// Paid command on a fresh case run (second account)

const second = createSession(base);
const reg2 = await second.call("POST", "/api/auth/register", { body: { username: `smoke2_${suffix}`, password: "password1" } });
await adminCall("POST", `/api/admin/accounts/${reg2.json?.account?.id}/approve`, {});
await second.call("POST", cases("/setup-done"), { body: {} });
const anyTool = Object.keys(done?.unlocked?.commands ?? {})[0];
const paid = await second.call("POST", cases("/reveal-command"), { body: { toolId: anyTool } });
check("reveal-command charges the active stage", paid.status === 200 && paid.json?.progress?.stages?.q1?.commandsRevealed === 1 && Boolean(paid.json?.progress?.unlocked?.commands?.[anyTool]));
check("re-reveal is free", (await second.call("POST", cases("/reveal-command"), { body: { toolId: anyTool } })).json?.progress?.stages?.q1?.commandsRevealed === 1);
let last = 0;
for (let i = 0; i < 6; i++) last = (await second.call("POST", cases("/answer"), { body: { questionId: "q1", answer: `wrong-${i}` } })).status;
check("6th wrong answer -> 429", last === 429, String(last));

// Public endpoints
check("leaderboard public", (await createSession(base).call("GET", `/api/leaderboard?caseId=${caseId}`)).status === 200);
check("event public", (await createSession(base).call("GET", "/api/event")).status === 200);
check("reserved username -> 409", (await createSession(base).call("POST", "/api/auth/register", { body: { username: "admin", password: "password1" } })).status === 409);

// Admin
const adminBrowser = createSession(base);
check("admin sign-in with the key", (await adminBrowser.call("POST", "/api/auth/login", { body: { username: "admin", password: adminKey } })).status === 200);
check("admin cookie opens admin routes", (await adminBrowser.call("GET", "/api/admin/audit?limit=5")).status === 200);
check("admin can't play", (await adminBrowser.call("GET", cases("/progress"))).status === 403);
await adminBrowser.call("POST", "/api/auth/logout", { body: {} });
check("admin no key -> 401", (await admin.call("GET", "/api/admin/accounts", { admin: "" })).status === 401);
check("admin wrong key -> 401", (await admin.call("GET", "/api/admin/accounts", { admin: "x".repeat(48) })).status === 401);
const live = await adminCall("GET", `/api/admin/progress?caseId=${caseId}`);
check("admin live view shows the finished player", live.status === 200 && live.json?.players?.some((p) => p.accountId === accountId && p.currentStage === "done"));
check("admin stats 200", (await adminCall("GET", "/api/admin/stats")).status === 200);
for (const id of [accountId, reg2.json?.account?.id]) check(`admin delete ${id}`, (await adminCall("DELETE", `/api/admin/accounts/${id}`)).status === 204);
check("deleted account's session -> 401", (await player.call("GET", "/api/me")).status === 401);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
