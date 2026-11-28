// What the leaderboard draws from one cached answer (#239): the top rows, the rows matching a search, or the
// window around the signed-in player. DOM-free, so the rules have unit tests (boardView.test.ts). Every view is
// cut from the one public, CDN-cached list the board already polls: none of them costs a function call.
import { usernameKey } from "../../shared/contract.ts";

/** The fields the views read (a leaderboard entry has them all). */
export type BoardRowLike = { readonly rank: number; readonly username: string };

/** How many rows above and below the player "Jump to me" shows. */
export const NEAR_RADIUS = 5;

/** The rows whose name contains `query` (case-, width- and space-insensitive, like the server's username key). */
export function searchEntries<R extends BoardRowLike>(entries: readonly R[], query: string): R[] {
  const needle = usernameKey(query);
  if (needle === "") return [...entries];
  return entries.filter((e) => usernameKey(e.username).includes(needle));
}

/** The player's position in the list (by username key), or -1 when they are not on it. */
export function indexOfPlayer(entries: readonly BoardRowLike[], key: string | null): number {
  if (key === null) return -1;
  return entries.findIndex((e) => usernameKey(e.username) === key);
}

/**
 * The window around the player: up to `radius` rows above and below, shifted to stay `2 * radius + 1` rows long
 * near either end of the list. Null when the player is not on the list.
 */
export function nearWindow<R extends BoardRowLike>(entries: readonly R[], key: string | null, radius: number = NEAR_RADIUS): { rows: R[]; index: number } | null {
  const index = indexOfPlayer(entries, key);
  if (index < 0) return null;
  const size = 2 * radius + 1;
  const start = Math.max(0, Math.min(index - radius, entries.length - size));
  return { rows: entries.slice(start, start + size), index: index - start };
}
