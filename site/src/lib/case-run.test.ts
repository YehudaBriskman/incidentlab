import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRunOpen, readRunChoice, runClassOf, runOffer } from "./case-run.ts";

const event = { startsAt: "2026-12-01T18:00:00Z", endsAt: "2026-12-01T20:00:00Z" };

test("an event run is open only inside a full window", () => {
  assert.equal(eventRunOpen(event, Date.parse("2026-12-01T17:59:59Z")), false);
  assert.equal(eventRunOpen(event, Date.parse("2026-12-01T18:00:00Z")), true);
  assert.equal(eventRunOpen(event, Date.parse("2026-12-01T20:00:00Z")), false);
  assert.equal(eventRunOpen({ startsAt: event.startsAt, endsAt: null }, Date.parse("2026-12-01T19:00:00Z")), false, "no end: no event run");
  assert.equal(eventRunOpen(undefined, 0), false);
});

test("the case page asks once, then offers quietly, and never on an event run", () => {
  assert.equal(runOffer({ onEventRun: false, eventOpen: true, choice: null }), "ask");
  assert.equal(runOffer({ onEventRun: false, eventOpen: true, choice: { kind: "own" } }), "offer");
  assert.equal(runOffer({ onEventRun: true, eventOpen: true, choice: { kind: "event", classId: "AbCdEf123456" } }), "none");
  assert.equal(runOffer({ onEventRun: false, eventOpen: false, choice: null }), "none");
});

test("without storage there is no stored choice (the own run)", () => {
  assert.equal(readRunChoice("alpha"), null);
  assert.equal(runClassOf("alpha"), null);
});
