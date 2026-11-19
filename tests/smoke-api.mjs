#!/usr/bin/env node
// End-to-end API smoke test against a deployed IncidentLab (preview or prod).
// Usage: node tests/smoke-api.mjs <baseUrl> [adminKeyFile]
// Reads plaintext answers from build/truth/answers.json (instructor machine only).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) { console.error("usage: smoke-api.mjs <baseUrl> [adminKeyFile]"); process.exit(2); }
const adminKey = readFileSync(process.argv[3] ?? `${homedir()}/.incidentlab-admin-key`, "utf8").trim();
const answers = JSON.parse(readFileSync(new URL("../build/truth/answers.json", import.meta.url), "utf8")).answers;

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
async function call(method, path, { token, body, admin } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin !== undefined) headers["x-admin-key"] = admin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, headers: res.headers };
}

// Static + security headers
const home = await fetch(base + "/");
check("home 200", home.status === 200);
check("CSP header present", (home.headers.get("content-security-policy") ?? "").includes("connect-src"));
const bundleLeak = await (await fetch(base + "/")).text();
check("no flags.json reference in html", !bundleLeak.includes("flags.json"));

// Player lifecycle
check("XSS name rejected", (await call("POST", "/api/players", { body: { name: "<script>alert(1)</script>", caseId: "3am-outage" } })).status === 400);
const created = await call("POST", "/api/players", { body: { name: "Smoke Tester", caseId: "3am-outage" } });
check("create player 200/201", created.status === 200 || created.status === 201, String(created.status));
const token = created.json?.token; const pid = created.json?.player?.id;
check("no auth -> 401", (await call("GET", "/api/me")).status === 401);
check("bad token -> 401", (await call("GET", "/api/me", { token: "nope.nope" })).status === 401);
check("me 200", (await call("GET", "/api/me", { token })).status === 200);
check("answer before setup -> 403", (await call("POST", "/api/answer", { token, body: { questionId: "q1", answer: "x" } })).status === 403);
check("setup-done 200", (await call("POST", "/api/setup-done", { token, body: {} })).status === 200);
check("answer q2 out of order -> 403", (await call("POST", "/api/answer", { token, body: { questionId: "q2", answer: answers.q2 } })).status === 403);
const wrong = await call("POST", "/api/answer", { token, body: { questionId: "q1", answer: "03:13:14" } });
check("local-time trap rejected", wrong.status === 200 && wrong.json?.correct === false);
check("hint q1", (await call("POST", "/api/hint", { token, body: { questionId: "q1" } })).status === 200);
const q1 = await call("POST", "/api/answer", { token, body: { questionId: "q1", answer: `  ${answers.q1} ` } });
check("q1 correct (whitespace-normalized)", q1.json?.correct === true);
check("q1 points = 100 - hint cost", q1.json?.player?.stages?.q1?.points === 90, String(q1.json?.player?.stages?.q1?.points));
const rev = await call("POST", "/api/reveal", { token, body: { questionId: "q2" } });
check("reveal q2 gives answer, 0 pts", rev.json?.player?.stages?.q2?.revealedAnswer?.toLowerCase() === answers.q2.toLowerCase() && rev.json?.player?.stages?.q2?.points === 0);
check("debrief locked before finish -> 403", (await call("GET", "/api/debrief", { token })).status === 403);
for (const q of ["q3", "q4", "q5", "q6"]) {
  const r = await call("POST", "/api/answer", { token, body: { questionId: q, answer: answers[q].toUpperCase() } });
  check(`${q} correct (case-insensitive)`, r.json?.correct === true);
}
const deb = await call("GET", "/api/debrief", { token });
check("debrief unlocked", deb.status === 200 && (deb.json?.markdown ?? "").length > 500);

// Rate limit on a fresh player
const p2 = await call("POST", "/api/players", { body: { name: "Rate Limiter", caseId: "3am-outage" } });
await call("POST", "/api/setup-done", { token: p2.json?.token, body: {} });
let last = 0;
for (let i = 0; i < 6; i++) last = (await call("POST", "/api/answer", { token: p2.json?.token, body: { questionId: "q1", answer: `wrong-${i}` } })).status;
check("6th wrong answer -> 429", last === 429, String(last));

// Admin
check("admin no key -> 401", (await call("GET", "/api/admin/players", { admin: "" })).status === 401);
check("admin wrong key -> 401", (await call("GET", "/api/admin/players", { admin: "x".repeat(48) })).status === 401);
const adm = await call("GET", "/api/admin/players", { admin: adminKey });
const me = adm.json?.players?.find((p) => p.id === pid);
check("admin sees player with full score", adm.status === 200 && me?.score === 90 + 0 + 100 + 100 + 100 + 150, String(me?.score));
for (const id of [pid, p2.json?.player?.id]) check(`admin delete ${id}`, (await call("DELETE", `/api/admin/players/${id}`, { admin: adminKey })).status === 204);
check("deleted token -> 401", (await call("GET", "/api/me", { token })).status === 401);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
