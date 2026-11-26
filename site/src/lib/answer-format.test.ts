import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalAnswer, formatKind, matchesFormat } from "./answer-format.ts";

const TIME = "HH:MM:SS (UTC)";

test("a one-digit hour passes the shape check and is zero-padded for the server", () => {
  assert.equal(matchesFormat(TIME, "9:15:16"), true);
  assert.equal(canonicalAnswer(TIME, " 9:15:16 "), "09:15:16");
  assert.equal(canonicalAnswer(TIME, "09:15:16"), "09:15:16");
});

test("only time answers are rewritten; other formats are only trimmed", () => {
  assert.equal(canonicalAnswer("Integer (bytes)", " 1372 "), "1372");
  assert.equal(canonicalAnswer("Change id (CHG-NNNN)", "CHG-7342"), "CHG-7342");
  assert.equal(canonicalAnswer("unbound.conf option name (no colon)", "9:15:16"), "9:15:16");
});

test("malformed answers are still blocked for free", () => {
  assert.equal(matchesFormat(TIME, "09:15:16Z"), false);
  assert.equal(matchesFormat("Change id (CHG-NNNN)", "CHG 7342"), false);
  assert.equal(formatKind("שם אופציה ב-unbound.conf (בלי נקודתיים)"), "other");
});
