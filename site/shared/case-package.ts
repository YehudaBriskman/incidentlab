// Validates a case package (`<id>-v<n>.case.zip`, format in docs/CASE_CONTRACT.md "Case package").
// Used at build time by scripts/check-packages.mts; written against web APIs only (shared/zip.ts,
// crypto.subtle, TextDecoder) so the upload flow (#66) can run the same checks in the browser and server.
//
// Error messages never quote answers, hint texts or commands: they name the question or tool instead.
import type { z } from "zod";
import {
  CaseContentSchema,
  CasePackageManifestSchema,
  CaseSealedSchema,
  evidenceChunkCount,
} from "./case-records.ts";
import type { CaseContent, CaseLang, CasePackageManifest, CaseSealed } from "./case-records.ts";
import { PAID_MIN_LENGTH, createAnswerScan, createTextScan } from "./leak-scan.ts";
import { ZipError, openZip } from "./zip.ts";
import type { ZipArchive } from "./zip.ts";

export const PACKAGE_SUFFIX = ".case.zip";
export const packageFileName = (id: string, version: number): string => `${id}-v${version}${PACKAGE_SUFFIX}`;

/** Fixed entries of a package; evidence files go under EVIDENCE_PREFIX, content under content.<lang>.json. */
export const PACKAGE_ENTRIES = {
  manifest: "manifest.json",
  answers: "sealed/answers.json",
  hints: "sealed/hints.json",
  commands: "sealed/commands.json",
  scoring: "sealed/scoring.json",
  debriefEn: "sealed/debrief.en.md",
  debriefHe: "sealed/debrief.he.md",
  evidenceZip: "evidence.zip",
} as const;
export const EVIDENCE_PREFIX = "evidence/";
const CONTENT_ENTRY = /^content\.([a-z]{2})\.json$/;
export const contentEntry = (lang: CaseLang): string => `content.${lang}.json`;

export interface CasePackage {
  manifest: CasePackageManifest;
  content: Partial<Record<CaseLang, CaseContent>>;
  sealed: CaseSealed;
}

export interface PackageReport {
  ok: boolean;
  errors: string[];
  /** set when every part parsed, even if later checks (evidence, leaks) failed */
  parsed?: CasePackage;
}

const text = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

const issues = (where: string, error: z.ZodError): string[] =>
  error.issues.slice(0, 10).map((i) => `${where}: ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);

async function readJson(zip: ZipArchive, name: string, errors: string[]): Promise<unknown> {
  if (!zip.get(name)) {
    errors.push(`missing ${name}`);
    return undefined;
  }
  try {
    return JSON.parse(text(await zip.read(name)));
  } catch (err) {
    errors.push(`${name}: ${err instanceof ZipError ? err.message : "not valid UTF-8 JSON"}`);
    return undefined;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string, errors: string[]): T | undefined {
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  errors.push(...issues(where, result.error));
  return undefined;
}

/** Checks the sealed half agrees with the English content: same questions, points, hint counts and costs, tools. */
function crossCheck(content: CaseContent, sealed: CaseSealed, errors: string[]): void {
  if (sealed.title !== content.title) errors.push("sealed/scoring.json: title differs from content.en.json");
  const contentIds = content.questions.map((q) => q.id).sort();
  const sealedIds = Object.keys(sealed.questions).sort();
  if (contentIds.join() !== sealedIds.join()) errors.push("sealed questions do not match the content questions");
  if (Object.keys(sealed.answers).sort().join() !== sealedIds.join()) errors.push("sealed/answers.json: questions do not match sealed/scoring.json");
  for (const q of content.questions) {
    const config = Object.entries(sealed.questions).find(([id]) => id === q.id)?.[1];
    const hints = Object.entries(sealed.hints).find(([id]) => id === q.id)?.[1];
    if (!config) continue;
    if (config.points !== q.points) errors.push(`${q.id}: sealed points differ from content`);
    if (config.hintCosts.join() !== q.hints.map((h) => h.cost).join()) errors.push(`${q.id}: sealed hint costs differ from content`);
    if (!hints || hints.length !== q.hints.length) errors.push(`${q.id}: sealed/hints.json has a different number of hints`);
  }
  const toolIds = new Set(content.toolbox.flatMap((s) => s.items.map((i) => i.id)).filter((id) => id !== undefined));
  for (const id of Object.keys(sealed.tools)) if (!toolIds.has(id)) errors.push(`sealed/commands.json: tool ${id} is not in the toolbox`);
}

async function checkEvidence(zip: ZipArchive, manifest: CasePackageManifest, errors: string[]): Promise<void> {
  const listed = new Set(manifest.evidence.map((e) => e.path));
  for (const entry of zip.entries) {
    if (entry.name.startsWith(EVIDENCE_PREFIX) && !listed.has(entry.name.slice(EVIDENCE_PREFIX.length))) {
      errors.push(`${entry.name} is not listed in manifest.json`);
    }
  }
  for (const item of manifest.evidence) {
    const name = `${EVIDENCE_PREFIX}${item.path}`;
    if (!zip.get(name)) {
      errors.push(`missing ${name}`);
      continue;
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await zip.read(name);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (bytes.length !== item.size) errors.push(`${name}: size is ${bytes.length}, manifest says ${item.size}`);
    if (evidenceChunkCount(bytes.length) !== item.chunks) errors.push(`${name}: ${evidenceChunkCount(bytes.length)} chunks, manifest says ${item.chunks}`);
    if ((await sha256Hex(bytes)) !== item.sha256) errors.push(`${name}: sha256 does not match manifest.json`);
  }

  // evidence.zip is the player download: one top-level folder <id>/ holding the same files.
  if (!zip.get(PACKAGE_ENTRIES.evidenceZip)) {
    errors.push(`missing ${PACKAGE_ENTRIES.evidenceZip}`);
    return;
  }
  try {
    const download = openZip(await zip.read(PACKAGE_ENTRIES.evidenceZip));
    const prefix = `${manifest.id}/`;
    const files = new Map(download.entries.filter((e) => !e.name.endsWith("/")).map((e) => [e.name, e.size]));
    for (const item of manifest.evidence) {
      const size = files.get(`${prefix}${item.path}`);
      if (size === undefined) errors.push(`evidence.zip: missing ${prefix}${item.path}`);
      else if (size !== item.size) errors.push(`evidence.zip: ${prefix}${item.path} has size ${size}, manifest says ${item.size}`);
    }
    for (const name of files.keys()) {
      if (!name.startsWith(prefix) || !listed.has(name.slice(prefix.length))) errors.push(`evidence.zip: ${name} is not listed in manifest.json`);
    }
  } catch (err) {
    errors.push(`evidence.zip: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** No answer, hint text or command may appear in a public file (content.<lang>.json, manifest.json). */
async function checkLeaks(zip: ZipArchive, publicFiles: string[], sealed: CaseSealed, errors: string[]): Promise<void> {
  const paid: { label: string; text: string }[] = [];
  for (const [qid, hints] of Object.entries(sealed.hints)) {
    hints.forEach((hint, i) => {
      paid.push({ label: `hint ${i + 1} of ${qid}`, text: hint.en });
      if (hint.he) paid.push({ label: `Hebrew hint ${i + 1} of ${qid}`, text: hint.he });
    });
  }
  for (const [id, tool] of Object.entries(sealed.tools)) {
    paid.push({ label: `command of tool ${id}`, text: tool.command });
    if (tool.powershell) paid.push({ label: `PowerShell command of tool ${id}`, text: tool.powershell });
  }
  for (const name of publicFiles) {
    const haystack = text(await zip.read(name));
    const hasAnswer = createAnswerScan(haystack);
    const hasText = createTextScan(haystack);
    for (const [qid, answer] of Object.entries(sealed.answers)) {
      if (hasAnswer(answer)) errors.push(`${name} contains the answer to ${qid}`);
    }
    for (const { label, text: paidText } of paid) {
      if (paidText.length >= PAID_MIN_LENGTH && hasText(paidText)) errors.push(`${name} contains the ${label}`);
    }
  }
}

export async function validateCasePackage(bytes: Uint8Array, options: { fileName?: string } = {}): Promise<PackageReport> {
  const errors: string[] = [];
  let zip: ZipArchive;
  try {
    zip = openZip(bytes);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }

  const fixed = new Set<string>(Object.values(PACKAGE_ENTRIES));
  for (const entry of zip.entries) {
    if (!fixed.has(entry.name) && !CONTENT_ENTRY.test(entry.name) && !entry.name.startsWith(EVIDENCE_PREFIX)) {
      errors.push(`unexpected entry ${entry.name}`);
    }
  }

  const manifest = parse(CasePackageManifestSchema, await readJson(zip, PACKAGE_ENTRIES.manifest, errors), PACKAGE_ENTRIES.manifest, errors);
  if (!manifest) return { ok: false, errors };
  if (options.fileName !== undefined && options.fileName !== packageFileName(manifest.id, manifest.version)) {
    errors.push(`file name ${options.fileName} does not match manifest (${packageFileName(manifest.id, manifest.version)})`);
  }

  const content: Partial<Record<CaseLang, CaseContent>> = {};
  for (const entry of zip.entries) {
    const lang = CONTENT_ENTRY.exec(entry.name)?.[1];
    if (lang !== undefined && !manifest.langs.some((l) => l === lang)) errors.push(`${entry.name}: language ${lang} is not in manifest langs`);
  }
  for (const lang of manifest.langs) {
    const name = contentEntry(lang);
    const parsed = parse(CaseContentSchema, await readJson(zip, name, errors), name, errors);
    if (!parsed) continue;
    if (parsed.id !== manifest.id) errors.push(`${name}: id ${parsed.id} does not match manifest id ${manifest.id}`);
    content[lang] = parsed;
  }

  const debrief = async (name: string): Promise<string | null> => (zip.get(name) ? text(await zip.read(name)) : null);
  const scoring = await readJson(zip, PACKAGE_ENTRIES.scoring, errors);
  const debriefEn = await debrief(PACKAGE_ENTRIES.debriefEn);
  if (debriefEn === null) errors.push(`missing ${PACKAGE_ENTRIES.debriefEn}`);
  const sealedRaw = {
    ...(typeof scoring === "object" && scoring !== null ? scoring : {}),
    answers: await readJson(zip, PACKAGE_ENTRIES.answers, errors),
    hints: await readJson(zip, PACKAGE_ENTRIES.hints, errors),
    tools: await readJson(zip, PACKAGE_ENTRIES.commands, errors),
    debrief: debriefEn,
    debriefHe: await debrief(PACKAGE_ENTRIES.debriefHe),
  };
  const sealed = parse(CaseSealedSchema, sealedRaw, "sealed", errors);

  await checkEvidence(zip, manifest, errors);
  if (!sealed) return { ok: false, errors };

  // The leak scan reads the raw public files, so it runs even when their schema check failed.
  const publicFiles = [PACKAGE_ENTRIES.manifest, ...zip.entries.map((e) => e.name).filter((n) => CONTENT_ENTRY.test(n))];
  await checkLeaks(zip, publicFiles, sealed, errors);
  if (!content.en) return { ok: false, errors };
  crossCheck(content.en, sealed, errors);
  return { ok: errors.length === 0, errors, parsed: { manifest, content, sealed } };
}
