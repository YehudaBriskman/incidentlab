// Typed client for the IncidentLab player API (see shared/contract.ts).
// Every response is parsed with the contract's zod schemas; nothing is trusted blindly.
// Auth is an HttpOnly session cookie set by the server: this file never sees or stores a token.
import type { z } from "zod";
import {
  AccountResponseSchema,
  AuthResponseSchema,
  CasesResponseSchema,
  RecoveryCodeResponseSchema,
  RegisterResponseSchema,
  ResetRequestAcceptedSchema,
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
  type ClassSummary,
  type LeaderboardPeriod,
  type LeaderboardResponse,
  type LiveEvent,
  type ProgressView,
  type QuestionId,
  type TodayResponse,
  type UserStats,
} from "../../shared/contract";
import type { CatalogEntry } from "../../shared/catalog";
import { getLang } from "../i18n/i18n";
import { isCacheHit, type ClockSample } from "./clock";
import { shareProgress } from "./progress-bus";
import { runClassOf } from "./case-run";

const rawBase: unknown = import.meta.env["VITE_API_BASE"];
const API_BASE = typeof rawBase === "string" ? rawBase.replace(/\/$/, "") : "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  /**
   * The server's progress when a play write was refused as stale (code "stale", 409) or could not be confirmed
   * (code "unconfirmed": no response, or a 5xx): the view redraws from it instead of re-sending (#202, #203).
   */
  readonly progress: ProgressView | null;
  constructor(
    status: number,
    message: string,
    options: { code?: string | null; retryAfterSeconds?: number | null; progress?: ProgressView | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.progress = options.progress ?? null;
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

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH";

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

async function send(method: HttpMethod, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    credentials: API_BASE ? "include" : "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  // Only GET is retried (network errors and 5xx). A write is sent once: a lost response may hide a write that
  // landed, and re-sending it charged hints and wrong answers twice (#202). Play writes re-read progress instead.
  const retries = method === "GET" ? MAX_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const sentAt = Date.now();
      const res = await fetchOnce(`${API_BASE}${path}`, init);
      reportClock(res, sentAt, Date.now());
      if (res.status >= 500 && attempt < retries) {
        emitConnectivity("retrying");
        await sleep(600 * 2 ** attempt);
        continue;
      }
      emitConnectivity("ok");
      return res;
    } catch (err) {
      if (attempt >= retries) {
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

/** A JSON request parsed with `schema` (also used by lib/class-api.ts). */
export async function request<S extends z.ZodType>(method: HttpMethod, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  return (await requestWithHeaders(method, path, schema, body)).data;
}

/** `request`, plus the response headers (the event poll reads `Cache-Status` and `Age`). */
async function requestWithHeaders<S extends z.ZodType>(
  method: HttpMethod,
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
      progress: parsed.success ? (parsed.data.progress ?? null) : null,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[api] ${path} returned an unexpected shape`, parsed.error.issues);
    throw new ApiError(res.status, "The server sent an unexpected response.");
  }
  return { data: parsed.data, headers: res.headers };
}

/** A POST answered with 204 (also used by lib/class-api.ts). */
export async function requestNoContent(path: string, body: unknown): Promise<void> {
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
/** The account, plus a recovery code when the server just issued one (#174): show it once, never store it. */
export type SignedIn = { account: AccountView; recoveryCode: string | null; joinedClass?: ClassSummary | null };

/**
 * Creates the account (approved at once) and returns its first recovery code. With a class code (#204) the account
 * also joins that class (or asks to), and `joinedClass` names it.
 */
export async function register(registration: Registration): Promise<SignedIn> {
  const body = await request("POST", "/api/auth/register", RegisterResponseSchema, registration);
  return { account: body.account, recoveryCode: body.recoveryCode ?? null, joinedClass: body.class ?? null };
}

/** Signs in. Accounts without a recovery code get their first one here. */
export async function login(credentials: Credentials): Promise<SignedIn> {
  const body = await request("POST", "/api/auth/login", AuthResponseSchema, credentials);
  return { account: body.account, recoveryCode: body.recoveryCode ?? null };
}

/** Forgotten password: the recovery code sets a new password and comes back replaced. Doesn't sign in. */
export async function recoverAccount(input: { username: string; recoveryCode: string; newPassword: string }): Promise<string> {
  return (await request("POST", "/api/auth/recover", RecoveryCodeResponseSchema, input)).recoveryCode;
}

/**
 * No password and no recovery code (#254): asks for a teacher-vouched reset. The answer is the same whether or
 * not the username exists, so this only says the request was received.
 */
export async function requestPasswordReset(username: string): Promise<void> {
  await request("POST", "/api/auth/reset-request", ResetRequestAcceptedSchema, { username });
}

/** Replaces the signed-in player's recovery code (needs the current password). */
export async function regenerateRecoveryCode(input: { currentPassword: string }): Promise<string> {
  return (await request("POST", "/api/me/recovery-code", RecoveryCodeResponseSchema, input)).recoveryCode;
}

/** Starts a guest session (#176), or returns the account of the session the cookie already holds. */
export async function startGuest(): Promise<AccountView> {
  return (await request("POST", "/api/guest", AccountResponseSchema, {})).account;
}

/** Turns the signed-in guest into a full account with the same id (its progress stays). */
/** Turns the signed-in guest into an account (same id, progress kept) and returns its first recovery code. */
export async function upgradeGuest(credentials: Credentials): Promise<SignedIn> {
  const body = await request("POST", "/api/auth/upgrade", AuthResponseSchema, credentials);
  return { account: body.account, recoveryCode: body.recoveryCode ?? null };
}

export async function logout(): Promise<void> {
  await requestNoContent("/api/auth/logout", {});
}

/** The signed-in account, or null when signed out. `/api/session` answers 200 either way, so visitors see no 401. */
export async function fetchMe(): Promise<AccountView | null> {
  return (await fetchSession()).account;
}

/** The session, with the hint whether the account may have private cases to play (#184). */
export async function fetchSession(): Promise<{ account: AccountView | null; privateCases: boolean }> {
  return request("GET", "/api/session", SessionResponseSchema);
}

/** The private cases this session may play (#184): personalised, never cached. */
export async function fetchMyCases(): Promise<CatalogEntry[]> {
  return (await request("GET", "/api/me/cases", CasesResponseSchema)).cases;
}

export async function fetchMyStats(): Promise<UserStats> {
  return (await request("GET", "/api/me/stats", UserStatsResponseSchema)).stats;
}

/** Opts in to or out of the public global leaderboard (#175). Returns the updated account. */
export async function setBoardVisibility(show: boolean): Promise<AccountView> {
  return (await request("PUT", "/api/me/board", AccountResponseSchema, { show })).account;
}

/** Sets a new password (also clears the "must change password" flag after an instructor reset). */
/** Changes the password. After an owner reset (#254) the change also issues a new recovery code: show it once. */
export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<SignedIn> {
  const body = await request("POST", "/api/me/password", AuthResponseSchema, input);
  return { account: body.account, recoveryCode: body.recoveryCode ?? null };
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
/**
 * The public board (CDN-cached, one copy per URL). The query is always built in the same order (caseId, then
 * period) and all time sends no period, so every viewer of a board shares one cached copy (#239).
 */
export async function fetchLeaderboard(caseId: string | null, period: LeaderboardPeriod = "all"): Promise<LeaderboardResponse> {
  const params = new URLSearchParams();
  if (caseId !== null) params.set("caseId", caseId);
  if (period !== "all") params.set("period", period);
  const query = params.toString();
  return request("GET", `/api/leaderboard${query === "" ? "" : `?${query}`}`, LeaderboardResponseSchema);
}

// ---- gameplay (per case) ----------------------------------------------------

/** Every case route carries ?lang= so the server localizes the paid-for hint texts. */
const casePath = (caseId: string, action: string): string => `/api/cases/${encodeURIComponent(caseId)}/${action}?lang=${getLang()}`;
/** A GET play route, with `&run=` while this tab plays the case's class event run (#253, lib/case-run.ts). */
const caseGetPath = (caseId: string, action: string): string => {
  const classId = runClassOf(caseId);
  return classId === null ? casePath(caseId, action) : `${casePath(caseId, action)}&run=${encodeURIComponent(classId)}`;
};
/** A POST play body, with `run` while this tab plays the case's class event run (#253). */
const playBody = <B extends object>(caseId: string, body: B): B | (B & { run: { classId: string } }) => {
  const classId = runClassOf(caseId);
  return classId === null ? body : { ...body, run: { classId } };
};

export async function getProgress(caseId: string): Promise<ProgressView> {
  return (await request("GET", caseGetPath(caseId, "progress"), ProgressResponseSchema)).progress;
}

/**
 * One play write, sent once. Its progress (or the one a stale refusal carries) goes to the other tabs. When no
 * response came back, or a 5xx, the write may still have landed: the progress is re-read and the error carries
 * it (code "unconfirmed"), so the view shows the server's state and the player decides what to do next.
 */
async function caseWrite<T>(caseId: string, write: () => Promise<T>, progressOf: (result: T) => ProgressView): Promise<T> {
  try {
    const result = await write();
    shareProgress(progressOf(result));
    return result;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.progress !== null) {
      shareProgress(err.progress);
      throw err;
    }
    if (err.status !== 0 && err.status < 500) throw err;
    let progress: ProgressView;
    try {
      progress = await getProgress(caseId);
    } catch {
      throw err;
    }
    shareProgress(progress);
    throw new ApiError(err.status, err.message, { code: "unconfirmed", progress });
  }
}

const progressOnly = (body: { progress: ProgressView }): ProgressView => body.progress;

export async function setupDone(caseId: string): Promise<ProgressView> {
  return progressOnly(await caseWrite(caseId, () => request("POST", casePath(caseId, "setup-done"), ProgressResponseSchema, playBody(caseId, {})), progressOnly));
}

export async function submitAnswer(caseId: string, questionId: QuestionId, answer: string): Promise<{ correct: boolean; progress: ProgressView }> {
  return caseWrite(caseId, () => request("POST", casePath(caseId, "answer"), AnswerResponseSchema, playBody(caseId, { questionId, answer })), progressOnly);
}

/** Buys hint `expectedHint` (0-based: the number already shown). The server refuses any other one as stale. */
export async function revealHint(caseId: string, questionId: QuestionId, expectedHint: number): Promise<ProgressView> {
  const body = playBody(caseId, { questionId, expectedHint });
  return progressOnly(await caseWrite(caseId, () => request("POST", casePath(caseId, "hint"), ProgressResponseSchema, body), progressOnly));
}

export async function revealAnswer(caseId: string, questionId: QuestionId): Promise<ProgressView> {
  return progressOnly(await caseWrite(caseId, () => request("POST", casePath(caseId, "reveal"), ProgressResponseSchema, playBody(caseId, { questionId })), progressOnly));
}

/**
 * Pays COMMAND_COST on the active stage (free when already paid for or the case is completed). `expectedStage`
 * is the stage the page shows as active: the server refuses the charge as stale when another one is.
 */
export async function revealCommand(caseId: string, toolId: string, expectedStage: QuestionId): Promise<ProgressView> {
  const body = playBody(caseId, { toolId, expectedStage });
  return progressOnly(await caseWrite(caseId, () => request("POST", casePath(caseId, "reveal-command"), ProgressResponseSchema, body), progressOnly));
}

export async function getDebrief(caseId: string): Promise<string> {
  return (await request("GET", caseGetPath(caseId, "debrief"), DebriefResponseSchema)).markdown;
}
