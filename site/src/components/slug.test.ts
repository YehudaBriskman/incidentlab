import { test } from "node:test";
import assert from "node:assert/strict";
import { headingSlug } from "./slug.ts";

test("heading slugs: readable, keep Hebrew, dedupe, never empty", () => {
  const taken = new Set<string>();
  assert.equal(headingSlug("What really happened?", taken), "what-really-happened");
  assert.equal(headingSlug("What really happened!", taken), "what-really-happened-2");
  assert.equal(headingSlug("ציר הזמן", taken), "ציר-הזמן");
  assert.equal(headingSlug("  —  ", taken), "section");
  assert.equal(headingSlug("", taken), "section-2");
  assert.ok(headingSlug("x".repeat(200), taken).length <= 60);
});
