// Typed client for the IncidentLab player API (see shared/contract.ts).
// Every response is parsed with the contract's zod schemas; nothing is trusted blindly.
// Auth is an HttpOnly session cookie set by the server: this file never sees or stores a token.
import type { z } from "zod";
import {
  AccountResponseSchema,
  AnswerResponseSchema,
  DebriefResponseSchema,
  ErrorBodySchema,
  ProgressResponseSchema,
  TodayResponseSchema,
  UserStatsResponseSchema,
  type AccountView,
  type ProgressView,
  type QuestionId,
  type TodayResponse,
  type UserStats,
} from "../../shared/contract";

const rawBase: unknown = import.meta.env["VITE_API_BASE"];
const API_BASE = typeof rawBase === "string" ? rawBase.replace(/\/$/, "") : "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  constructor(status: number, message: string, options: { code?: string | null; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  /** Signed in, but the instructor hasn't approved (or has rejected) the account. */
  get isNotApproved(): boolean {
    return this.status === 403 && (this.code === "pending" || this.code === "rejected");
  }
}

export type Connectivity = "ok" | "retrying" | "unreachable";
const connectivityListeners = new Set<(state: Connectivity) => void>();
/** Subscribe to connectivity changes (used for the global "server unreachable" banner). */
export function onConnectivity(fn: (state: Connectivity) => void): void {
  connectivityListeners.add(fn);
}
function emitConnectivity(state: Connectivity): void {
  for (const fn of connectivityListeners) fn(state);
}

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** One fetch with a hard timeout. Throws ApiError(0) when no response arrives. */
async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new ApiError(0, "Can't reach the IncidentLab server. Check your connection and try again.");
  } finally {
    window.clearTimeout(timer);
  }
}

async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    credentials: API_BASE ? "include" : "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  // Retries: GET on network errors and 5xx; POST only when no response was received at all.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchOnce(`${API_BASE}${path}`, init);
      if (method === "GET" && res.status >= 500 && attempt < MAX_RETRIES) {
        emitConnectivity("retrying");
        await sleep(600 * 2 ** attempt);
        continue;
      }
      emitConnectivity("ok");
      return res;
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        emitConnectivity("unreachable");
        throw err;
      }
      emitConnectivity("retrying");
      await sleep(600 * 2 ** attempt);
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    const value: unknown = await res.json();
    return value;
  } catch {
    return null;
  }
}

async function request<S extends z.ZodType>(method: "GET" | "POST", path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const res = await send(method, path, body);
  const json = await readJson(res);
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(json);
    const header = Number(res.headers.get("Retry-After"));
    const retry =
      parsed.success && parsed.data.retryAfterSeconds !== undefined ? parsed.data.retryAfterSeconds : Number.isFinite(header) && header > 0 ? header : null;
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `Request failed (${res.status})`, {
      code: parsed.success ? (parsed.data.code ?? null) : null,
      retryAfterSeconds: retry,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[api] ${path} returned an unexpected shape`, parsed.error.issues);
    throw new ApiError(res.status, "The server sent an unexpected response.");
  }
  return parsed.data;
}

async function requestNoContent(path: string, body: unknown): Promise<void> {
  const res = await send("POST", path, body);
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(await readJson(res));
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `Request failed (${res.status})`);
  }
}

// ---- account / session ------------------------------------------------------

type Credentials = { username: string; password: string };

export async function register(credentials: Credentials): Promise<AccountView> {
  return (await request("POST", "/api/auth/register", AccountResponseSchema, credentials)).account;
}

export async function login(credentials: Credentials): Promise<AccountView> {
  return (await request("POST", "/api/auth/login", AccountResponseSchema, credentials)).account;
}

export async function logout(): Promise<void> {
  await requestNoContent("/api/auth/logout", {});
}

/** The signed-in account, or null when signed out. */
export async function fetchMe(): Promise<AccountView | null> {
  try {
    return (await request("GET", "/api/me", AccountResponseSchema)).account;
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return null;
    throw err;
  }
}

export async function fetchMyStats(): Promise<UserStats> {
  return (await request("GET", "/api/me/stats", UserStatsResponseSchema)).stats;
}

export async function fetchToday(): Promise<TodayResponse> {
  return request("GET", "/api/today", TodayResponseSchema);
}

// ---- gameplay (per case) ----------------------------------------------------

const casePath = (caseId: string, action: string): string => `/api/cases/${encodeURIComponent(caseId)}/${action}`;

export async function getProgress(caseId: string): Promise<ProgressView> {
  return (await request("GET", casePath(caseId, "progress"), ProgressResponseSchema)).progress;
}

export async function setupDone(caseId: string): Promise<ProgressView> {
  return (await request("POST", casePath(caseId, "setup-done"), ProgressResponseSchema, {})).progress;
}

export async function submitAnswer(caseId: string, questionId: QuestionId, answer: string): Promise<{ correct: boolean; progress: ProgressView }> {
  return request("POST", casePath(caseId, "answer"), AnswerResponseSchema, { questionId, answer });
}

export async function revealHint(caseId: string, questionId: QuestionId): Promise<ProgressView> {
  return (await request("POST", casePath(caseId, "hint"), ProgressResponseSchema, { questionId })).progress;
}

export async function revealAnswer(caseId: string, questionId: QuestionId): Promise<ProgressView> {
  return (await request("POST", casePath(caseId, "reveal"), ProgressResponseSchema, { questionId })).progress;
}

export async function getDebrief(caseId: string, lang: "en" | "he"): Promise<string> {
  return (await request("GET", `${casePath(caseId, "debrief")}?lang=${lang}`, DebriefResponseSchema)).markdown;
}
