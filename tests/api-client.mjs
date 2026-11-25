// Tiny cookie-aware API client shared by the smoke and load tests (Node's fetch has no cookie jar).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const readAdminKey = (file) => readFileSync(file ?? `${homedir()}/.incidentlab-admin-key`, "utf8").trim();
/** Plaintext answers for every case (instructor machine only; written by scripts/make_flags.py). */
export const readAllAnswers = () => JSON.parse(readFileSync(new URL("../build/truth/all-answers.json", import.meta.url), "utf8")).cases;

export function createSession(base, { onResponse } = {}) {
  let cookie = null;
  async function call(method, path, { body, admin, timeoutMs = 15000 } = {}) {
    const headers = { "content-type": "application/json" };
    if (cookie) headers.cookie = `il_session=${cookie}`;
    if (admin !== undefined) headers["x-admin-key"] = admin;
    const started = performance.now();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const setCookie = res.headers.get("set-cookie");
    const match = setCookie ? /il_session=([^;]*)/.exec(setCookie) : null;
    if (match) cookie = match[1] || null;
    const text = res.status === 204 ? "" : await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    onResponse?.({ method, path, status: res.status, json, ms: performance.now() - started });
    return { status: res.status, json, headers: res.headers };
  }
  return { call, hasCookie: () => cookie !== null };
}
