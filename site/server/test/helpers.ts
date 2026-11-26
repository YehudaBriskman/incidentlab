// Shared fixtures for server tests: an app over the in-memory store with fake secrets and a controllable clock.
import assert from "node:assert/strict";
import type { z } from "zod";
import type { Secrets } from "../domain/types.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createApp } from "../router.ts";

export const ADMIN_KEY = "admin-key-for-tests-0123456789";
export const TARGET_SECONDS = 600;
const q = { points: 100, hintCosts: [10, 20, 40], targetSeconds: TARGET_SECONDS };
const hintTexts = (qid: string) => [1, 2, 3].map((n) => ({ en: `${qid} hint ${n}`, he: n === 1 ? `${qid} רמז ${n}` : null }));
const caseSecrets = (id: string) => ({
  title: `Case ${id}`,
  answers: { q1: `${id}-a1`, q2: "a2", q3: "a3", q4: "a4", q5: "a5", q6: "a6" },
  debrief: `# debrief ${id}`,
  debriefHe: id === "alpha" ? `# תחקיר ${id}` : null,
  questions: { q1: q, q2: q, q3: q, q4: q, q5: q, q6: { ...q, points: 150 } },
  hints: { q1: hintTexts("q1"), q2: hintTexts("q2"), q3: hintTexts("q3"), q4: hintTexts("q4"), q5: hintTexts("q5"), q6: hintTexts("q6") },
  tools: {
    "grep-5xx": { command: "grep ' 5[0-9][0-9] ' access.log", powershell: "Select-String ' 5\\d\\d ' access.log", lab: "jq -r 'select(.status >= 500) | .path' access.jsonl" },
    "jq-start": { command: "jq 'select(.msg==\"start\")' app.log", powershell: null, lab: null },
  },
  estMinutes: 60,
});
export const SECRETS: Secrets = { cases: { alpha: caseSecrets("alpha"), beta: caseSecrets("beta") } };
export const ALL_ANSWERS = ["a2", "a3", "a4", "a5", "a6"];

export type Client = {
  call(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  json<T extends z.ZodType>(res: Response, schema: T): Promise<z.infer<T>>;
};

export const createHarness = (options: { now?: () => Date; ip?: string; store?: InMemoryKvStore } = {}) => {
  const app = createApp({ store: options.store ?? new InMemoryKvStore(), staticSecrets: SECRETS, adminKey: () => ADMIN_KEY, now: options.now });

  /** A browser-like client that keeps its own cookie jar. */
  const client = (ip = options.ip ?? "10.0.0.1"): Client & { cookie(): string | null } => {
    let session: string | null = null;
    return {
      cookie: () => session,
      async call(path, init = {}) {
        const headers: Record<string, string> = { ...(init.headers ?? {}) };
        if (session) headers["cookie"] = `il_session=${session}`;
        if (init.body !== undefined) headers["content-type"] = "application/json";
        const res = await app.handle(
          new Request(`http://localhost/api${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
          ip,
        );
        const setCookie = res.headers.get("set-cookie");
        const match = setCookie ? /il_session=([^;]*)/.exec(setCookie) : null;
        if (match) session = match[1] ? match[1] : null;
        return res;
      },
      async json(res, schema) {
        return schema.parse(await res.json());
      },
    };
  };

  const admin = (path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "x-admin-key": ADMIN_KEY, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      "10.9.9.9",
    );

  return { app, client, admin };
};

export const expectStatus = async (res: Response | Promise<Response>, status: number, code?: string): Promise<void> => {
  const r = await res;
  const text = await r.clone().text();
  assert.equal(r.status, status, text);
  if (code !== undefined) assert.equal((JSON.parse(text) as { code?: string }).code, code, text);
};
