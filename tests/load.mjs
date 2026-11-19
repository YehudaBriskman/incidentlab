#!/usr/bin/env node
// Classroom load test: N concurrent players run the full flow (create → setup → wrong + hint + correct per stage → debrief)
// while an "admin" polls the dashboard every 2s. Reports latency percentiles + error counts, then deletes the test players.
// Usage: node tests/load.mjs <baseUrl> [players=40] [adminKeyFile]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const N = Number(process.argv[3] ?? 40);
const adminKey = readFileSync(process.argv[4] ?? `${homedir()}/.incidentlab-admin-key`, "utf8").trim();
const answers = JSON.parse(readFileSync(new URL("../build/truth/answers.json", import.meta.url), "utf8")).answers;
const lat = []; const errors = {}; const ids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Think time between actions. Netlify's edge DDoS protection blocks ~45 req/s bursts from ONE IP,
// so a no-think-time test measures the edge, not us. 1–3s is still ~10x faster than real students.
const think = () => sleep(Number(process.env.THINK_MS ?? 1000) * (1 + Math.random() * 2));

async function call(method, path, { token, body, admin } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers["x-admin-key"] = admin;
  const t = performance.now();
  try {
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const raw = res.status === 204 ? "" : await res.text();
    let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    if (res.status === 403 && !json?.error && !globalThis.__sample) { globalThis.__sample = 1; console.log("SAMPLE 403:", JSON.stringify([...res.headers].filter(([k]) => /nf|server|type/.test(k))), raw.slice(0, 200)); }
    lat.push(performance.now() - t);
    if (res.status >= 400 && !(res.status === 200)) { const k = `${res.status} ${path} ${json?.error ?? ""}`; errors[k] = (errors[k] ?? 0) + 1; }
    return { status: res.status, json };
  } catch (e) { errors[`net ${path}`] = (errors[`net ${path}`] ?? 0) + 1; return { status: 0, json: null }; }
}

async function player(i) {
  await sleep(Math.random() * 15000); // students join over ~15s
  const c = await call("POST", "/api/players", { body: { name: `Load ${i}`, caseId: "3am-outage" } });
  const token = c.json?.token; if (!token) return false;
  ids.push(c.json.player.id);
  await call("POST", "/api/setup-done", { token, body: {} });
  for (const q of ["q1", "q2", "q3", "q4", "q5", "q6"]) {
    await think();
    await call("POST", "/api/answer", { token, body: { questionId: q, answer: "nope" } });
    await think();
    if (Math.random() < 0.5) await call("POST", "/api/hint", { token, body: { questionId: q } });
    // double-submit the right answer concurrently (idempotency under races)
    await Promise.all([1, 2].map(() => call("POST", "/api/answer", { token, body: { questionId: q, answer: answers[q] } })));
    await sleep(200 + Math.random() * 800);
  }
  const d = await call("GET", "/api/debrief", { token });
  return d.status === 200;
}

let polling = true; let polls = 0;
const admin = (async () => { while (polling) { await call("GET", "/api/admin/players", { admin: adminKey }); polls++; await sleep(2000); } })();
const t0 = performance.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => player(i)));
polling = false; await admin;
const adm = await call("GET", "/api/admin/players", { admin: adminKey });
const finishedInAdmin = (adm.json?.players ?? []).filter((p) => p.name.startsWith("Load ") && p.completedAt).length;
for (const id of ids) await call("DELETE", `/api/admin/players/${id}`, { admin: adminKey });

lat.sort((a, b) => a - b); const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]);
console.log(`players=${N} completed=${results.filter(Boolean).length} adminSawFinished=${finishedInAdmin} requests=${lat.length} adminPolls=${polls} wall=${Math.round((performance.now() - t0) / 1000)}s`);
console.log(`latency ms: p50=${p(0.5)} p95=${p(0.95)} p99=${p(0.99)} max=${Math.round(lat.at(-1) ?? 0)}`);
console.log("errors:", Object.keys(errors).length ? errors : "none");
const ok = results.every(Boolean) && finishedInAdmin >= N && !Object.keys(errors).length;
console.log(ok ? "LOAD TEST PASS" : "LOAD TEST FAIL"); process.exit(ok ? 0 : 1);
