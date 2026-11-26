// Author API (#66): chunked case upload, publish, rollback and soft delete. Shared by the server, the CLI
// (scripts/data.ts upload) and the upload page that comes later. docs/API.md documents the routes.
//
// Every /api/author/* route takes the admin (X-Admin-Key header or admin session) or an approved author
// session (AuthService.requireAuthor). Authors act only on cases they own (`createdBy`).
//
// Upload flow (every request body stays at or under 4 MiB, below the ~6 MB Function payload limit):
//   1. POST /api/author/uploads {manifest, evidenceZip}       -> {uploadId, missingChunks, parts, ...}
//   2. PUT  /api/author/uploads/:uploadId/chunks/:sha256/:index   raw bytes (application/octet-stream)
//      for every missing chunk, at most UPLOAD_LIMITS.parallelChunks at a time;
//   3. PUT  /api/author/uploads/:uploadId/parts/:name           raw bytes, for every name in `parts`;
//   4. POST /api/author/uploads/:uploadId/finalize {}           -> {caseId, version, diff}  (a draft)
//   5. POST /api/author/cases/:caseId/publish {version, acceptAnswerChanges?}
// Chunks are content-addressed (evidence:<sha256>:<index>), so a re-POST after a failure lists only the
// chunks still missing: that is how an upload resumes.
import { z } from "zod";
import { CaseIdSchema } from "./contract.ts";
import {
  CaseLangSchema,
  CasePackageManifestSchema,
  CaseStatusSchema,
  CaseVersionInfoSchema,
  EVIDENCE_CHUNK_BYTES,
  Sha256Schema,
} from "./case-records.ts";
import type { CaseLang } from "./case-records.ts";
import { PACKAGE_ENTRIES, contentEntry } from "./case-package.ts";

const MIB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  /** evidence files + evidence.zip + parts, in bytes */
  maxPackageBytes: 100 * MIB,
  /** evidence files in the manifest */
  maxFiles: 500,
  /** one chunk body: exactly the stored chunk size (the last chunk of a file is shorter) */
  chunkBytes: EVIDENCE_CHUNK_BYTES,
  /** one named part (content JSON, sealed JSON, debrief markdown) */
  maxPartBytes: 1 * MIB,
  /** the JSON body of POST /api/author/uploads */
  maxCreateBodyBytes: 512 * 1024,
  /** an unfinished upload is dropped after this long */
  ttlHours: 24,
  /** clients send at most this many chunks at once */
  parallelChunks: 4,
  /** upload creations per uploader per hour */
  createsPerHour: 30,
} as const;

/**
 * Named parts and the package entry each one carries. Part names are flat (no "/") so they fit in one URL
 * path segment.
 */
export const UPLOAD_PARTS = {
  "content.en.json": contentEntry("en"),
  "content.he.json": contentEntry("he"),
  "sealed.answers.json": PACKAGE_ENTRIES.answers,
  "sealed.hints.json": PACKAGE_ENTRIES.hints,
  "sealed.commands.json": PACKAGE_ENTRIES.commands,
  "sealed.scoring.json": PACKAGE_ENTRIES.scoring,
  "sealed.debrief.en.md": PACKAGE_ENTRIES.debriefEn,
  "sealed.debrief.he.md": PACKAGE_ENTRIES.debriefHe,
} as const;
export const UploadPartNameSchema = z.enum([
  "content.en.json", "content.he.json", "sealed.answers.json", "sealed.hints.json", "sealed.commands.json",
  "sealed.scoring.json", "sealed.debrief.en.md", "sealed.debrief.he.md",
]);
export type UploadPartName = z.infer<typeof UploadPartNameSchema>;

/** The part name that carries a package entry, or null for entries that do not travel as parts. */
export const partNameForEntry = (entry: string): UploadPartName | null => {
  const found = UploadPartNameSchema.options.find((name) => UPLOAD_PARTS[name] === entry);
  return found ?? null;
};
export const contentPartName = (lang: CaseLang): UploadPartName => (lang === "en" ? "content.en.json" : "content.he.json");

/** Parts an upload must have: one content file per manifest language, the four sealed JSON files and the English debrief. */
export const requiredParts = (langs: readonly CaseLang[]): UploadPartName[] => [
  ...langs.map(contentPartName),
  "sealed.answers.json", "sealed.hints.json", "sealed.commands.json", "sealed.scoring.json", "sealed.debrief.en.md",
];

export const UploadIdSchema = z.string().regex(/^[0-9a-f]{24}$/, "invalid upload id");
export const ChunkRefSchema = z.object({ sha256: Sha256Schema, index: z.number().int().min(0) });
export type ChunkRef = z.infer<typeof ChunkRefSchema>;

// POST /api/author/uploads {manifest, evidenceZip: {sha256, size}}
//   -> 201 {uploadId, caseId, expiresAt, chunkBytes, missingChunks, parts}
//   400 invalid manifest; 403 code "not-owner" (another author's case); 409 code "id-taken" (a bundled case
//   id an author cannot claim) or "trashed" (restore the case first); 413 code "too-large" / "too-many-files";
//   429 rate limit.
export const CreateUploadRequestSchema = z.object({
  manifest: CasePackageManifestSchema,
  /** the player download (evidence.zip of the package); it travels in chunks like any evidence file */
  evidenceZip: z.object({ sha256: Sha256Schema, size: z.number().int().min(1) }),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;
export const CreateUploadResponseSchema = z.object({
  uploadId: UploadIdSchema,
  caseId: CaseIdSchema,
  expiresAt: z.string(),
  chunkBytes: z.number().int().positive(),
  /** chunks the server does not hold yet, by file sha256 and chunk index */
  missingChunks: z.array(ChunkRefSchema),
  /** part names to PUT before finalize (debrief.he is optional and not listed) */
  parts: z.array(UploadPartNameSchema),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

// PUT /api/author/uploads/:uploadId/chunks/:sha256/:index  (application/octet-stream, <= chunkBytes)
//   -> {stored, fileComplete, verified}   idempotent: a chunk already stored is not written again.
//   When the last chunk of a file arrives, the whole file is hashed: 422 code "sha-mismatch" drops its
//   chunks so they can be sent again. 400 code "chunk-size" for a wrong length; 413 above chunkBytes.
export const ChunkResponseSchema = z.object({
  stored: z.boolean(),
  /** every chunk of this file is now stored */
  fileComplete: z.boolean(),
  /** the stored file hashes to its sha256 */
  verified: z.boolean(),
});
export type ChunkResponse = z.infer<typeof ChunkResponseSchema>;

// PUT /api/author/uploads/:uploadId/parts/:name  (application/octet-stream, <= maxPartBytes) -> {name, size}
export const PartResponseSchema = z.object({ name: UploadPartNameSchema, size: z.number().int().min(0) });

// POST /api/author/uploads/:uploadId/finalize {} -> {caseId, version, status: "draft", diff}
//   422 code "invalid-package" with `details` (schema errors, answer leaks, cross-check failures),
//   409 code "missing-chunks" / "missing-parts" with `details`, 422 code "sha-mismatch".
export const UploadDiffSchema = z.object({
  /** the published version compared against, or null when nothing is published */
  against: z.number().int().min(1).nullable(),
  /** changed content keys, as "<lang>:<path>" (e.g. "en:questions.2.prompt"); capped, see `contentTruncated` */
  contentChanged: z.array(z.string()),
  contentTruncated: z.boolean(),
  evidenceAdded: z.array(z.string()),
  evidenceRemoved: z.array(z.string()),
  evidenceChanged: z.array(z.string()),
  evidenceZipChanged: z.boolean(),
  /** null when there is nothing to compare against; true means publishing re-scores players */
  answerFingerprintChanged: z.boolean().nullable(),
});
export type UploadDiff = z.infer<typeof UploadDiffSchema>;
export const FinalizeResponseSchema = z.object({
  caseId: CaseIdSchema,
  version: z.number().int().min(1),
  status: z.literal("draft"),
  diff: UploadDiffSchema,
});
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;

// POST /api/author/cases/:caseId/publish {version, acceptAnswerChanges?} -> {caseId, publishedVersion, previousVersion, rollback, changed}
//   409 code "answer-drift" when the answer fingerprint differs from the published one (or, before the first
//   publish, from the bundled case's answer key) while players have progress on the case, unless
//   acceptAnswerChanges. 409 code "conflict" when another publish won the race; "trashed"; 404 unknown version.
//   Rollback is publishing an older version.
export const PublishRequestSchema = z.object({
  version: z.number().int().min(1),
  acceptAnswerChanges: z.boolean().default(false),
});
export const PublishResponseSchema = z.object({
  caseId: CaseIdSchema,
  publishedVersion: z.number().int().min(1),
  previousVersion: z.number().int().min(1).nullable(),
  rollback: z.boolean(),
  /** false when the version was already published */
  changed: z.boolean(),
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

// GET /api/author/cases -> {cases: AuthorCase[]}   the cases the caller may manage (the admin: all)
export const AuthorCaseVersionSchema = CaseVersionInfoSchema.extend({
  /** "published": live now; "draft": newer than the published version; "previous": an older version (rollback target) */
  state: z.enum(["published", "draft", "previous"]),
});
export const AuthorCaseSchema = z.object({
  id: CaseIdSchema,
  title: z.string(),
  status: CaseStatusSchema,
  publishedVersion: z.number().int().min(1).nullable(),
  latestVersion: z.number().int().min(1),
  langs: z.array(CaseLangSchema),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versions: z.array(AuthorCaseVersionSchema),
});
export type AuthorCase = z.infer<typeof AuthorCaseSchema>;
export const AuthorCasesResponseSchema = z.object({ cases: z.array(AuthorCaseSchema) });

// DELETE /api/author/cases/:caseId              -> {caseId, trashId, expiresAt}  (soft: TRASH_RETENTION_DAYS to restore)
// POST   /api/author/cases/:caseId/restore {}   -> {caseId, status}              (also /api/admin/trash/:id/restore)
export const DeleteCaseResponseSchema = z.object({ caseId: CaseIdSchema, trashId: z.string(), expiresAt: z.string() });
export const RestoreCaseResponseSchema = z.object({ caseId: CaseIdSchema, status: CaseStatusSchema });
