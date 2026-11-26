#!/usr/bin/env -S node --experimental-strip-types
// Validates the case packages written by scripts/make_package.py (format: docs/CASE_CONTRACT.md).
//
//   node --experimental-strip-types scripts/check-packages.mts [package.case.zip ...]   (default: build/packages/*.case.zip)
//
// Each package is checked by validateCasePackage() (site/shared/case-package.ts): layout, manifest, content
// and sealed parts against the shared zod schemas, every evidence file's size, sha256 and chunk count, the
// prebuilt evidence.zip, and no answer, hint text or command in public files. When the build inputs are
// present it also checks that each package matches them: content.<lang>.json equals stripPaidContent() of
// the authored case JSON, and the sealed part equals the case's entry in the server secrets.
// Output never quotes answers. Exits 1 on any failure.
import { deepStrictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stripPaidContent } from "../site/shared/case-records.ts";
import { PACKAGE_SUFFIX, validateCasePackage } from "../site/shared/case-package.ts";
import type { CasePackage } from "../site/shared/case-package.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = join(ROOT, "build/packages");
const CASES = join(ROOT, "site/src/content/cases");
const SECRETS = join(ROOT, "site/server/generated/secrets.json");

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : existsSync(PACKAGES)
    ? readdirSync(PACKAGES).filter((f) => f.endsWith(PACKAGE_SUFFIX)).sort().map((f) => join(PACKAGES, f))
    : [];
if (files.length === 0) {
  console.error(`[check-packages] FAIL: no ${PACKAGE_SUFFIX} files in ${PACKAGES}; run scripts/make_package.py first`);
  process.exit(1);
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const secrets: unknown = existsSync(SECRETS) ? readJson(SECRETS) : undefined;
const secretFor = (id: string): unknown => {
  if (typeof secrets !== "object" || secrets === null || !("cases" in secrets)) return undefined;
  const cases = secrets.cases;
  return typeof cases === "object" && cases !== null ? Object.entries(cases).find(([key]) => key === id)?.[1] : undefined;
};

/** The package must be what the build inputs say, not merely well formed. */
function matchesSources(pkg: CasePackage, errors: string[]): void {
  for (const [lang, content] of Object.entries(pkg.content)) {
    const source = join(CASES, lang === "en" ? `${pkg.manifest.id}.json` : `${pkg.manifest.id}.${lang}.json`);
    if (!existsSync(source)) continue;
    try {
      deepStrictEqual(content, stripPaidContent(readJson(source)));
    } catch {
      errors.push(`content.${lang}.json differs from stripPaidContent(${basename(source)})`);
    }
  }
  const secret = secretFor(pkg.manifest.id);
  if (secret === undefined) return;
  try {
    deepStrictEqual(pkg.sealed, secret);
  } catch {
    errors.push(`sealed part differs from ${pkg.manifest.id} in site/server/generated/secrets.json`);
  }
}

let failed = 0;
for (const file of files) {
  const report = await validateCasePackage(new Uint8Array(readFileSync(file)), { fileName: basename(file) });
  const errors = [...report.errors];
  if (report.parsed) matchesSources(report.parsed, errors);
  const size = `${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB`;
  if (errors.length > 0) {
    failed++;
    for (const error of errors.slice(0, 30)) console.error(`[check-packages] ${basename(file)}: ${error}`);
    console.error(`[check-packages] FAIL ${basename(file)} (${size}): ${errors.length} problem(s)`);
    continue;
  }
  const manifest = report.parsed?.manifest;
  const evidenceBytes = manifest?.evidence.reduce((n, e) => n + e.size, 0) ?? 0;
  console.log(
    `[check-packages] OK ${basename(file)}  ${size}  ${manifest?.evidence.length ?? 0} evidence files ` +
      `(${(evidenceBytes / 1024 / 1024).toFixed(1)} MiB raw)  langs ${manifest?.langs.join(",") ?? ""}`,
  );
}
if (failed > 0) {
  console.error(`[check-packages] FAIL: ${failed} of ${files.length} package(s) invalid`);
  process.exit(1);
}
console.log(`[check-packages] OK: ${files.length} package(s) valid`);
