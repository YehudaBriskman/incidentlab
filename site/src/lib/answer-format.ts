// Answer formats: the free client-side shape check before a guess that costs points, and the canonical form
// the server compares. Pure, so it is unit-tested in Node (answer-format.test.ts).

export type FormatKind = "time" | "integer" | "ipv4" | "sha" | "version" | "change" | "order" | "accessKey" | "other";

/** Recognise the common `answerFormat` texts (EN and HE). Anything unrecognised is "other": never blocked. */
export function formatKind(format: string): FormatKind {
  const t = format.toLowerCase();
  if (t.includes("hh:mm:ss")) return "time";
  if (/^(integer|מספר שלם)/.test(t)) return "integer";
  if (t.includes("ipv4")) return "ipv4";
  if (t.includes("sha") && t.includes("7")) return "sha";
  if (t.includes("x.y.z")) return "version";
  if (t.includes("chg-n")) return "change";
  if (t.includes("ord-x")) return "order";
  if (t.includes("asia")) return "accessKey";
  return "other";
}

const FORMAT_PATTERN: Record<Exclude<FormatKind, "other">, RegExp> = {
  time: /^\d{1,2}:\d{2}:\d{2}$/,
  integer: /^\d+$/,
  ipv4: /^\d{1,3}(\.\d{1,3}){3}$/,
  sha: /^[0-9a-f]{7,40}$/i,
  version: /^\d+\.\d+\.\d+$/,
  change: /^chg-\d+$/i,
  order: /^ord-[a-z0-9]+$/i,
  accessKey: /^asia[a-z0-9]{16}$/i,
};

/** True when `answer` fits the stage's format (or the format can't be checked). */
export function matchesFormat(format: string, answer: string): boolean {
  const kind = formatKind(format);
  return kind === "other" ? true : FORMAT_PATTERN[kind].test(answer.trim());
}

/**
 * The answer as the server compares it. The time check accepts a one-digit hour ("9:15:16"), but answer keys
 * are always HH:MM:SS, so the hour is zero-padded here; otherwise a right answer would cost a wrong attempt.
 */
export function canonicalAnswer(format: string, answer: string): string {
  const trimmed = answer.trim();
  return formatKind(format) === "time" && /^\d:\d{2}:\d{2}$/.test(trimmed) ? `0${trimmed}` : trimmed;
}

