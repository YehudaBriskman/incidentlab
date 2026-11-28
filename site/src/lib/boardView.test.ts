import { test } from "node:test";
import assert from "node:assert/strict";
import { indexOfPlayer, nearWindow, searchEntries } from "./boardView.ts";

const board = Array.from({ length: 30 }, (_, i) => ({ rank: i + 1, username: i === 0 ? "Ada Lovelace" : `player${i + 1}` }));
const ranks = (rows: readonly { rank: number }[]): number[] => rows.map((r) => r.rank);

test("search matches part of a name, ignoring case and surrounding space", () => {
  assert.deepEqual(ranks(searchEntries(board, "  ada ")), [1]);
  assert.deepEqual(ranks(searchEntries(board, "LOVE")), [1]);
  assert.deepEqual(ranks(searchEntries(board, "player2")), [2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.equal(searchEntries(board, "").length, 30, "an empty query lists everyone");
  assert.equal(searchEntries(board, "nobody").length, 0);
});

test("the near-me window is ±5 around the player, shifted at the ends of the list", () => {
  assert.deepEqual(nearWindow(board, "player15"), { rows: board.slice(9, 20), index: 5 });
  assert.deepEqual(ranks(nearWindow(board, "player2")?.rows ?? []), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "near the top: still 11 rows");
  assert.equal(nearWindow(board, "player2")?.index, 1);
  assert.deepEqual(ranks(nearWindow(board, "player30")?.rows ?? []), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  assert.equal(nearWindow(board, "player30")?.index, 10);
  assert.deepEqual(ranks(nearWindow(board.slice(0, 4), "player3")?.rows ?? []), [1, 2, 3, 4], "a short board shows all of it");
  assert.equal(nearWindow(board, "someone-else"), null);
  assert.equal(nearWindow(board, null), null);
});

test("the player is found by username key", () => {
  assert.equal(indexOfPlayer(board, "ada lovelace"), 0);
  assert.equal(indexOfPlayer(board, "Ada Lovelace"), -1, "callers pass the key, not the raw name");
});
