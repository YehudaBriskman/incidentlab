// Pure logic for the leaderboard poll (#242): no DOM, no imports at runtime, unit-tested in node with injected time.
//
// Every open board is a function call per CDN window, so it polls only as often as anyone can notice:
// - every 10 s while an event is live (the global event on the global board, the class event on a class board
//   and its projector), every 60 s otherwise, and right at the moment an upcoming event starts;
// - not at all while the tab is hidden;
// - not at all after 15 minutes with no pointer or key input (the board shows "Paused" with a Resume button),
//   except a projector during a live event, which is watched, not touched.
import type { LeaderboardResponse } from "../../shared/contract";

export const BOARD_POLL_LIVE_MS = 10_000;
export const BOARD_POLL_QUIET_MS = 60_000;
export const BOARD_IDLE_PAUSE_MS = 15 * 60_000;

export type BoardPollInput = {
  readonly hidden: boolean;
  /** an event (the one this board follows) is running now */
  readonly eventLive: boolean;
  /** ms until that event starts, or null when none is upcoming */
  readonly msUntilStart: number | null;
  readonly projector: boolean;
  readonly nowMs: number;
  /** the last pointer or key input on the page (or the moment the board opened or was resumed) */
  readonly lastInputMs: number;
};

export type BoardPollDecision =
  | { readonly kind: "wait"; readonly delayMs: number }
  /** the tab is hidden: no timer, the next visibilitychange polls */
  | { readonly kind: "hidden" }
  /** idle too long: no timer until the viewer resumes */
  | { readonly kind: "paused" };

export function boardPollDecision(input: BoardPollInput): BoardPollDecision {
  if (input.hidden) return { kind: "hidden" };
  const watched = input.projector && input.eventLive;
  if (!watched && input.nowMs - input.lastInputMs >= BOARD_IDLE_PAUSE_MS) return { kind: "paused" };
  if (input.eventLive) return { kind: "wait", delayMs: BOARD_POLL_LIVE_MS };
  // An upcoming start: poll right when it goes live instead of up to a minute later.
  const untilStart = input.msUntilStart !== null && input.msUntilStart > 0 ? input.msUntilStart : Infinity;
  return { kind: "wait", delayMs: Math.max(1_000, Math.min(BOARD_POLL_QUIET_MS, untilStart)) };
}

/** FNV-1a (32 bit) of a string, as 8 hex digits: cheap and stable, enough to tell "same board" from "changed". */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A stable hash of what the board draws: scope, freeze and every row. `generatedAt` is left out on purpose, so a
 * poll that brings the same standings changes nothing on screen (no flicker of the table or the "Updated" line).
 */
export function boardSignature(data: LeaderboardResponse): string {
  const rows = data.entries.map((e) => [e.rank, e.username, e.score, e.stagesSolved, e.casesCompleted, e.firstBloods]);
  return fnv1a(JSON.stringify([data.caseId, data.frozen, data.frozenAt ?? null, rows]));
}
