// Typed client for the instructor/admin endpoints. Every response is parsed with the shared zod contract.
// Auth: every request carries the session cookie (credentials "same-origin"); the X-Admin-Key header is added
// only when an admin key was entered in this tab. The server accepts either (a bad header is never ignored).
import type { z } from "zod";
import {
  AccountResponseSchema,
  AdminAccountsResponseSchema,
  AdminProgressResponseSchema,
  AdminResetRequestSchema,
  AdminStatsResponseSchema,
  ApproveAllResponseSchema,
  AuditResponseSchema,
  ErrorBodySchema,
  EventResponseSchema,
  EventSchema,
  ResetPasswordResponseSchema,
  ScheduleResponseSchema,
  ScheduleSchema,
  SettingsResponseSchema,
  SettingsSchema,
  TodayResponseSchema,
  type AccountView,
  type AuditEntry,
  type LiveEvent,
  type Schedule,
  type Settings,
  type TodayResponse,
} from "../../shared/contract";

const ADMIN_KEY_STORAGE = "il.adminKey";
const FETCH_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 30000;

export type AdminAccountsResult = z.infer<typeof AdminAccountsResponseSchema>;
export type AdminProgressResult = z.infer<typeof AdminProgressResponseSchema>;
export type AdminStatsResult = z.infer<typeof AdminStatsResponseSchema>;
export type AdminEventResult = z.infer<typeof EventResponseSchema>;

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

/** admin: true adds X-Admin-Key when a key was entered in this tab. The session cookie is always sent. */
async function apiFetch(path: string, opts: { admin: boolean; init?: RequestInit; timeoutMs?: number }): Promise<Response> {
  const init = opts.init ?? {};
  const headers = new Headers(init.headers);
  const key = opts.admin ? getAdminKey() : null;
  if (key !== null) headers.set("X-Admin-Key", key);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal });
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

const adminFetch = (path: string, init?: RequestInit): Promise<Response> => apiFetch(path, { admin: true, init });

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

// ---- public / session ----------------------------------------------------------

export async function fetchToday(): Promise<TodayResponse> {
  const path = "/api/today";
  return parseJson(await apiFetch(path, { admin: false }), TodayResponseSchema, path);
}

/** The signed-in account from the session cookie, or null when nobody is signed in (401). */
export async function fetchMe(): Promise<AccountView | null> {
  const path = "/api/me";
  try {
    return (await parseJson(await apiFetch(path, { admin: false }), AccountResponseSchema, path)).account;
  } catch (err: unknown) {
    if (err instanceof AdminApiError && err.status === 401) return null;
    throw err;
  }
}

/** Ends the cookie session (admin signed in on the sign-in page). */
export async function logoutSession(): Promise<void> {
  await apiFetch("/api/auth/logout", { admin: false, init: jsonInit("POST", {}) });
}

// ---- accounts ----------------------------------------------------------------

export async function fetchAccounts(): Promise<AdminAccountsResult> {
  const path = "/api/admin/accounts";
  return parseJson(await adminFetch(path), AdminAccountsResponseSchema, path);
}

export async function setAccountStatus(id: string, action: "approve" | "reject"): Promise<AccountView> {
  const path = `/api/admin/accounts/${seg(id)}/${action}`;
  const body = await parseJson(await adminFetch(path, jsonInit("POST", {})), AccountResponseSchema, path);
  return body.account;
}

export async function approveAll(): Promise<number> {
  const path = "/api/admin/accounts/approve-all";
  return (await parseJson(await adminFetch(path, jsonInit("POST", {})), ApproveAllResponseSchema, path)).approved;
}

/** Signs the player out and forces a password change at their next sign-in. Returns the one-time password. */
export async function resetAccountPassword(id: string): Promise<string> {
  const path = `/api/admin/accounts/${seg(id)}/reset-password`;
  return (await parseJson(await adminFetch(path, jsonInit("POST", {})), ResetPasswordResponseSchema, "/api/admin/accounts/:id/reset-password"))
    .temporaryPassword;
}

export async function deleteAccount(id: string): Promise<void> {
  await adminFetch(`/api/admin/accounts/${seg(id)}`, { method: "DELETE" });
}

// ---- live progress -----------------------------------------------------------

export async function fetchProgress(caseId: string): Promise<AdminProgressResult> {
  const path = `/api/admin/progress?caseId=${seg(caseId)}`;
  return parseJson(await adminFetch(path), AdminProgressResponseSchema, "/api/admin/progress");
}

export async function restartPlayerCase(accountId: string, caseId: string): Promise<void> {
  await adminFetch(`/api/admin/progress/${seg(accountId)}/${seg(caseId)}`, { method: "DELETE" });
}

/** Wipes progress for one case (or every case when caseId is omitted). Accounts stay. */
export async function resetProgress(caseId?: string): Promise<void> {
  const body = AdminResetRequestSchema.parse(caseId === undefined ? { confirm: "RESET" } : { confirm: "RESET", caseId });
  await adminFetch("/api/admin/reset", jsonInit("POST", body));
}

// ---- schedule ----------------------------------------------------------------

export async function fetchSchedule(): Promise<Schedule> {
  const path = "/api/admin/schedule";
  return (await parseJson(await adminFetch(path), ScheduleResponseSchema, path)).schedule;
}

export async function saveSchedule(schedule: Schedule): Promise<Schedule> {
  const path = "/api/admin/schedule";
  const local = ScheduleSchema.safeParse(schedule);
  if (!local.success) throw new AdminApiError(400, local.error.issues[0]?.message ?? "Invalid schedule");
  return (await parseJson(await adminFetch(path, jsonInit("PUT", local.data)), ScheduleResponseSchema, path)).schedule;
}

// ---- settings (class invite code) ---------------------------------------------

export async function fetchSettings(): Promise<Settings> {
  const path = "/api/admin/settings";
  return (await parseJson(await adminFetch(path), SettingsResponseSchema, path)).settings;
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const path = "/api/admin/settings";
  const local = SettingsSchema.safeParse(settings);
  if (!local.success) throw new AdminApiError(400, local.error.issues[0]?.message ?? "Invalid settings");
  return (await parseJson(await adminFetch(path, jsonInit("PUT", local.data)), SettingsResponseSchema, path)).settings;
}

// ---- live event --------------------------------------------------------------

export async function fetchEvent(): Promise<AdminEventResult> {
  const path = "/api/admin/event";
  return parseJson(await adminFetch(path), EventResponseSchema, path);
}

export async function saveEvent(event: LiveEvent): Promise<AdminEventResult> {
  const path = "/api/admin/event";
  const local = EventSchema.safeParse(event);
  if (!local.success) {
    const issue = local.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new AdminApiError(400, issue ? `${where}${issue.message}` : "Invalid event");
  }
  return parseJson(await adminFetch(path, jsonInit("PUT", local.data)), EventResponseSchema, path);
}

// ---- stats, audit, export -----------------------------------------------------

export async function fetchCaseStats(): Promise<AdminStatsResult> {
  const path = "/api/admin/stats";
  return parseJson(await adminFetch(path), AdminStatsResponseSchema, path);
}

export async function fetchAudit(limit = 100): Promise<AuditEntry[]> {
  const path = `/api/admin/audit?limit=${limit}`;
  return (await parseJson(await adminFetch(path), AuditResponseSchema, "/api/admin/audit")).entries;
}

/** Downloads the results CSV with the same auth as every other admin call. */
export async function fetchExportCsv(): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetch("/api/admin/export.csv", { admin: true, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const fallback = `incidentlab-results-${new Date().toISOString().slice(0, 10)}.csv`;
  return { blob: await res.blob(), filename: match?.[1] ?? fallback };
}
