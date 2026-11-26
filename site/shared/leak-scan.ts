// Leak rules for public case content, shared by scripts/check-bundle.mjs (the built site) and
// scripts/check-packages.mts (case packages); the upload finalize step (#66) is meant to use them too.
// No dependencies beyond ./normalize.ts, so it runs in Node, browsers and plain .mjs scripts.
import { normalizeAnswer } from "./normalize.ts";

/** Paid strings (hint texts, commands) shorter than this are too generic to be a meaningful leak signal. */
export const PAID_MIN_LENGTH = 16;
/** Normalized answers shorter than this (e.g. a small count like "7") occur in ordinary prose, so they are not scanned. */
export const ANSWER_MIN_LENGTH = 4;

/**
 * Bundlers and JSON embed strings in more than one way: "..." with \" and \n escapes, or template literals
 * with \` and \${ escapes and raw or escaped newlines. Normalizing escapes and whitespace on both sides finds
 * a string whatever quoting was used.
 */
export const normalizeEscapes = (text: string): string => text.replace(/\\[nrt]/g, " ").replace(/\\/g, "").replace(/\s+/g, " ");

/** Returns a test for "does this text appear in the haystack", raw, JSON-escaped or escape-normalized. */
export function createTextScan(haystack: string): (text: string) => boolean {
  const normalized = normalizeEscapes(haystack);
  return (text) => {
    const escaped = JSON.stringify(text).slice(1, -1);
    return haystack.includes(text) || haystack.includes(escaped) || normalized.includes(normalizeEscapes(text));
  };
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Returns a test for "does this answer appear in the haystack": both sides are normalized like player input
 * (normalizeAnswer, so case and whitespace do not matter, after escape normalization), and a match must be
 * a whole token (no letter, digit or underscore right before or after it), so "42" does not match "1428".
 * Answers shorter than ANSWER_MIN_LENGTH never match.
 */
export function createAnswerScan(haystack: string): (answer: string) => boolean {
  const normalized = normalizeAnswer(normalizeEscapes(haystack));
  return (answer) => {
    const needle = normalizeAnswer(normalizeEscapes(answer));
    if (needle.length < ANSWER_MIN_LENGTH) return false;
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1)) {
      if (!isWordChar(normalized[at - 1]) && !isWordChar(normalized[at + needle.length])) return true;
    }
    return false;
  };
}
