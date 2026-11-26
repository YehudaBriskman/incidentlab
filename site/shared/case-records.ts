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
export const PublicToolItemSchema = z.strictObject(ToolItemSchema.omit({ command: true, powershell: true, lab: true }).shape);
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
 * Removes the paid fields (hint texts, toolbox `command`/`powershell`/`lab`) from an authored case file, keeping
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
          const { command: _command, powershell: _powershell, lab: _lab, ...free } = item;
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
  /** full runnable commands by toolbox item id; `lab` (#149) is the lab image variant, absent in older records */
  tools: z.record(z.string(), z.object({ command: z.string(), powershell: z.string().nullable(), lab: z.string().nullable().default(null) })),
  estMinutes: z.number().int().positive(),
});
export type CaseSealed = z.infer<typeof CaseSealedSchema>;

// ---------------------------------------------------------------------------------------------------------
// Case records and the upload package manifest (stored under `case:` and `evidence:` keys, see
// server/repositories/case-repository.ts).

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");

export const CaseStatusSchema = z.enum(["draft", "published", "trashed"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** One stored version of a case: what its records hold, for listings, diffs and the publish checks. */
export const CaseVersionInfoSchema = z.object({
  version: z.number().int().min(1),
  langs: z.array(CaseLangSchema).min(1),
  title: z.string(),
  difficulty: CaseSchema.shape.difficulty,
  tags: z.array(z.string()).default([]),
  /** answerFingerprint() of the version's sealed part: it changes when publishing would re-score players */
  answerFingerprint: z.string(),
  /** SHA-256 over the version's public content files */
  contentSha: Sha256Schema,
  /** account id of the uploader, or "admin" */
  createdBy: z.string(),
  createdAt: z.string(), // ISO timestamp
  evidenceFiles: z.number().int().min(0).default(0),
  evidenceBytes: z.number().int().min(0).default(0),
});
export type CaseVersionInfo = z.infer<typeof CaseVersionInfoSchema>;

const CaseMetaRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
  id: CaseIdSchema,
  /**
   * The version the descriptive fields below (langs ... contentSha) belong to: `publishedVersion` when there
   * is one, else `latestVersion`. Kept so readers written for #64 keep working.
   */
  version: z.number().int().min(1),
  /** the version public routes serve while `status` is "published"; null until the first publish */
  publishedVersion: z.number().int().min(1).nullable(),
  /** the highest stored version, drafts included; the next upload becomes latestVersion + 1 */
  latestVersion: z.number().int().min(1),
  /** "draft": nothing published yet; "published": publishedVersion is live; "trashed": soft-deleted (7-day restore) */
  status: CaseStatusSchema,
  langs: z.array(CaseLangSchema).min(1),
  title: z.string(),
  difficulty: CaseSchema.shape.difficulty,
  tags: z.array(z.string()).default([]),
  /** hash over the normalized answers, points and hint costs: it changes when publishing would re-score players */
  answerFingerprint: z.string(),
  /** SHA-256 over the package's public content files */
  contentSha: Sha256Schema,
  /** owner of the case id: the account id of the author who first uploaded it, or "admin" */
  createdBy: z.string(),
  createdAt: z.string(), // ISO timestamp
  updatedAt: z.string(), // ISO timestamp
  /** every stored version, oldest first */
  versions: z.array(CaseVersionInfoSchema).min(1),
}).refine((m) => m.latestVersion >= (m.publishedVersion ?? 0) && m.version === (m.publishedVersion ?? m.latestVersion), {
  message: "version must equal publishedVersion (latestVersion while nothing is published) and not exceed latestVersion",
  path: ["version"],
}).refine((m) => m.versions.some((v) => v.version === m.version), {
  message: "versions must include the described version",
  path: ["versions"],
});

/**
 * #64 wrote metas with a single `version` and no draft/published split. They parse as: that version is the
 * latest and, unless its status was "draft", the published one, with one entry in `versions`.
 */
const upgradeLegacyMeta = (raw: unknown): unknown => {
  if (!isObject(raw) || "latestVersion" in raw) return raw;
  const version = raw["version"];
  return {
    ...raw,
    publishedVersion: raw["status"] === "draft" ? null : version,
    latestVersion: version,
    updatedAt: raw["updatedAt"] ?? raw["createdAt"],
    versions: [{
      version,
      langs: raw["langs"],
      title: raw["title"],
      difficulty: raw["difficulty"],
      tags: raw["tags"],
      answerFingerprint: raw["answerFingerprint"],
      contentSha: raw["contentSha"],
      createdBy: raw["createdBy"],
      createdAt: raw["createdAt"],
    }],
  };
};

export const CaseMetaSchema = z.preprocess(upgradeLegacyMeta, CaseMetaRecordSchema);
export type CaseMeta = z.infer<typeof CaseMetaSchema>;
/** Metas written since #66 (draft/published split) carry this schemaVersion. */
export const CASE_META_SCHEMA_VERSION = 2;

/**
 * Builds a consistent meta from its versions: `version` and the descriptive fields follow `publishedVersion`
 * (or the latest version while nothing is published).
 */
export const composeCaseMeta = (input: {
  readonly id: string;
  readonly versions: readonly CaseVersionInfo[];
  readonly publishedVersion: number | null;
  readonly status: CaseStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): CaseMeta => {
  const versions = [...input.versions].sort((a, b) => a.version - b.version);
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error("a case meta needs at least one version");
  const described = versions.find((v) => v.version === (input.publishedVersion ?? latest.version));
  if (!described) throw new Error(`version ${String(input.publishedVersion)} is not stored`);
  return CaseMetaSchema.parse({
    schemaVersion: CASE_META_SCHEMA_VERSION,
    id: input.id,
    version: described.version,
    publishedVersion: input.publishedVersion,
    latestVersion: latest.version,
    status: input.status,
    langs: described.langs,
    title: described.title,
    difficulty: described.difficulty,
    tags: described.tags,
    answerFingerprint: described.answerFingerprint,
    contentSha: described.contentSha,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    versions,
  });
};

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

/**
 * Where a published case version's evidence is downloaded from (#68). The one place that decides it is
 * `evidenceLocation()` in server/services/evidenceStream.ts; the browser only follows these URLs, so the
 * evidence can move (another host, a CDN, a release asset) without a client change. Files are fetched as
 * `filesBase + <evidence path>`; their sha256 is in the case's evidence index.
 */
export const EvidenceLocationSchema = z.object({
  /** absolute path or URL ending in `/`: an evidence file is `filesBase` + its path (segments URL-encoded) */
  filesBase: z.string().min(1).refine((s) => s.endsWith("/"), "filesBase must end with /"),
  /** the prebuilt evidence zip; downloads as `<caseId>-evidence.zip` */
  zip: z.string().min(1),
});
export type EvidenceLocation = z.infer<typeof EvidenceLocationSchema>;

export const CaseContentResponseSchema = z.object({
  id: CaseIdSchema,
  version: z.number().int().min(1),
  /** the language served: `he` falls back to `en` */
  lang: CaseLangSchema,
  content: CaseContentSchema,
  /** added in #68; older responses lack it and the browser derives the Edge Function path */
  evidence: EvidenceLocationSchema.optional(),
});
export type CaseContentResponse = z.infer<typeof CaseContentResponseSchema>;
