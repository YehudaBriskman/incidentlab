// Typed client for the instructor/admin endpoints. Every response is parsed with the shared zod contract.
import {
  AdminPlayersResponseSchema,
  AdminResetRequestSchema,
  ErrorBodySchema,
  type AdminPlayer,
} from "../../shared/contract";

const ADMIN_KEY_STORAGE = "il.adminKey";
const FETCH_TIMEOUT_MS = 8000;

export type AdminPlayersResult = { generatedAt: string; players: AdminPlayer[] };

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

async function adminFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Admin-Key", key);
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

export async function fetchAdminPlayers(key: string): Promise<AdminPlayersResult> {
  const res = await adminFetch("/api/admin/players", key);
  const body: unknown = await res.json();
  const parsed = AdminPlayersResponseSchema.safeParse(body);
  if (!parsed.success) throw new AdminApiError(res.status, "Unexpected response shape from /api/admin/players");
  return parsed.data;
}

export async function deleteAdminPlayer(key: string, id: string): Promise<void> {
  await adminFetch(`/api/admin/players/${encodeURIComponent(id)}`, key, { method: "DELETE" });
}

export async function resetAllPlayers(key: string): Promise<void> {
  const body = AdminResetRequestSchema.parse({ confirm: "RESET" });
  await adminFetch("/api/admin/reset", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
