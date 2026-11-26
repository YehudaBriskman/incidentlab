// Run: node --test --experimental-strip-types src/lib/overlay-logic.test.ts  (or npm run test:client)
// The DOM-free rules behind lib/overlay.ts: focus wrap, menu keys, typeahead, placement, modal stack, toast queue.
import { test } from "node:test";
import assert from "node:assert/strict";

const logic: typeof import("./overlay-logic") = await import(new URL("./overlay-logic.ts", import.meta.url).href);
const { trapTarget, menuKeyTarget, typeaheadMatch, placeAnchored, ModalStack, ToastQueue } = logic;

test("focus trap wraps at both ends and leaves the middle to the browser", () => {
  assert.equal(trapTarget(2, 3, false), 0, "Tab on the last element goes to the first");
  assert.equal(trapTarget(0, 3, true), 2, "Shift+Tab on the first goes to the last");
  assert.equal(trapTarget(1, 3, false), null);
  assert.equal(trapTarget(1, 3, true), null);
  assert.equal(trapTarget(-1, 3, false), 0, "focus on the container: Tab enters at the first");
  assert.equal(trapTarget(-1, 3, true), 2, "focus on the container: Shift+Tab enters at the last");
  assert.equal(trapTarget(0, 1, false), 0, "a single element keeps focus");
  assert.equal(trapTarget(0, 0, false), null);
});

test("menu keys: arrows wrap, Home/End jump, other keys do nothing", () => {
  assert.equal(menuKeyTarget("ArrowDown", 0, 3), 1);
  assert.equal(menuKeyTarget("ArrowDown", 2, 3), 0);
  assert.equal(menuKeyTarget("ArrowUp", 0, 3), 2);
  assert.equal(menuKeyTarget("ArrowUp", -1, 3), 2);
  assert.equal(menuKeyTarget("Home", 2, 3), 0);
  assert.equal(menuKeyTarget("End", 0, 3), 2);
  assert.equal(menuKeyTarget("a", 0, 3), null);
  assert.equal(menuKeyTarget("ArrowDown", 0, 0), null);
});

test("typeahead finds the next match, cycles on a repeated letter, and matches prefixes", () => {
  const labels = ["Approve", "Reset password…", "Revoke", "Delete"];
  assert.equal(typeaheadMatch(labels, "r", 0), 1);
  assert.equal(typeaheadMatch(labels, "r", 1), 2, "the same letter again moves on");
  assert.equal(typeaheadMatch(labels, "rr", 2), 1, "a repeated letter cycles and wraps");
  assert.equal(typeaheadMatch(labels, "rev", 0), 2, "a longer query matches a prefix");
  assert.equal(typeaheadMatch(labels, "D", 0), 3, "case-insensitive");
  assert.equal(typeaheadMatch(labels, "x", 0), -1);
  assert.equal(typeaheadMatch(["מחיקה", "איפוס"], "א", 0), 1, "Hebrew labels");
});

test("placement: under the anchor, inline-end aligned, mirrored in RTL, flipped and clamped", () => {
  const viewport = { width: 1000, height: 800 };
  const panel = { width: 200, height: 100 };
  const anchor = { top: 100, bottom: 130, left: 700, right: 740 };
  assert.deepEqual(placeAnchored(anchor, panel, viewport, { align: "end", rtl: false }), { left: 540, top: 134 });
  assert.deepEqual(placeAnchored(anchor, panel, viewport, { align: "end", rtl: true }), { left: 700, top: 134 });
  assert.deepEqual(placeAnchored(anchor, panel, viewport, { align: "start", rtl: false }), { left: 700, top: 134 });
  const low = { top: 750, bottom: 780, left: 700, right: 740 };
  assert.deepEqual(placeAnchored(low, panel, viewport, { align: "end", rtl: false }), { left: 540, top: 646 }, "flips above");
  const edge = { top: 100, bottom: 130, left: 10, right: 50 };
  assert.deepEqual(placeAnchored(edge, panel, viewport, { align: "end", rtl: false }), { left: 8, top: 134 }, "clamped inside the viewport");
  const rtlEdge = { top: 100, bottom: 130, left: 950, right: 990 };
  assert.deepEqual(placeAnchored(rtlEdge, panel, viewport, { align: "end", rtl: true }), { left: 792, top: 134 }, "RTL clamps at the right edge");
});

test("modal stack: the top modal restores focus; a lower one hands its opener up", () => {
  type Entry = { name: string; opener: string | null; contains: string[] };
  const stack = new ModalStack<Entry>();
  const inside = (opener: string | null, closing: Entry): boolean => opener !== null && closing.contains.includes(opener);
  const confirm: Entry = { name: "confirm", opener: "row-menu-button", contains: ["confirm-ok"] };
  const password: Entry = { name: "password", opener: "confirm-ok", contains: ["done"] };
  stack.push(confirm);
  stack.push(password);
  assert.equal(stack.top()?.name, "password");
  // The confirm closes first (its action opened the password dialog): no focus move, the opener moves up.
  assert.equal(stack.remove(confirm, inside), false);
  assert.equal(password.opener, "row-menu-button");
  assert.equal(stack.remove(password, inside), true, "closing the top one restores focus");
  assert.equal(stack.size, 0);
  assert.equal(stack.remove(password, inside), false, "removing twice is a no-op");
});

test("toast queue: repeats count up, at most 3, the oldest goes first", () => {
  const q = new ToastQueue<string>(3);
  assert.equal(q.add("a", () => "A").isNew, true);
  const again = q.add("a", () => "A2");
  assert.equal(again.isNew, false);
  assert.equal(again.count, 2);
  assert.equal(again.value, "A", "a repeat keeps the first toast");
  q.add("b", () => "B");
  q.add("c", () => "C");
  const d = q.add("d", () => "D");
  assert.deepEqual(d.evicted, [{ key: "a", value: "A" }]);
  assert.deepEqual(q.keys(), ["b", "c", "d"]);
  assert.equal(q.delete("c"), true);
  assert.equal(q.size, 2);
});

test("anchorOrigin: popups grow from the trigger's centre on the side they opened", () => {
  const { anchorOrigin } = logic;
  const anchor = { left: 500, right: 540, top: 100, bottom: 130 };
  const panel = { width: 200, height: 120 };
  // opened below, panel starting 400px in: origin at the trigger's centre (520 - 400) on the top edge
  assert.deepEqual(anchorOrigin(anchor, { left: 400, top: 134 }, panel), { side: "bottom", origin: "120px 0" });
  // opened above: bottom edge
  assert.deepEqual(anchorOrigin(anchor, { left: 400, top: -24 }, panel), { side: "top", origin: "120px 100%" });
  // clamped inside the panel when the trigger lies beyond it
  assert.equal(anchorOrigin(anchor, { left: 0, top: 134 }, { width: 100, height: 50 }).origin, "100px 0");
});
