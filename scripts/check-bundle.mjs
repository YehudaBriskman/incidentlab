#!/usr/bin/env node
// Fails when paid content (full toolbox commands, hint texts) or answer-key files end up in the public build.
// Usage: node scripts/check-bundle.mjs   (after `cd site && npm run build`)
//
// Case content is code-split: every case file is its own lazy chunk under dist/assets, next to the entry
// chunk. The check reads every shipped file (all of them, not only the entry), and proves it did: each
// case's free debrief text must be found in what it read, or the check fails as blind.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "site/dist");
const CASES = join(ROOT, "site/src/content/cases");
const MIN_LENGTH = 16; // shorter strings (e.g. `ls -laR`) are too generic to be a meaningful leak signal

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

// Only code and markup can carry bundled content; evidence files are public on purpose.
const shipped = walk(DIST).filter((f) => /\.(js|css|html|json|map)$/.test(f) && !f.includes(`${DIST}/evidence/`));
const jsChunks = shipped.filter((f) => f.startsWith(join(DIST, "assets")) && f.endsWith(".js"));
const haystack = shipped.map((f) => readFileSync(f, "utf8")).join("\n");

/*
 * Bundlers embed strings in more than one way: JSON-style "..." (\" and \n escapes), or template literals
 * (\` and \${ escapes, raw or escaped newlines). Normalizing escapes and whitespace on both sides finds a
 * string whatever quoting the bundler picked.
 */
const normalize = (text) => text.replace(/\\[nrt]/g, " ").replace(/\\/g, "").replace(/\s+/g, " ");
const normalizedHaystack = normalize(haystack);
const isShipped = (text) => {
  const escaped = JSON.stringify(text).slice(1, -1);
  return haystack.includes(text) || haystack.includes(escaped) || normalizedHaystack.includes(normalize(text));
};

const caseFiles = readdirSync(CASES).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
const secrets = [];
const unseen = [];
for (const file of caseFiles) {
  const data = JSON.parse(readFileSync(join(CASES, file), "utf8"));
  for (const q of data.questions ?? []) for (const h of q.hints ?? []) if (h.text) secrets.push({ file, kind: `hint ${q.id}`, text: h.text });
  for (const s of data.toolbox ?? []) for (const it of s.items ?? []) {
    if (it.command) secrets.push({ file, kind: `command ${it.id}`, text: it.command });
    if (it.powershell) secrets.push({ file, kind: `powershell ${it.id}`, text: it.powershell });
  }
  // Free content that must ship: if it is not found, the check is not reading that case's chunk.
  if (typeof data.debrief === "string" && !isShipped(data.debrief)) unseen.push(file);
}

// A command is "leaked" if it appears in any of the encodings above.
const leaks = secrets.filter(({ text }) => text.length >= MIN_LENGTH && isShipped(text));
const forbiddenFiles = walk(DIST).filter((f) => /secrets|answers/i.test(f));

if (leaks.length > 0 || forbiddenFiles.length > 0 || unseen.length > 0) {
  for (const l of leaks.slice(0, 20)) console.error(`[check-bundle] LEAK ${l.file} ${l.kind}: ${l.text.slice(0, 80)}`);
  for (const f of forbiddenFiles) console.error(`[check-bundle] FORBIDDEN FILE ${f}`);
  for (const f of unseen) console.error(`[check-bundle] BLIND: ${f}'s content was not found in any shipped file`);
  console.error(`[check-bundle] FAIL: ${leaks.length} leaked strings, ${forbiddenFiles.length} forbidden files, ${unseen.length} unseen cases`);
  process.exit(1);
}
console.log(
  `[check-bundle] OK: ${secrets.length} paid strings checked against ${shipped.length} shipped files ` +
    `(${jsChunks.length} JS chunks, ${caseFiles.length} case files seen), none found`,
);
