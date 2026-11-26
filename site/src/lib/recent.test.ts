import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVisits, pushVisit, visitHref, type Visit } from "./recent.ts";

const v = (kind: Visit["kind"], caseId: string, at: number, file: string | null = null): Visit => ({ kind, caseId, file, at });

test("pushVisit puts the newest first, keeps one entry per place and caps the list", () => {
  let list: Visit[] = [];
  list = pushVisit(list, v("case", "a", 1));
  list = pushVisit(list, v("explorer", "a", 2, "logs/app.log"));
  list = pushVisit(list, v("case", "a", 3));
  assert.deepEqual(list.map((x) => `${x.kind}:${x.caseId}:${x.at}`), ["case:a:3", "explorer:a:2"]);
  list = pushVisit(list, v("explorer", "a", 4, "dns/dig.txt"));
  assert.equal(list.filter((x) => x.kind === "explorer").length, 1);
  assert.equal(list[0]?.file, "dns/dig.txt");
  for (let i = 0; i < 10; i++) list = pushVisit(list, v("case", `c${i}`, 10 + i), 6);
  assert.equal(list.length, 6);
  assert.equal(list[0]?.caseId, "c9");
});

test("parseVisits drops invalid entries and survives junk", () => {
  assert.deepEqual(parseVisits(null), []);
  assert.deepEqual(parseVisits("not json"), []);
  assert.deepEqual(parseVisits('{"kind":"case"}'), []);
  const parsed = parseVisits(JSON.stringify([{ kind: "case", caseId: "a", at: 1 }, { kind: "evil", caseId: "b", at: 2 }, { kind: "toolbox", caseId: "", at: 3 }]));
  assert.deepEqual(parsed, [{ kind: "case", caseId: "a", file: null, at: 1 }]);
});

test("visitHref builds each route, encoding the Explorer file", () => {
  assert.equal(visitHref(v("case", "ghost", 1)), "#/case/ghost");
  assert.equal(visitHref(v("toolbox", "ghost", 1)), "#/case/ghost/toolbox");
  assert.equal(visitHref(v("explorer", "ghost", 1, "dns/dig 1.txt")), "#/case/ghost/explorer?f=dns%2Fdig+1.txt");
  assert.equal(visitHref(v("explorer", "ghost", 1)), "#/case/ghost/explorer");
});
