// The answer fingerprint: a hash over what scoring depends on (normalized answers, points, hint costs,
// target times). It is the TypeScript twin of answer_fingerprint() in scripts/make_flags.py, which
// deploy.sh compares to refuse answer-key drift; the upload/publish flow (#66) uses the same rule.
// Both sides check themselves against ./fingerprint-vectors.json (server/test/answer-fingerprint.test.ts,
// make_flags.py on every run).
//
// Python computes sha256(json.dumps({"answers": ..., "questions": ...}, sort_keys=True)) with the default
// json.dumps settings: ", " and ": " separators, keys sorted by code point, ensure_ascii (every character
// outside printable ASCII as a lowercase \uXXXX escape, astral characters as surrogate pairs).
//
// Web APIs only (crypto.subtle), so it runs in Node, browsers and the Edge Function.

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** A JSON string literal exactly as Python's json.dumps(ensure_ascii=True) writes it. */
const pyString = (value: string): string => {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) out += short;
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
};

/** Python sorts str keys by code point; JS's default sort compares UTF-16 units, which differs for astral keys. */
const byCodePoint = (a: string, b: string): number => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

/** json.dumps(value, sort_keys=True) for the JSON values a sealed case holds (integers only, no floats). */
export const pythonJsonDumps = (value: Json): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("pythonJsonDumps: only safe integers are supported");
    return String(value);
  }
  if (typeof value === "string") return pyString(value);
  if (isArray(value)) return `[${value.map(pythonJsonDumps).join(", ")}]`;
  const keys = Object.keys(value).sort(byCodePoint);
  return `{${keys.map((k) => `${pyString(k)}: ${pythonJsonDumps(value[k] ?? null)}`).join(", ")}}`;
};

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What the fingerprint covers: the sealed answers and per-question scoring config. */
export type FingerprintInput = {
  readonly answers: Readonly<Record<string, string>>;
  readonly questions: Readonly<Record<string, { readonly points: number; readonly hintCosts: readonly number[]; readonly targetSeconds: number }>>;
};

/** sha256 hex of the answers and questions, identical to answer_fingerprint() in scripts/make_flags.py. */
export const answerFingerprint = async (sealed: FingerprintInput): Promise<string> => {
  const questions: Record<string, Json> = {};
  for (const [id, q] of Object.entries(sealed.questions)) {
    questions[id] = { points: q.points, hintCosts: [...q.hintCosts], targetSeconds: q.targetSeconds };
  }
  const text = pythonJsonDumps({ answers: { ...sealed.answers }, questions });
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
};
