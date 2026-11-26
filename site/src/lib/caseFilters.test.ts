import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFilterCount, matchesFilters, parseFilters, serializeFilters, topTags, type FilterableCase } from "./caseFilters.ts";

const ghost: FilterableCase = { id: "ghost", title: "Ghost in the Network", subtitle: "DNS goes dark", difficulty: "hard", tags: ["dns", "network"] };
const prod: FilterableCase = { id: "prod", title: "Who deleted prod?", subtitle: "A missing database", difficulty: "easy", tags: ["git"] };

test("parse and serialize round-trip, dropping unknown values", () => {
  const f = parseFilters(new URLSearchParams("q=ghost&difficulty=hard,bogus&tag=dns&tag=git&status=completed&status=nope&sort=hard"));
  assert.deepEqual([...f.difficulty], ["hard"]);
  assert.deepEqual([...f.status], ["completed"]);
  assert.equal(f.sort, "hard");
  assert.equal(serializeFilters(f), "q=ghost&difficulty=hard&tag=dns&tag=git&status=completed&sort=hard");
  assert.equal(serializeFilters(parseFilters(new URLSearchParams(serializeFilters(f)))), serializeFilters(f));
  assert.equal(activeFilterCount(f), 4);
  assert.equal(parseFilters(new URLSearchParams("sort=<script>")).sort, "");
  assert.equal(parseFilters(new URLSearchParams("sort=minutes:desc")).sort, "minutes:desc");
  assert.equal(serializeFilters(parseFilters(new URLSearchParams(""))), "");
});

test("matchesFilters: search words, OR inside a group, AND across groups", () => {
  const f = (qs: string) => parseFilters(new URLSearchParams(qs));
  assert.equal(matchesFilters(ghost, null, f("q=ghost dns")), true);
  assert.equal(matchesFilters(ghost, null, f("q=ghost git")), false);
  assert.equal(matchesFilters(ghost, null, f("difficulty=easy&difficulty=hard")), true);
  assert.equal(matchesFilters(prod, null, f("difficulty=hard")), false);
  assert.equal(matchesFilters(prod, null, f("tag=dns&tag=git")), true);
  assert.equal(matchesFilters(prod, null, f("tag=dns&difficulty=easy")), false);
  assert.equal(matchesFilters(ghost, "in-progress", f("status=completed")), false);
  assert.equal(matchesFilters(ghost, null, f("status=completed")), true); // signed out: status ignored
});

test("topTags orders by use, then name", () => {
  assert.deepEqual(topTags([ghost, prod, { tags: ["dns"] }]), ["dns", "git", "network"]);
  assert.deepEqual(topTags([ghost, prod], 1), ["dns"]);
});
