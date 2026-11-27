// Pure rules for keeping a case page's progress in step with the server and the player's other tabs (#203).
// The DOM side (BroadcastChannel, visibilitychange) is in progress-bus.ts.
import { z } from "zod";
import { ProgressViewSchema, QUESTION_ORDER, type ProgressView } from "../../shared/contract.ts";

/** A tab that becomes visible again re-reads progress at most this often (function calls are the budget). */
export const REFETCH_FLOOR_MS = 15_000;

/** True when the last authoritative progress is old enough to be worth a fresh GET. */
export function shouldRefetch(lastSyncedAt: number, now: number, floorMs: number = REFETCH_FLOOR_MS): boolean {
  return now - lastSyncedAt >= floorMs;
}

/** What one tab posts to the others after a write: the server's progress, and the language of its paid texts. */
export const SyncMessageSchema = z.object({
  kind: z.literal("progress"),
  lang: z.enum(["en", "he"]),
  progress: ProgressViewSchema,
});
export type SyncMessage = z.infer<typeof SyncMessageSchema>;

/** A message from another tab, or null when it isn't one (never trusted unparsed). */
export function parseSyncMessage(data: unknown): SyncMessage | null {
  const parsed = SyncMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * How far a progress has got. Play only moves forward (hints, commands and wrong answers add up, stages finish),
 * so a message that weighs less than what a tab shows is an older one that arrived late. An admin reset lowers it;
 * that is only ever learned from the server itself, never from another tab.
 */
export function progressWeight(p: ProgressView): number {
  let weight = (p.setupDoneAt === null ? 0 : 1) + (p.completedAt === null ? 0 : 1);
  for (const q of QUESTION_ORDER) {
    const s = p.stages[q];
    if (s === undefined) continue;
    weight += s.hintsRevealed + s.wrongAttempts + s.commandsRevealed + (s.status === "solved" || s.status === "revealed" ? 1 : 0);
  }
  return weight;
}

/** The same state (the view redraws only when something changed, so typing is not interrupted for nothing). */
export function sameProgress(a: ProgressView, b: ProgressView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type IncomingDecision = "ignore" | "apply" | "refetch";

/**
 * What a tab showing `current` (in `lang`) does with another tab's message: ignore it (another case or account,
 * older or the same), apply it, or re-read from the server when its paid texts are in the other language.
 */
export function decideIncoming(current: ProgressView, lang: string, message: SyncMessage): IncomingDecision {
  const next = message.progress;
  if (next.caseId !== current.caseId || next.accountId !== current.accountId) return "ignore";
  if (progressWeight(next) <= progressWeight(current)) return "ignore";
  return message.lang === lang ? "apply" : "refetch";
}
