// Typed client for the IncidentLab player API (see shared/contract.ts).
// Every response is parsed with the contract's zod schemas; nothing is trusted blindly.
import type { z } from "zod";
import {
  AnswerResponseSchema,
  CreatePlayerResponseSchema,
  DebriefResponseSchema,
  ErrorBodySchema,
  MeResponseSchema,
  PlayerResponseSchema,
  type PlayerView,
  type QuestionId,
} from "../../shared/contract";

const TOKEN_KEY = "il.token";
const rawBase: unknown = import.meta.env["VITE_API_BASE"];
const API_BASE = typeof rawBase === "string" ? rawBase.replace(/\/$/, "") : "";

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(status: number, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: token lives only for this page load */
  }
  memoryToken = token;
}

export function clearToken(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

let memoryToken: string | null = null;
const currentToken = (): string | null => getToken() ?? memoryToken;

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
    throw new ApiError(0, "Can't reach the IncidentLab server. Check your connection and try again.", null);
  } finally {
    window.clearTimeout(timer);
  }
}

async function request<S extends z.ZodType>(
  method: "GET" | "POST",
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = currentToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };

  // Retries: GET on network errors and 5xx; POST only when no response was received at all.
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchOnce(`${API_BASE}${path}`, init);
      if (method === "GET" && res.status >= 500 && attempt < MAX_RETRIES) {
        emitConnectivity("retrying");
        await sleep(600 * 2 ** attempt);
        continue;
      }
      emitConnectivity("ok");
      break;
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        emitConnectivity("unreachable");
        throw err;
      }
      emitConnectivity("retrying");
      await sleep(600 * 2 ** attempt);
    }
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(json);
    const header = Number(res.headers.get("Retry-After"));
    const retry = parsed.success && parsed.data.retryAfterSeconds !== undefined
      ? parsed.data.retryAfterSeconds
      : Number.isFinite(header) && header > 0 ? header : null;
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `Request failed (${res.status})`, retry);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[api] ${path} returned an unexpected shape`, parsed.error.issues);
    throw new ApiError(res.status, "The server sent an unexpected response.", null);
  }
  return parsed.data;
}

export async function createPlayer(name: string): Promise<PlayerView> {
  const data = await request("POST", "/api/players", CreatePlayerResponseSchema, { name, caseId: "3am-outage" });
  setToken(data.token);
  return data.player;
}

export async function getMe(): Promise<PlayerView> {
  return (await request("GET", "/api/me", MeResponseSchema)).player;
}

export async function setupDone(): Promise<PlayerView> {
  return (await request("POST", "/api/setup-done", PlayerResponseSchema, {})).player;
}

export async function submitAnswer(questionId: QuestionId, answer: string): Promise<{ correct: boolean; player: PlayerView }> {
  return request("POST", "/api/answer", AnswerResponseSchema, { questionId, answer });
}

export async function revealHint(questionId: QuestionId): Promise<PlayerView> {
  return (await request("POST", "/api/hint", PlayerResponseSchema, { questionId })).player;
}

export async function revealAnswer(questionId: QuestionId): Promise<PlayerView> {
  return (await request("POST", "/api/reveal", PlayerResponseSchema, { questionId })).player;
}

export async function getDebrief(): Promise<string> {
  return (await request("GET", "/api/debrief", DebriefResponseSchema)).markdown;
}
