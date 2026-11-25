#!/usr/bin/env node
// Classroom load test: N accounts sign up, get approved, and run the full flow on one case
// (setup → wrong + hint + correct per stage → debrief) while an "admin" polls the dashboard every 2s.
// Reports latency percentiles + error counts, then deletes the test accounts.
// Usage: node tests/load.mjs <baseUrl> [players=40] [adminKeyFile] [caseId=3am-outage]
import { createSession, readAdminKey, readAllAnswers } from "./api-client.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const N = Number(process.argv[3] ?? 40);
const adminKey = readAdminKey(process.argv[4]);
const caseId = process.argv[5] ?? "3am-outage";
const answers = readAllAnswers()[caseId];
const lat = []; const errors = {}; const ids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Think time between actions. Netlify's edge DDoS protection blocks ~45 req/s bursts from ONE IP,
// so a no-think-time test measures the edge, not us. 1–3s is still ~10x faster than real students.
const think = () => sleep(Number(process.env.THINK_MS ?? 1000) * (1 + Math.random() * 2));
const onResponse = ({ path, status, json, ms }) => {
  lat.push(ms);
  if (status >= 400) { const k = `${status} ${path.replace(/[A-Za-z0-9]{12}/, ":id")} ${json?.error ?? ""}`; errors[k] = (errors[k] ?? 0) + 1; }
};
const admin = createSession(base, { onResponse });
const adminCall = (method, path, body) => admin.call(method, path, { admin: adminKey, body }).catch(() => ({ status: 0, json: null }));
const suffix = Math.random().toString(36).slice(2, 6);
const cases = (path) => `/api/cases/${caseId}${path}`;

async function player(i) {
  const s = createSession(base, { onResponse });
  const call = (method, path, body) => s.call(method, path, { body }).catch(() => { errors[`net ${path}`] = (errors[`net ${path}`] ?? 0) + 1; return { status: 0, json: null }; });
  await sleep(Math.random() * 15000); // students join over ~15s
  const reg = await call("POST", "/api/auth/register", { username: `load_${suffix}_${i}`, password: "load-test-password" });
  const id = reg.json?.account?.id; if (!id) return false;
  ids.push(id);
  await adminCall("POST", `/api/admin/accounts/${id}/approve`, {});
  await call("GET", cases("/progress"));
  await call("POST", cases("/setup-done"), {});
  for (const q of ["q1", "q2", "q3", "q4", "q5", "q6"]) {
    await think();
    await call("POST", cases("/answer"), { questionId: q, answer: "nope" });
    await think();
    if (Math.random() < 0.5) await call("POST", cases("/hint"), { questionId: q });
    // double-submit the right answer concurrently (idempotency under races)
    await Promise.all([1, 2].map(() => call("POST", cases("/answer"), { questionId: q, answer: answers[q] })));
    await sleep(200 + Math.random() * 800);
  }
  return (await call("GET", cases("/debrief"))).status === 200;
}

let polling = true; let polls = 0;
const poller = (async () => { while (polling) { await adminCall("GET", `/api/admin/progress?caseId=${caseId}`); polls++; await sleep(2000); } })();
const t0 = performance.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => player(i)));
polling = false; await poller;
const live = await adminCall("GET", `/api/admin/progress?caseId=${caseId}`);
const finishedInAdmin = (live.json?.players ?? []).filter((p) => p.username.startsWith(`load_${suffix}_`) && p.completedAt).length;
for (const id of ids) await adminCall("DELETE", `/api/admin/accounts/${id}`);

lat.sort((a, b) => a - b); const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0);
console.log(`players=${N} completed=${results.filter(Boolean).length} adminSawFinished=${finishedInAdmin} requests=${lat.length} adminPolls=${polls} wall=${Math.round((performance.now() - t0) / 1000)}s`);
console.log(`latency ms: p50=${p(0.5)} p95=${p(0.95)} p99=${p(0.99)} max=${Math.round(lat.at(-1) ?? 0)}`);
console.log("errors:", Object.keys(errors).length ? errors : "none");
const ok = results.every(Boolean) && finishedInAdmin >= N && !Object.keys(errors).length;
console.log(ok ? "LOAD TEST PASS" : "LOAD TEST FAIL"); process.exit(ok ? 0 : 1);
