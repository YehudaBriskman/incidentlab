// Short-lived copies of public, non-personal API responses (today's case, the live event) in localStorage, so
// the header can draw its live strip on the first paint instead of shifting the page when the fetch returns.
// Every read is validated and age-capped; a stale or corrupt copy is ignored, and the live fetch always wins.
import type { z } from "zod";

const PREFIX = "il.snap.";

export function readSnapshot<S extends z.ZodType>(key: string, schema: S, maxAgeMs: number, now = Date.now()): z.infer<S> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("at" in parsed) || !("value" in parsed)) return null;
    const at = parsed.at;
    if (typeof at !== "number" || now - at > maxAgeMs || at > now + 60_000) return null;
    const result = schema.safeParse(parsed.value);
    return result.success ? result.data : null;
  } catch {
    return null; // storage blocked or bad JSON: behave as if nothing was saved
  }
}

export function writeSnapshot(key: string, value: unknown, now = Date.now()): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: now, value }));
  } catch {
    /* storage blocked or full: the snapshot is an optimisation only */
  }
}
