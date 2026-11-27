// Page-load recovery (#208, #209), DOM-free so it runs under `npm run test:client`.
// - A route chunk from an older deploy is gone after a new one: the page reloads once (a sessionStorage guard
//   stops a loop), and a second failure shows the "couldn't load" card instead.
// - Load failures are classified so the router shows the right card: a 404 only for a page that truly does not
//   exist, the "couldn't load" card (with Try again) for offline, server errors and failed chunks.
import { z } from "zod";

/** The part of the Web Storage API the guard needs (sessionStorage in the browser, a stub in tests). */
export type GuardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const RELOAD_GUARD_KEY = "incidentlab.chunkReload";
/** A guard older than this is stale (a later deploy in the same tab may reload once again). */
export const RELOAD_GUARD_TTL_MS = 10 * 60 * 1000;

/**
 * Claims the one automatic reload. True: the caller reloads now (the guard is set). False: a reload already
 * happened recently, or storage is unavailable (no guard means no reload: never risk a loop).
 */
export function claimReload(storage: GuardStorage | null, now: number): boolean {
  if (storage === null) return false;
  try {
    const at = Number(storage.getItem(RELOAD_GUARD_KEY));
    if (Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < RELOAD_GUARD_TTL_MS) return false;
    storage.setItem(RELOAD_GUARD_KEY, String(now));
    return storage.getItem(RELOAD_GUARD_KEY) === String(now);
  } catch {
    return false;
  }
}

/** A route's code loaded: the next stale chunk may reload again. */
export function clearReloadGuard(storage: GuardStorage | null): void {
  try {
    storage?.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // storage blocked: nothing to clear
  }
}

// What browsers and Vite say when a dynamic import or its preload fails (Chromium, Firefox, Safari, Vite).
const CHUNK_MESSAGES = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /failed to load module script/i,
  /'text\/html' is not a valid javascript mime type/i,
];

const MessageSchema = z.object({ message: z.string() });
const StatusSchema = z.object({ status: z.number() });

/** True when `err` is a failed chunk load (a dynamic import or one of its preloads). */
export function isChunkLoadError(err: unknown): boolean {
  const parsed = MessageSchema.safeParse(err);
  return parsed.success && CHUNK_MESSAGES.some((re) => re.test(parsed.data.message));
}

/**
 * Why a page could not load:
 * - "offline": the browser is offline, or no response arrived (an API error with status 0);
 * - "chunk": its code is missing (a new deploy), handled by the one-time reload;
 * - "server": the API answered with a 5xx;
 * - "other": anything else (still the "couldn't load" card, never a 404).
 */
export type LoadFailure = "chunk" | "offline" | "server" | "other";

export function classifyLoadError(err: unknown, online: boolean): LoadFailure {
  // Offline first: a chunk fetch fails offline too, and reloading then would only show the browser's error page.
  if (!online) return "offline";
  if (isChunkLoadError(err)) return "chunk";
  const status = StatusSchema.safeParse(err);
  if (status.success && status.data.status === 0) return "offline";
  if (status.success && status.data.status >= 500) return "server";
  return "other";
}
