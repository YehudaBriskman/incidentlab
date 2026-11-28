// Run: node --test --experimental-strip-types src/explorer/
import { test } from "node:test";
import assert from "node:assert/strict";

const m: typeof import("./layout") = await import(new URL("./layout.ts", import.meta.url).href);

test("the panel stays between its minimum and what leaves the log its minimum", () => {
  const b = m.bounds(1000);
  assert.equal(m.clampPanel(100, b), m.MIN_PANEL);
  assert.equal(m.clampPanel(900, b), 1000 - m.MIN_LOG);
  assert.equal(m.clampPanel(400.4, b), 400);
  assert.equal(m.clampPanel(Number.NaN, b), m.DEFAULT_PANEL);
  // too narrow for both minimums: the panel keeps its own
  assert.equal(m.clampPanel(500, m.bounds(500)), m.MIN_PANEL);
});

test("the value is the log's share, with the range from the two extremes", () => {
  const b = m.bounds(1000);
  assert.equal(m.logShare(400, b), 60);
  assert.deepEqual(m.shareRange(b), { min: 32, max: 72 });
  assert.equal(m.logShare(400, m.bounds(0)), 0);
});

test("arrow keys move the splitter the way they point, mirrored in RTL; Home and End go to the ends", () => {
  const b = m.bounds(1000);
  assert.equal(m.panelAfterKey("ArrowLeft", false, 400, b, false), 400 + m.KEY_STEP);
  assert.equal(m.panelAfterKey("ArrowRight", false, 400, b, false), 400 - m.KEY_STEP);
  assert.equal(m.panelAfterKey("ArrowLeft", false, 400, b, true), 400 - m.KEY_STEP);
  assert.equal(m.panelAfterKey("ArrowRight", true, 400, b, true), 400 + 4 * m.KEY_STEP);
  assert.equal(m.panelAfterKey("Home", false, 400, b, false), 1000 - m.MIN_LOG);
  assert.equal(m.panelAfterKey("End", false, 400, b, true), m.MIN_PANEL);
  assert.equal(m.panelAfterKey("Enter", false, 400, b, false), null);
});

test("dragging measures from the panel's edge: the end edge in LTR, the start edge in RTL", () => {
  const b = m.bounds(1000);
  assert.equal(m.panelFromPointer(600, 0, 1012, 12, false, b), 406);
  assert.equal(m.panelFromPointer(406, 0, 1012, 12, true, b), 400);
});

test("preferences survive a store that throws, and ignore junk", () => {
  const throwing: import("./layout").PrefStore = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  assert.equal(m.readPanelWidth(throwing), null);
  assert.equal(m.readFilesOpen(throwing), true);
  assert.equal(m.readTab(throwing), "filters");
  assert.doesNotThrow(() => m.savePanelWidth(throwing, 300));
  const data = new Map<string, string>();
  const mem: import("./layout").PrefStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  m.savePanelWidth(mem, 333.6);
  assert.equal(m.readPanelWidth(mem), 334);
  m.saveFilesOpen(mem, false);
  assert.equal(m.readFilesOpen(mem), false);
  m.saveTab(mem, "time");
  assert.equal(m.readTab(mem), "time");
  data.set(m.TAB_KEY, "bogus");
  data.set(m.PANEL_KEY, "wide");
  assert.equal(m.readTab(mem), "filters");
  assert.equal(m.readPanelWidth(mem), null);
  assert.equal(m.readPanelWidth(null), null);
});
