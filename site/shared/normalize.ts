// The one answer normalization. The server compares normalizeAnswer(input) with the stored key, and
// scripts/make_flags.py normalizes the answer keys the same way. Both are checked against
// shared/normalize-vectors.json (server/test/normalize.test.ts, and make_flags.py on every run).
//
// trim -> lowercase -> collapse each run of whitespace to one space. "Whitespace" is JavaScript's \s,
// which make_flags.py spells out character by character.
export const normalizeAnswer = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");
