// Shared helpers for the e2e specs: admin API calls and the plaintext answer key.
import { readFileSync } from "node:fs";
import { expect, type APIRequestContext } from "@playwright/test";

export const ADMIN_KEY = process.env.ADMIN_KEY ?? "local-admin-key-0123456789";
export const ADMIN_USERNAME = "admin";

const ANSWERS_PATH = new URL("../../build/truth/all-answers.json", import.meta.url);

type AnswerKey = { cases: Record<string, Record<string, string>> };

const isAnswerKey = (value: unknown): value is AnswerKey =>
  typeof value === "object" && value !== null && "cases" in value && typeof value.cases === "object" && value.cases !== null;

/** Plaintext answer for one stage, from build/truth/all-answers.json (written by ./scripts/build-all.sh). */
export function answerFor(caseId: string, questionId: string): string {
  const parsed: unknown = JSON.parse(readFileSync(ANSWERS_PATH, "utf8"));
  if (!isAnswerKey(parsed)) throw new Error(`Unexpected shape in ${ANSWERS_PATH.pathname}`);
  const answer = parsed.cases[caseId]?.[questionId];
  if (typeof answer !== "string") throw new Error(`No answer for ${caseId}/${questionId} in ${ANSWERS_PATH.pathname}`);
  return answer;
}

export const adminHeaders = { "x-admin-key": ADMIN_KEY };

export function randomUsername(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Makes `caseId` today's incident (and unlocks the catalog so other cases stay playable). */
export async function scheduleToday(request: APIRequestContext, caseId: string): Promise<void> {
  const todayRes = await request.get("/api/today");
  expect(todayRes.status()).toBe(200);
  const { date, timezone } = (await todayRes.json()) as { date: string; timezone: string };
  const res = await request.put("/api/admin/schedule", {
    headers: adminHeaders,
    data: { timezone, defaultCaseId: null, days: { [date]: caseId }, lockToToday: false },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Approves the pending account named `username` through the admin API. */
export async function approveAccount(request: APIRequestContext, username: string): Promise<void> {
  type Row = { accountId: string; username: string };
  // The admin account list is cached for a moment, so a sign-up made right after another spec read it may not be
  // listed yet: wait for it instead of failing on whichever spec happens to run next.
  let account: Row | undefined;
  await expect
    .poll(async () => {
      const listRes = await request.get("/api/admin/accounts", { headers: adminHeaders });
      expect(listRes.status()).toBe(200);
      const { accounts } = (await listRes.json()) as { accounts: Row[] };
      account = accounts.find((a) => a.username === username.toLowerCase());
      return account !== undefined;
    })
    .toBe(true);
  expect(account, `account ${username} should exist`).toBeTruthy();
  const res = await request.post(`/api/admin/accounts/${account?.accountId}/approve`, { headers: adminHeaders, data: {} });
  expect(res.status(), await res.text()).toBe(200);
}
