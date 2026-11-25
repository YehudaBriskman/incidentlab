// Typed client for the instructor/admin endpoints. Every response is parsed with the shared zod contract.
import type { z } from "zod";
import {
  AccountResponseSchema,
  AdminAccountsResponseSchema,
  AdminProgressResponseSchema,
  AdminResetRequestSchema,
  AdminStatsResponseSchema,
  ErrorBodySchema,
  ScheduleResponseSchema,
  ScheduleSchema,
  TodayResponseSchema,
  type AccountView,
  type Schedule,
  type TodayResponse,
} from "../../shared/contract";

const ADMIN_KEY_STORAGE = "il.adminKey";
const FETCH_TIMEOUT_MS = 8000;

export type AdminAccountsResult = z.infer<typeof AdminAccountsResponseSchema>;
export type AdminProgressResult = z.infer<typeof AdminProgressResponseSchema>;
export type AdminStatsResult = z.infer<typeof AdminStatsResponseSchema>;

export class AdminApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export function getAdminKey(): string | null {
  try {
    const value = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setAdminKey(key: string): void {
  try {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  } catch {
    // Storage unavailable (private mode): the key simply won't persist across reloads.
  }
}

export function clearAdminKey(): void {
  try {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    // ignore
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const parsed = ErrorBodySchema.safeParse(body);
    if (parsed.success) return parsed.data.error;
  } catch {
    // non-JSON error body
  }
  return `Request failed (${res.status})`;
}

/** key === null: public endpoint, no X-Admin-Key header. */
async function apiFetch(path: string, key: string | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (key !== null) headers.set("X-Admin-Key", key);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: "no-store", signal: controller.signal });
  } catch {
    throw new AdminApiError(
      0,
      controller.signal.aborted ? "Request timed out" : "Network error: could not reach the server",
    );
  } finally {
    window.clearTimeout(timer);
  }
  if (!res.ok) throw new AdminApiError(res.status, await readErrorMessage(res));
  return res;
}

async function parseJson<S extends z.ZodType>(res: Response, schema: S, path: string): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AdminApiError(res.status, `Invalid JSON from ${path}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AdminApiError(res.status, `Unexpected response shape from ${path}`);
  return parsed.data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const seg = encodeURIComponent;

// ---- public ------------------------------------------------------------------

export async function fetchToday(): Promise<TodayResponse> {
  const path = "/api/today";
  return parseJson(await apiFetch(path, null), TodayResponseSchema, path);
}

// ---- accounts ----------------------------------------------------------------

export async function fetchAccounts(key: string): Promise<AdminAccountsResult> {
  const path = "/api/admin/accounts";
  return parseJson(await apiFetch(path, key), AdminAccountsResponseSchema, path);
}

export async function setAccountStatus(key: string, id: string, action: "approve" | "reject"): Promise<AccountView> {
  const path = `/api/admin/accounts/${seg(id)}/${action}`;
  const body = await parseJson(await apiFetch(path, key, jsonInit("POST", {})), AccountResponseSchema, path);
  return body.account;
}

export async function deleteAccount(key: string, id: string): Promise<void> {
  await apiFetch(`/api/admin/accounts/${seg(id)}`, key, { method: "DELETE" });
}

// ---- live progress -----------------------------------------------------------

export async function fetchProgress(key: string, caseId: string): Promise<AdminProgressResult> {
  const path = `/api/admin/progress?caseId=${seg(caseId)}`;
  return parseJson(await apiFetch(path, key), AdminProgressResponseSchema, "/api/admin/progress");
}

export async function restartPlayerCase(key: string, accountId: string, caseId: string): Promise<void> {
  await apiFetch(`/api/admin/progress/${seg(accountId)}/${seg(caseId)}`, key, { method: "DELETE" });
}

/** Wipes progress for one case (or every case when caseId is omitted). Accounts stay. */
export async function resetProgress(key: string, caseId?: string): Promise<void> {
  const body = AdminResetRequestSchema.parse(caseId === undefined ? { confirm: "RESET" } : { confirm: "RESET", caseId });
  await apiFetch("/api/admin/reset", key, jsonInit("POST", body));
}

// ---- schedule ----------------------------------------------------------------

export async function fetchSchedule(key: string): Promise<Schedule> {
  const path = "/api/admin/schedule";
  return (await parseJson(await apiFetch(path, key), ScheduleResponseSchema, path)).schedule;
}

export async function saveSchedule(key: string, schedule: Schedule): Promise<Schedule> {
  const path = "/api/admin/schedule";
  const local = ScheduleSchema.safeParse(schedule);
  if (!local.success) throw new AdminApiError(400, local.error.issues[0]?.message ?? "Invalid schedule");
  return (await parseJson(await apiFetch(path, key, jsonInit("PUT", local.data)), ScheduleResponseSchema, path)).schedule;
}

// ---- stats -------------------------------------------------------------------

export async function fetchCaseStats(key: string): Promise<AdminStatsResult> {
  const path = "/api/admin/stats";
  return parseJson(await apiFetch(path, key), AdminStatsResponseSchema, path);
}
