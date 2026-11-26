// Case schemas for the server, the build scripts and the case-upload validator, built on the authored
// `CaseSchema` in ./case.ts (DB-stored cases; server/repositories/case-repository.ts stores them):
// - `CaseContentSchema`: the public form of `CaseSchema`, paid fields absent (what the browser may see);
// - `CaseSealedSchema`: the server-only half (answers, hint texts, commands, debriefs, scoring), the shape
//   of each case in site/server/generated/secrets.json;
// - `CaseMetaSchema`, `EvidenceEntrySchema`, `CasePackageManifestSchema`: case records and the package
//   manifest an upload carries.
// Stored-record rules (docs/DATA.md) apply: changes are additive, new fields get a `.default()`.
// Browser code must not import this module (see the note in ./case.ts).
import { z } from "zod";
import { CaseSchema, HintSchema, QuestionSchema, ToolItemSchema, ToolboxSectionSchema } from "./case.ts";
import { CaseIdSchema, QuestionIdSchema } from "./contract.ts";

// ---------------------------------------------------------------------------------------------------------
// Public content: CaseSchema with the paid fields removed. Built from the same parts, so the two cannot
// drift apart. Strict where paid fields used to be, so a leaked hint text or command fails validation.

export const PublicHintSchema = z.strictObject(HintSchema.omit({ text: true }).shape);
export const PublicToolItemSchema = z.strictObject(ToolItemSchema.omit({ command: true, powershell: true }).shape);
export const PublicQuestionSchema = QuestionSchema.extend({
  hints: z.array(PublicHintSchema).min(1).max(4),
});
export const PublicToolboxSectionSchema = ToolboxSectionSchema.extend({
  items: z.array(PublicToolItemSchema).min(1),
});
export const CaseContentSchema = CaseSchema.extend({
  questions: z.array(PublicQuestionSchema).min(1),
  toolbox: z.array(PublicToolboxSectionSchema).min(1),
});
export type CaseContent = z.infer<typeof CaseContentSchema>;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Removes the paid fields (hint texts, toolbox `command`/`powershell`) from an authored case file, keeping
 * every free field. Works on unparsed JSON on purpose: the Vite plugin strips files before validation, and
 * leaves anything it does not recognise alone. A valid `CaseSchema` input gives a valid `CaseContentSchema`
 * output.
 */
export function stripPaidContent(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: JsonObject = { ...raw };
  if (Array.isArray(raw["questions"])) {
    out["questions"] = raw["questions"].map((q: unknown) => {
      if (!isObject(q) || !Array.isArray(q["hints"])) return q;
      return { ...q, hints: q["hints"].map((hint: unknown) => (isObject(hint) ? { cost: hint["cost"] } : hint)) };
    });
  }
  if (Array.isArray(raw["toolbox"])) {
    out["toolbox"] = raw["toolbox"].map((section: unknown) => {
      if (!isObject(section) || !Array.isArray(section["items"])) return section;
      return {
        ...section,
        items: section["items"].map((item: unknown) => {
          if (!isObject(item)) return item;
          const { command: _command, powershell: _powershell, ...free } = item;
          return free;
        }),
      };
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Sealed content: server-only. One entry per case in site/server/generated/secrets.json (written by
// scripts/make_flags.py); server/domain/types.ts re-exports it as CaseSecretsSchema.

export const CaseLangSchema = z.enum(["en", "he"]);
export type CaseLang = z.infer<typeof CaseLangSchema>;

export const SealedQuestionConfigSchema = z.object({
  points: z.number().int().positive(),
  hintCosts: z.array(z.number().int().min(0)),
  targetSeconds: z.number().int().positive(),
});
export const LocalizedTextSchema = z.object({ en: z.string(), he: z.string().nullable() });

export const CaseSealedSchema = z.object({
  title: z.string(),
  /** normalized answers (normalizeAnswer), per question */
  answers: z.record(QuestionIdSchema, z.string()),
  debrief: z.string(),
  debriefHe: z.string().nullable(),
  questions: z.record(QuestionIdSchema, SealedQuestionConfigSchema),
  /** hint texts, in order, per question */
  hints: z.record(QuestionIdSchema, z.array(LocalizedTextSchema)),
  /** full runnable commands by toolbox item id */
  tools: z.record(z.string(), z.object({ command: z.string(), powershell: z.string().nullable() })),
  estMinutes: z.number().int().positive(),
});
export type CaseSealed = z.infer<typeof CaseSealedSchema>;

// ---------------------------------------------------------------------------------------------------------
// Case records and the upload package manifest (stored under `case:` and `evidence:` keys, see
// server/repositories/case-repository.ts).

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");

export const CaseStatusSchema = z.enum(["draft", "published", "trashed"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const CaseMetaSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
  id: CaseIdSchema,
  version: z.number().int().min(1),
  status: CaseStatusSchema,
  langs: z.array(CaseLangSchema).min(1),
  title: z.string(),
  difficulty: CaseSchema.shape.difficulty,
  tags: z.array(z.string()).default([]),
  /** hash over the normalized answers, points and hint costs: it changes when publishing would re-score players */
  answerFingerprint: z.string(),
  /** SHA-256 over the package's public content files */
  contentSha: Sha256Schema,
  createdBy: z.string(),
  createdAt: z.string(), // ISO timestamp
});
export type CaseMeta = z.infer<typeof CaseMetaSchema>;

/** Evidence is stored and transferred in chunks of this many bytes (Netlify Function payload limits). */
export const EVIDENCE_CHUNK_BYTES = 4 * 1024 * 1024;
export const evidenceChunkCount = (size: number): number => Math.ceil(size / EVIDENCE_CHUNK_BYTES);

/** A relative POSIX path inside the evidence pack: no leading slash, no backslashes, no empty, '.' or '..' segments. */
export const EvidencePathSchema = z.string().min(1).refine(
  (p) => !p.startsWith("/") && !p.includes("\\") && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
  "evidence path must be a relative POSIX path without empty, '.' or '..' segments",
);

export const EvidenceEntrySchema = z.object({
  path: EvidencePathSchema,
  format: z.string(),                    // short label, e.g. "nginx log (UTC)"
  size: z.number().int().min(0),         // bytes
  sha256: Sha256Schema,
  chunks: z.number().int().min(0),       // evidenceChunkCount(size)
  explorer: z.boolean().default(false),  // readable as text in the Evidence Explorer
}).refine((e) => e.chunks === evidenceChunkCount(e.size), {
  message: "chunks must equal ceil(size / EVIDENCE_CHUNK_BYTES)",
  path: ["chunks"],
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export const CasePackageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: CaseIdSchema,
  version: z.number().int().min(1),
  langs: z.array(CaseLangSchema).min(1),
  evidence: z.array(EvidenceEntrySchema),
}).refine((m) => new Set(m.langs).size === m.langs.length && m.langs.includes("en"), {
  message: "langs must be unique and include en",
  path: ["langs"],
}).refine((m) => new Set(m.evidence.map((e) => e.path)).size === m.evidence.length, {
  message: "evidence paths must be unique",
  path: ["evidence"],
});
export type CasePackageManifest = z.infer<typeof CasePackageManifestSchema>;

// ---------------------------------------------------------------------------------------------------------
// GET /api/cases/:caseId/content?lang=en|he (see the endpoint list in ./contract.ts).

export const CaseContentResponseSchema = z.object({
  id: CaseIdSchema,
  version: z.number().int().min(1),
  /** the language served: `he` falls back to `en` */
  lang: CaseLangSchema,
  content: CaseContentSchema,
});
export type CaseContentResponse = z.infer<typeof CaseContentResponseSchema>;
