// Typed client for the IncidentLab player API (see shared/contract.ts).
// Every response is parsed with the contract's zod schemas; nothing is trusted blindly.
// Auth is an HttpOnly session cookie set by the server: this file never sees or stores a token.
import type { z } from "zod";
import {
  AccountResponseSchema,
  SessionResponseSchema,
  AnswerResponseSchema,
  DebriefResponseSchema,
  ErrorBodySchema,
  EventResponseSchema,
  LeaderboardResponseSchema,
  ProgressResponseSchema,
  TodayResponseSchema,
  UserStatsResponseSchema,
  type AccountView,
  type LeaderboardResponse,
  type LiveEvent,
  type ProgressView,
  type QuestionId,
  type TodayResponse,
  type UserStats,
} from "../../shared/contract";
import { getLang } from "../i18n/i18n";
import { isCacheHit, type ClockSample } from "./clock";

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
  /** Signed in, but the gate has to run again (new password needed, or this is the admin session). */
  get needsGate(): boolean {
    return this.status === 403 && (this.code === "password-change-required" || this.code === "admin");
  }
  /** During an event that enforces its window: answers, hints and command reveals are refused. */
  get isEventClosed(): boolean {
    return this.status === 403 && this.code === "event-closed";
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

/** Server-clock readings from responses the origin answered (not the CDN), taken from their `Date` header. */
const clockListeners = new Set<(sample: ClockSample) => void>();
export function onServerClock(fn: (sample: ClockSample) => void): void {
  clockListeners.add(fn);
}
function reportClock(res: Response, sentAt: number, receivedAt: number): void {
  if (clockListeners.size === 0 || isCacheHit(res.headers.get("cache-status"))) return;
  const date = Date.parse(res.headers.get("date") ?? "");
  // `Date` has whole seconds: +500 ms puts the reading in the middle of its second.
  if (Number.isFinite(date)) for (const fn of clockListeners) fn({ serverMs: date + 500, sentAt, receivedAt });
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

async function send(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    credentials: API_BASE ? "include" : "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  // Retries: GET on network errors and 5xx; POST and PUT only when no response was received at all.
  for (let attempt = 0; ; attempt++) {
    try {
      const sentAt = Date.now();
      const res = await fetchOnce(`${API_BASE}${path}`, init);
      reportClock(res, sentAt, Date.now());
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

async function request<S extends z.ZodType>(method: "GET" | "POST" | "PUT", path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  return (await requestWithHeaders(method, path, schema, body)).data;
}

/** `request`, plus the response headers (the event poll reads `Cache-Status` and `Age`). */
async function requestWithHeaders<S extends z.ZodType>(
  method: "GET" | "POST" | "PUT",
  path: string,
  schema: S,
  body?: unknown,
): Promise<{ data: z.infer<S>; headers: Headers }> {
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
  return { data: parsed.data, headers: res.headers };
}

async function requestNoContent(path: string, body: unknown): Promise<void> {
  const res = await send("POST", path, body);
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(await readJson(res));
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `Request failed (${res.status})`, {
      code: parsed.success ? (parsed.data.code ?? null) : null,
    });
  }
}

// ---- account / session ------------------------------------------------------

type Credentials = { username: string; password: string };
/** Sign-up also sends the bot checks (#173): the hidden `website` field and how long the form was open. */
type Registration = Credentials & { inviteCode?: string; website?: string; elapsedMs?: number };

/** Creates the account (approved at once since #173). */
export async function register(registration: Registration): Promise<AccountView> {
  return (await request("POST", "/api/auth/register", AccountResponseSchema, registration)).account;
}

export async function login(credentials: Credentials): Promise<AccountView> {
  return (await request("POST", "/api/auth/login", AccountResponseSchema, credentials)).account;
}

export async function logout(): Promise<void> {
  await requestNoContent("/api/auth/logout", {});
}

/** The signed-in account, or null when signed out. `/api/session` answers 200 either way, so visitors see no 401. */
export async function fetchMe(): Promise<AccountView | null> {
  return (await request("GET", "/api/session", SessionResponseSchema)).account;
}

export async function fetchMyStats(): Promise<UserStats> {
  return (await request("GET", "/api/me/stats", UserStatsResponseSchema)).stats;
}

/** Opts in to or out of the public global leaderboard (#175). Returns the updated account. */
export async function setBoardVisibility(show: boolean): Promise<AccountView> {
  return (await request("PUT", "/api/me/board", AccountResponseSchema, { show })).account;
}

/** Sets a new password (also clears the "must change password" flag after an instructor reset). */
export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<AccountView> {
  return (await request("POST", "/api/me/password", AccountResponseSchema, input)).account;
}

/** A plain request to the API with the session cookie (the upload client parses the responses itself). */
export function rawApiFetch(path: string, init: { method: string; headers: Readonly<Record<string, string>>; body?: BodyInit }): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { method: init.method, headers: init.headers, body: init.body, credentials: API_BASE ? "include" : "same-origin" });
}

/** A public GET validated with `schema` (DB-stored case catalog and content, see content/db-cases.ts). */
export async function fetchPublic<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  return request("GET", path, schema);
}

export async function fetchToday(): Promise<TodayResponse> {
  return request("GET", "/api/today", TodayResponseSchema);
}

/**
 * The live event (public, CDN-cached for a few seconds). `serverTime` lets the client correct its clock for
 * countdowns; `cacheHit` and `age` say how old that time is (see lib/clock.ts responseServerMs).
 */
export async function fetchEvent(): Promise<{ event: LiveEvent; serverTime: string; cacheHit: boolean; age: string | null }> {
  const { data, headers } = await requestWithHeaders("GET", "/api/event", EventResponseSchema);
  return { ...data, cacheHit: isCacheHit(headers.get("cache-status")), age: headers.get("age") };
}

/** Public leaderboard: overall when `caseId` is null, else for that case. */
export async function fetchLeaderboard(caseId: string | null): Promise<LeaderboardResponse> {
  const query = caseId === null ? "" : `?caseId=${encodeURIComponent(caseId)}`;
  return request("GET", `/api/leaderboard${query}`, LeaderboardResponseSchema);
}

// ---- gameplay (per case) ----------------------------------------------------

/** Every case route carries ?lang= so the server localizes the paid-for hint texts. */
const casePath = (caseId: string, action: string): string => `/api/cases/${encodeURIComponent(caseId)}/${action}?lang=${getLang()}`;

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

/** Pays COMMAND_COST on the active stage (free when already paid for or the case is completed). */
export async function revealCommand(caseId: string, toolId: string): Promise<ProgressView> {
  return (await request("POST", casePath(caseId, "reveal-command"), ProgressResponseSchema, { toolId })).progress;
}

export async function getDebrief(caseId: string): Promise<string> {
  return (await request("GET", casePath(caseId, "debrief"), DebriefResponseSchema)).markdown;
}
