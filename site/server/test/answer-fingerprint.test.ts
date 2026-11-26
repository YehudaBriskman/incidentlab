// The TypeScript answer fingerprint must equal answer_fingerprint() in scripts/make_flags.py: the shared
// vectors pin it, and when the build has run, so do the real fingerprints in build/truth/fingerprints.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { answerFingerprint, pythonJsonDumps } from "../../shared/answer-fingerprint.ts";
import { SecretsSchema } from "../domain/types.ts";

const QuestionSchema = z.object({ points: z.number().int(), hintCosts: z.array(z.number().int()), targetSeconds: z.number().int() });
const VectorsSchema = z.object({
  vectors: z.array(z.object({
    input: z.object({ answers: z.record(z.string(), z.string()), questions: z.record(z.string(), QuestionSchema) }),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1),
});
const { vectors } = VectorsSchema.parse(JSON.parse(readFileSync(new URL("../../shared/fingerprint-vectors.json", import.meta.url), "utf8")));

test("answerFingerprint matches the Python vectors", async () => {
  for (const vector of vectors) assert.equal(await answerFingerprint(vector.input), vector.fingerprint, JSON.stringify(vector.input));
});

test("pythonJsonDumps writes json.dumps(sort_keys=True) output", () => {
  assert.equal(pythonJsonDumps({ b: [1, 2], a: { y: null, x: true } }), '{"a": {"x": true, "y": null}, "b": [1, 2]}');
  assert.equal(pythonJsonDumps("é\u0001\"\\/"), '"\\u00e9\\u0001\\"\\\\/"');
  assert.equal(pythonJsonDumps("🔥"), '"\\ud83d\\udd25"');
  assert.throws(() => pythonJsonDumps(1.5));
});

const SECRETS = new URL("../generated/secrets.json", import.meta.url);
const TRUTH = new URL("../../../build/truth/fingerprints.json", import.meta.url);

test("answerFingerprint equals make_flags.py on every real case (when the build has run)", { skip: !existsSync(SECRETS) || !existsSync(TRUTH) }, async () => {
  const secrets = SecretsSchema.parse(JSON.parse(readFileSync(SECRETS, "utf8")));
  const expected = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(TRUTH, "utf8")));
  assert.ok(Object.keys(secrets.cases).length > 0);
  for (const [id, sealed] of Object.entries(secrets.cases)) {
    assert.equal(await answerFingerprint(sealed), expected[id], id);
  }
});
