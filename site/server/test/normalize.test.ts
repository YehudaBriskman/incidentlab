// normalizeAnswer against the shared vectors that scripts/make_flags.py also checks itself against.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { normalizeAnswer as fromContract } from "../../shared/contract.ts";
import { normalizeAnswer } from "../../shared/normalize.ts";

const VectorsSchema = z.object({ vectors: z.array(z.object({ input: z.string(), expected: z.string() })).min(1) });
const { vectors } = VectorsSchema.parse(JSON.parse(readFileSync(new URL("../../shared/normalize-vectors.json", import.meta.url), "utf8")));

test("normalizeAnswer matches every shared vector", () => {
  for (const { input, expected } of vectors) assert.equal(normalizeAnswer(input), expected, `input ${JSON.stringify(input)}`);
});

test("the contract re-exports the same normalizeAnswer", () => {
  assert.equal(fromContract, normalizeAnswer);
});

test("normalizeAnswer is idempotent on the vectors", () => {
  for (const { expected } of vectors) assert.equal(normalizeAnswer(expected), expected);
});
