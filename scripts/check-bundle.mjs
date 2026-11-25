#!/usr/bin/env node
// Fails when paid content (full toolbox commands, hint texts) or answer-key files end up in the public build.
// Usage: node scripts/check-bundle.mjs   (after `cd site && npm run build`)
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
const haystack = shipped.map((f) => readFileSync(f, "utf8")).join("\n");

const secrets = [];
for (const file of readdirSync(CASES).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
  const data = JSON.parse(readFileSync(join(CASES, file), "utf8"));
  for (const q of data.questions ?? []) for (const h of q.hints ?? []) if (h.text) secrets.push({ file, kind: `hint ${q.id}`, text: h.text });
  for (const s of data.toolbox ?? []) for (const it of s.items ?? []) {
    if (it.command) secrets.push({ file, kind: `command ${it.id}`, text: it.command });
    if (it.powershell) secrets.push({ file, kind: `powershell ${it.id}`, text: it.powershell });
  }
}

// A command is "leaked" if it appears raw or JSON-escaped (how bundlers embed strings).
const leaks = secrets.filter(({ text }) => {
  if (text.length < MIN_LENGTH) return false;
  const escaped = JSON.stringify(text).slice(1, -1);
  return haystack.includes(text) || haystack.includes(escaped);
});
const forbiddenFiles = walk(DIST).filter((f) => /secrets|answers/i.test(f));

if (leaks.length > 0 || forbiddenFiles.length > 0) {
  for (const l of leaks.slice(0, 20)) console.error(`[check-bundle] LEAK ${l.file} ${l.kind}: ${l.text.slice(0, 80)}`);
  for (const f of forbiddenFiles) console.error(`[check-bundle] FORBIDDEN FILE ${f}`);
  console.error(`[check-bundle] FAIL: ${leaks.length} leaked strings, ${forbiddenFiles.length} forbidden files`);
  process.exit(1);
}
console.log(`[check-bundle] OK: ${secrets.length} paid strings checked against ${shipped.length} shipped files, none found`);
