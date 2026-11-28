import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStartHere, type StartHereCandidate } from "./startHere.ts";

const c = (id: string, difficulty: StartHereCandidate["difficulty"], estMinutes: number, tags: string[] = []): StartHereCandidate => ({
  id,
  title: id,
  difficulty,
  estMinutes,
  tags,
});

test("a case tagged tutorial wins over an easier or shorter one", () => {
  const cases = [c("easy-short", "easy", 10), c("tut", "medium", 15, ["intro", "Tutorial"])];
  assert.equal(pickStartHere(cases), "tut");
});

test("without a tutorial: lowest difficulty, then shortest", () => {
  const cases = [c("hard", "hard", 30), c("medium-long", "medium", 60), c("medium-short", "medium", 45)];
  assert.equal(pickStartHere(cases), "medium-short");
});

test("only released cases count when the released list is known", () => {
  const cases = [c("tut", "easy", 10, ["tutorial"]), c("outage", "medium", 50), c("ghost", "hard", 60)];
  assert.equal(pickStartHere(cases, ["outage", "ghost"]), "outage");
  assert.equal(pickStartHere(cases, null), "tut");
});

test("ties fall back to the title, so the choice is stable", () => {
  assert.equal(pickStartHere([c("b", "medium", 50), c("a", "medium", 50)]), "a");
});

test("no cases, or none released: null", () => {
  assert.equal(pickStartHere([]), null);
  assert.equal(pickStartHere([c("x", "easy", 5)], []), null);
});
