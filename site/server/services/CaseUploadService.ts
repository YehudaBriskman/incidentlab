// Chunked, resumable case uploads (#66): create an upload from a manifest, receive evidence chunks and the
// small named parts, then finalize into a new **draft** version of the case. Publishing is
// CaseAuthoringService. Every body stays within UPLOAD_LIMITS (the controller enforces the byte limits).
import { createHash, randomBytes } from "node:crypto";
import { UPLOAD_LIMITS, UPLOAD_PARTS, contentPartName, requiredParts } from "../../shared/author-contract.ts";
import type { ChunkRef, ChunkResponse, CreateUploadRequest, CreateUploadResponse, FinalizeResponse, UploadDiff, UploadPartName } from "../../shared/author-contract.ts";
import { answerFingerprint } from "../../shared/answer-fingerprint.ts";
import { PACKAGE_ENTRIES, validatePackageParts } from "../../shared/case-package.ts";
import type { CasePackage, PackageParts } from "../../shared/case-package.ts";
import { EVIDENCE_CHUNK_BYTES, composeCaseMeta, evidenceChunkCount } from "../../shared/case-records.ts";
import type { CaseContent, CaseLang, CaseMeta, CaseVersionInfo, EvidenceEntry } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository, EvidenceChunkRepository } from "../repositories/case-repository.ts";
import type { UploadFile, UploadRecord, UploadRepository } from "../repositories/upload-repository.ts";
import { assertOwner, ownerId } from "./AuthorAuthService.ts";
import type { Actor } from "./AuthorAuthService.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

export const UPLOAD_CREATE_LIMIT: RateLimitRule = {
  bucket: "upload-create",
  max: UPLOAD_LIMITS.createsPerHour,
  windowMs: 60 * 60_000,
  message: "too many uploads started, wait a bit",
};

const HOUR_MS = 60 * 60 * 1000;
const META_RETRIES = 5;
const MAX_DIFF_KEYS = 200;

const notFound = (): AppError => new AppError(404, "upload not found (expired or unknown)", { code: "not-found" });

/** Leaf paths of a JSON value -> their JSON text, for the content diff ("questions.2.prompt"). */
const flatten = (value: unknown, prefix: string, out: Map<string, string>): Map<string, string> => {
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, JSON.stringify(value));
  return out;
};

const changedKeys = (before: CaseContent | null, after: CaseContent | null): string[] => {
  const a = flatten(before ?? {}, "", new Map());
  const b = flatten(after ?? {}, "", new Map());
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
};


export class CaseUploadService {
  private readonly uploads: UploadRepository;
  private readonly cases: CaseRepository;
  private readonly chunks: EvidenceChunkRepository;
  private readonly limiter: RateLimiter;
  private readonly bundledFingerprint: (caseId: string) => Promise<string | null>;
  private readonly reservedIds: () => ReadonlySet<string>;
  private readonly now: () => Date;

  constructor(deps: {
    uploads: UploadRepository;
    cases: CaseRepository;
    chunks: EvidenceChunkRepository;
    limiter: RateLimiter;
    /** the answer fingerprint of a bundled (pre-DB) case, the baseline before a case's first publish */
    bundledFingerprint: (caseId: string) => Promise<string | null>;
    /** case ids only the admin may upload (the bundled cases) */
    reservedIds: () => ReadonlySet<string>;
    now: () => Date;
  }) {
    this.uploads = deps.uploads;
    this.cases = deps.cases;
    this.chunks = deps.chunks;
    this.limiter = deps.limiter;
    this.bundledFingerprint = deps.bundledFingerprint;
    this.reservedIds = deps.reservedIds;
    this.now = deps.now;
  }

  /** Who may upload a version of `caseId`: its owner (or the admin); a new id is free unless it is reserved. */
  private async assertMayUpload(actor: Actor, caseId: string): Promise<void> {
    const meta = (await this.cases.getMeta(caseId))?.data;
    if (meta) {
      assertOwner(actor, meta.createdBy);
      if (meta.status === "trashed") throw new AppError(409, "this case is deleted; restore it first", { code: "trashed" });
      return;
    }
    if (actor.kind !== "admin" && this.reservedIds().has(caseId)) {
      throw new AppError(409, "that case id is taken", { code: "id-taken" });
    }
  }

  /** Every distinct file of an upload: the manifest's evidence and the evidence zip. */
  private static files(record: Pick<UploadRecord, "manifest" | "evidenceZip">): UploadFile[] {
    const bySha = new Map<string, UploadFile>();
    for (const e of record.manifest.evidence) bySha.set(e.sha256, { sha256: e.sha256, size: e.size, chunks: e.chunks });
    bySha.set(record.evidenceZip.sha256, record.evidenceZip);
    return [...bySha.values()];
  }

  /** The upload, if it belongs to the actor (the admin sees every upload) and has not expired. */
  private async load(actor: Actor, uploadId: string): Promise<{ record: UploadRecord; etag: string }> {
    const found = await this.uploads.get(uploadId);
    if (!found) throw notFound();
    if (actor.kind !== "admin" && found.data.owner !== ownerId(actor)) throw notFound();
    if (Date.parse(found.data.expiresAt) <= this.now().getTime()) {
      await this.uploads.remove(uploadId);
      throw notFound();
    }
    return { record: found.data, etag: found.etag };
  }

  /** Drops expired upload records and their parts. Best effort, run when an upload starts. */
  async sweepExpired(): Promise<number> {
    const nowMs = this.now().getTime();
    let removed = 0;
    for (const id of await this.uploads.listIds()) {
      const found = await this.uploads.get(id);
      if (!found || Date.parse(found.data.expiresAt) <= nowMs) {
        await this.uploads.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  async create(actor: Actor, input: CreateUploadRequest): Promise<CreateUploadResponse> {
    const owner = ownerId(actor);
    await this.limiter.assertAllowed(UPLOAD_CREATE_LIMIT, owner);
    const { manifest, evidenceZip } = input;
    if (manifest.evidence.length > UPLOAD_LIMITS.maxFiles) {
      throw new AppError(413, `at most ${UPLOAD_LIMITS.maxFiles} evidence files`, { code: "too-many-files" });
    }
    // Parts are capped one by one (maxPartBytes), so the package cap is on the evidence and its zip.
    if (manifest.evidence.reduce((sum, e) => sum + e.size, evidenceZip.size) > UPLOAD_LIMITS.maxPackageBytes) {
      throw new AppError(413, `a package may hold at most ${UPLOAD_LIMITS.maxPackageBytes / (1024 * 1024)} MiB of evidence`, { code: "too-large" });
    }
    const sizes = new Map<string, number>();
    for (const e of manifest.evidence) {
      if ((sizes.get(e.sha256) ?? e.size) !== e.size) throw new AppError(400, `${e.path}: same sha256 as another file but a different size`);
      sizes.set(e.sha256, e.size);
    }
    await this.assertMayUpload(actor, manifest.id);
    await this.limiter.hit(UPLOAD_CREATE_LIMIT, owner);
    await this.sweepExpired().catch((error: unknown) => console.warn("[incidentlab-uploads] sweep failed", error));

    const now = this.now();
    const record: UploadRecord = {
      schemaVersion: 1,
      id: randomBytes(12).toString("hex"),
      caseId: manifest.id,
      owner,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + UPLOAD_LIMITS.ttlHours * HOUR_MS).toISOString(),
      manifest,
      evidenceZip: { sha256: evidenceZip.sha256, size: evidenceZip.size, chunks: evidenceChunkCount(evidenceZip.size) },
      finalized: null,
    };
    if (!(await this.uploads.save(record, null))) throw new AppError(409, "upload id collision, please retry");

    const missingChunks: ChunkRef[] = [];
    for (const file of CaseUploadService.files(record)) {
      const stored = await this.chunks.storedChunks(file.sha256);
      for (let index = 0; index < file.chunks; index += 1) if (!stored.has(index)) missingChunks.push({ sha256: file.sha256, index });
    }
    return {
      uploadId: record.id,
      caseId: record.caseId,
      expiresAt: record.expiresAt,
      chunkBytes: EVIDENCE_CHUNK_BYTES,
      missingChunks,
      parts: requiredParts(manifest.langs),
    };
  }

  /** Hashes a stored file chunk by chunk (never the whole file in memory). */
  private async storedSha(file: UploadFile): Promise<string | null> {
    const hash = createHash("sha256");
    for (let index = 0; index < file.chunks; index += 1) {
      const bytes = await this.chunks.getChunk(file.sha256, index);
      const expected = Math.min(EVIDENCE_CHUNK_BYTES, file.size - index * EVIDENCE_CHUNK_BYTES);
      if (!bytes || bytes.byteLength !== expected) return null;
      hash.update(bytes);
    }
    return hash.digest("hex");
  }

  /** Verifies a complete file; on a mismatch its chunks are dropped so the next attempt re-sends them. */
  private async verify(uploadId: string, file: UploadFile): Promise<void> {
    if ((await this.storedSha(file)) === file.sha256) {
      await this.uploads.markVerified(uploadId, file.sha256, this.now().toISOString());
      return;
    }
    await this.chunks.deleteChunks(file.sha256);
    throw new AppError(422, `file ${file.sha256.slice(0, 12)}… does not match its sha256; its chunks were dropped, send them again`, { code: "sha-mismatch" });
  }

  async putChunk(actor: Actor, uploadId: string, sha256: string, index: number, bytes: Uint8Array): Promise<ChunkResponse> {
    const { record } = await this.load(actor, uploadId);
    if (record.finalized) throw new AppError(409, "this upload is already finalized", { code: "finalized" });
    const file = CaseUploadService.files(record).find((f) => f.sha256 === sha256);
    if (!file) throw new AppError(404, "that file is not part of this upload", { code: "not-found" });
    if (!Number.isInteger(index) || index < 0 || index >= file.chunks) throw new AppError(400, `chunk index must be 0..${file.chunks - 1}`, { code: "chunk-index" });
    const expected = Math.min(EVIDENCE_CHUNK_BYTES, file.size - index * EVIDENCE_CHUNK_BYTES);
    if (bytes.byteLength !== expected) throw new AppError(400, `chunk ${index} must be ${expected} bytes, got ${bytes.byteLength}`, { code: "chunk-size" });

    let stored = await this.chunks.storedChunks(sha256);
    const written = !stored.has(index);
    if (written) {
      await this.chunks.putChunk(sha256, index, bytes); // first writer wins: a stored chunk is never overwritten
      stored = await this.chunks.storedChunks(sha256);
    }
    const fileComplete = stored.size >= file.chunks && Array.from({ length: file.chunks }, (_, i) => i).every((i) => stored.has(i));
    if (!fileComplete) return { stored: written, fileComplete, verified: false };
    if (!(await this.uploads.verifiedFiles(uploadId)).has(sha256)) await this.verify(uploadId, file);
    return { stored: written, fileComplete, verified: true };
  }

  async putPart(actor: Actor, uploadId: string, name: UploadPartName, bytes: Uint8Array): Promise<{ name: UploadPartName; size: number }> {
    const { record } = await this.load(actor, uploadId);
    if (record.finalized) throw new AppError(409, "this upload is already finalized", { code: "finalized" });
    if (bytes.byteLength > UPLOAD_LIMITS.maxPartBytes) throw new AppError(413, "part too large", { code: "too-large" });
    const contentLangs: readonly CaseLang[] = record.manifest.langs;
    if ((name === "content.en.json" || name === "content.he.json") && !contentLangs.some((l) => contentPartName(l) === name)) {
      throw new AppError(400, `${name}: that language is not in the manifest`, { code: "part-not-allowed" });
    }
    await this.uploads.putPart(uploadId, name, bytes);
    return { name, size: bytes.byteLength };
  }

  /** The parts as a package source for validatePackageParts (entry names, plus the manifest from the record). */
  private async packageParts(record: UploadRecord): Promise<PackageParts> {
    const byEntry = new Map<string, Uint8Array>();
    byEntry.set(PACKAGE_ENTRIES.manifest, new TextEncoder().encode(`${JSON.stringify(record.manifest, null, 2)}\n`));
    for (const name of await this.uploads.partNames(record.id)) {
      const bytes = await this.uploads.getPart(record.id, name);
      if (bytes) byEntry.set(UPLOAD_PARTS[name], bytes);
    }
    return {
      names: [...byEntry.keys()],
      has: (name) => byEntry.has(name),
      read: async (name) => {
        const bytes = byEntry.get(name);
        if (!bytes) throw new Error(`missing ${name}`);
        return bytes;
      },
    };
  }

  /** sha256 over the public content files, in manifest language order (each followed by a NUL byte). */
  private static async contentSha(parts: PackageParts, langs: readonly CaseLang[]): Promise<string> {
    const hash = createHash("sha256");
    for (const lang of langs) {
      const name = UPLOAD_PARTS[contentPartName(lang)];
      hash.update(await parts.read(name));
      hash.update(new Uint8Array([0]));
    }
    return hash.digest("hex");
  }

  async finalize(actor: Actor, uploadId: string): Promise<FinalizeResponse> {
    const { record, etag } = await this.load(actor, uploadId);
    if (record.finalized) return { caseId: record.caseId, version: record.finalized.version, status: "draft", diff: record.finalized.diff };

    // 1. Every part, schema-valid, no answer leaks, the sealed half agreeing with the content.
    const parts = await this.packageParts(record);
    const missingParts = requiredParts(record.manifest.langs).filter((name) => !parts.has(UPLOAD_PARTS[name]));
    if (missingParts.length > 0) throw new AppError(409, "parts are missing", { code: "missing-parts", details: missingParts });
    const errors: string[] = [];
    const parsed = await validatePackageParts(parts, record.manifest, errors);
    if (!parsed || errors.length > 0) throw new AppError(422, "the package failed validation", { code: "invalid-package", details: errors.slice(0, 50) });

    // 2. Every chunk of every file stored, every file hashing to its sha256.
    const files = CaseUploadService.files(record);
    const missing: string[] = [];
    for (const file of files) {
      const stored = await this.chunks.storedChunks(file.sha256);
      for (let index = 0; index < file.chunks; index += 1) if (!stored.has(index)) missing.push(`${file.sha256}:${index}`);
    }
    if (missing.length > 0) throw new AppError(409, `${missing.length} chunk(s) are missing`, { code: "missing-chunks", details: missing.slice(0, 50) });
    const verified = await this.uploads.verifiedFiles(record.id);
    for (const file of files) if (!verified.has(file.sha256)) await this.verify(record.id, file); // chunks stored before this upload

    // 3. Claim the next version in the meta (setIfMatch), then write its records.
    const fingerprint = await answerFingerprint(parsed.sealed);
    const contentSha = await CaseUploadService.contentSha(parts, record.manifest.langs);
    const { version, before } = await this.claimVersion(actor, record, parsed, fingerprint, contentSha);
    await this.writeVersion(record, parsed, version);

    // 4. The diff against the published version.
    const diff = await this.diff(record, parsed, fingerprint, before);
    const done: UploadRecord = { ...record, finalized: { version, diff } };
    if (await this.uploads.save(done, etag)) await this.uploads.removeScratch(record.id);
    return { caseId: record.caseId, version, status: "draft", diff };
  }

  private async claimVersion(
    actor: Actor,
    record: UploadRecord,
    parsed: CasePackage,
    fingerprint: string,
    contentSha: string,
  ): Promise<{ version: number; before: CaseMeta | null }> {
    const en = parsed.content.en;
    if (!en) throw new AppError(422, "content.en.json is missing", { code: "invalid-package" });
    for (let attempt = 0; attempt < META_RETRIES; attempt += 1) {
      await this.assertMayUpload(actor, record.caseId);
      const current = await this.cases.getMeta(record.caseId);
      const before = current?.data ?? null;
      const version = (before?.latestVersion ?? 0) + 1;
      const now = this.now().toISOString();
      const info: CaseVersionInfo = {
        version,
        langs: [...record.manifest.langs],
        title: en.title,
        difficulty: en.difficulty,
        tags: [...en.tags],
        answerFingerprint: fingerprint,
        contentSha,
        createdBy: record.owner,
        createdAt: now,
        evidenceFiles: record.manifest.evidence.length,
        evidenceBytes: record.manifest.evidence.reduce((sum, e) => sum + e.size, 0),
      };
      const meta = composeCaseMeta({
        id: record.caseId,
        versions: [...(before?.versions ?? []), info],
        publishedVersion: before?.publishedVersion ?? null,
        status: before?.status ?? "draft",
        createdBy: before?.createdBy ?? record.owner,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      });
      if (await this.cases.saveMeta(meta, current?.etag ?? null)) return { version, before };
    }
    throw new AppError(409, "the case changed while finalizing, please retry", { code: "conflict" });
  }

  private async writeVersion(record: UploadRecord, parsed: CasePackage, version: number): Promise<void> {
    const id = record.caseId;
    for (const lang of record.manifest.langs) {
      const content = parsed.content[lang];
      if (content) await this.cases.putContent(id, version, lang, content);
    }
    await this.cases.putSealed(id, version, parsed.sealed);
    await this.cases.putEvidenceIndex(id, version, record.manifest.evidence);
    const zip: EvidenceEntry = { path: `${id}-evidence.zip`, format: "zip", explorer: false, ...record.evidenceZip };
    await this.cases.putEvidenceZip(id, version, zip);
  }

  private async diff(record: UploadRecord, parsed: CasePackage, fingerprint: string, before: CaseMeta | null): Promise<UploadDiff> {
    const against = before?.publishedVersion ?? null;
    const langs = new Set<CaseLang>([...record.manifest.langs, ...(against !== null && before ? before.langs : [])]);
    const contentChanged: string[] = [];
    for (const lang of langs) {
      const old = against === null ? null : await this.cases.getContent(record.caseId, against, lang);
      for (const key of changedKeys(old, parsed.content[lang] ?? null)) contentChanged.push(`${lang}:${key}`);
    }
    const oldIndex = against === null ? [] : ((await this.cases.getEvidenceIndex(record.caseId, against)) ?? []);
    const oldByPath = new Map(oldIndex.map((e) => [e.path, e.sha256]));
    const newByPath = new Map(record.manifest.evidence.map((e) => [e.path, e.sha256]));
    const oldZip = against === null ? null : await this.cases.getEvidenceZip(record.caseId, against);
    const baseline = against !== null && before
      ? (before.versions.find((v) => v.version === against)?.answerFingerprint ?? null)
      : await this.bundledFingerprint(record.caseId);
    return {
      against,
      contentChanged: contentChanged.slice(0, MAX_DIFF_KEYS),
      contentTruncated: contentChanged.length > MAX_DIFF_KEYS,
      evidenceAdded: [...newByPath.keys()].filter((p) => !oldByPath.has(p)).sort(),
      evidenceRemoved: [...oldByPath.keys()].filter((p) => !newByPath.has(p)).sort(),
      evidenceChanged: [...newByPath].filter(([p, sha]) => oldByPath.has(p) && oldByPath.get(p) !== sha).map(([p]) => p).sort(),
      evidenceZipChanged: oldZip?.sha256 !== record.evidenceZip.sha256,
      answerFingerprintChanged: baseline === null ? null : baseline !== fingerprint,
    };
  }
}

