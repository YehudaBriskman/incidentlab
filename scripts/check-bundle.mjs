#!/usr/bin/env node
// Fails when case content, paid content or answers end up in the public build (site/dist).
// Usage: node scripts/check-bundle.mjs   (after `cd site && npm run build`)
//
// Since #68 nothing about a case ships with the site: the catalog, case content and evidence come from the
// content API, paid content from the game API after charging. So the check fails on any of:
//   - a case's free content (briefing, question prompts, debrief, setup checklist) in any shipped file;
//   - a JSON file shaped like a case (an `id` plus `questions`), or any file under dist/evidence/;
//   - a paid string (hint text, runnable command) in any encoding the bundler may have used;
//   - an answer from the answer keys (whole-token match, like the package leak scan);
//   - a file whose name mentions secrets or answers.
// It proves it read the bundle: the entry HTML and at least one JS chunk must be among the files it scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAID_MIN_LENGTH, createAnswerScan, createTextScan } from "../site/shared/leak-scan.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "site/dist");
const CASES = join(ROOT, "site/src/content/cases");
const SECRETS = join(ROOT, "site/server/generated/secrets.json");

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const all = walk(DIST);
const shipped = all.filter((f) => /\.(js|css|html|json|map|txt|svg|webmanifest)$/.test(f));
const jsChunks = shipped.filter((f) => f.startsWith(join(DIST, "assets")) && f.endsWith(".js"));
const texts = new Map(shipped.map((f) => [f, readFileSync(f, "utf8")]));
const haystack = [...texts.values()].join("\n");

// Raw, JSON-escaped or escape-normalized: whatever quoting the bundler picked (site/shared/leak-scan.ts).
const isShipped = createTextScan(haystack);
const answerShipped = createAnswerScan(haystack);

const problems = [];
const caseFiles = readdirSync(CASES).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
let paidChecked = 0;
let freeChecked = 0;
for (const file of caseFiles) {
  const data = JSON.parse(readFileSync(join(CASES, file), "utf8"));
  const free = [
    ["briefing", data.briefing],
    ["debrief", data.debrief],
    ...(data.setupChecklist ?? []).map((s, i) => [`setupChecklist[${i}]`, typeof s === "string" ? s : s?.text]),
    ...(data.questions ?? []).map((q) => [`prompt ${q.id}`, q.prompt]),
  ];
  for (const [kind, text] of free) {
    if (typeof text !== "string" || text.length < PAID_MIN_LENGTH) continue;
    freeChecked++;
    if (isShipped(text)) problems.push(`CASE CONTENT ${file} ${kind}: ${text.slice(0, 80)}`);
  }
  const paid = [];
  for (const q of data.questions ?? []) for (const h of q.hints ?? []) if (h.text) paid.push([`hint ${q.id}`, h.text]);
  for (const s of data.toolbox ?? []) for (const it of s.items ?? []) {
    if (it.command) paid.push([`command ${it.id}`, it.command]);
    if (it.powershell) paid.push([`powershell ${it.id}`, it.powershell]);
  }
  for (const [kind, text] of paid) {
    if (text.length < PAID_MIN_LENGTH) continue;
    paidChecked++;
    if (isShipped(text)) problems.push(`PAID ${file} ${kind}: ${text.slice(0, 80)}`);
  }
}

let answersChecked = 0;
if (existsSync(SECRETS)) {
  const secrets = JSON.parse(readFileSync(SECRETS, "utf8"));
  for (const [id, sealed] of Object.entries(secrets.cases ?? {})) {
    for (const [q, answer] of Object.entries(sealed.answers ?? {})) {
      answersChecked++;
      if (answerShipped(String(answer))) problems.push(`ANSWER ${id} ${q}`); // never print the answer itself
    }
  }
} else {
  problems.push(`BLIND: ${SECRETS} is missing, so answers were not checked (run scripts/build-all.sh)`);
}

for (const [file, text] of texts) {
  if (!file.endsWith(".json")) continue;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "id" in parsed && Array.isArray(parsed.questions)) problems.push(`CASE JSON ${file}`);
  } catch {
    // not JSON: nothing to check here
  }
}
for (const f of all.filter((f) => f.startsWith(join(DIST, "evidence") + "/"))) problems.push(`EVIDENCE FILE ${f}`);
for (const f of all.filter((f) => /secrets|answers/i.test(f))) problems.push(`FORBIDDEN FILE ${f}`);
if (!texts.has(join(DIST, "index.html")) || jsChunks.length === 0) problems.push("BLIND: no index.html or JS chunk was read");

if (problems.length > 0) {
  for (const p of problems.slice(0, 30)) console.error(`[check-bundle] ${p}`);
  console.error(`[check-bundle] FAIL: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `[check-bundle] OK: ${shipped.length} shipped files (${jsChunks.length} JS chunks) carry none of ` +
    `${freeChecked} case texts, ${paidChecked} paid strings or ${answersChecked} answers from ${caseFiles.length} case files`,
);
