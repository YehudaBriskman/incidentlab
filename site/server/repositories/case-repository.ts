// DB-stored cases (#64). JSON records go through KvStore, evidence bytes through ByteStore, both on the
// `incidentlab-v2` store:
//   case:<id>:meta                       CaseMeta (publishedVersion, latestVersion, status, every version; setIfMatch)
//   case:<id>:v<n>:content:<lang>        CaseContent  (public: no hint texts, no runnable commands)
//   case:<id>:v<n>:sealed                CaseSealed   (server-only: answers, hint texts, commands, debriefs)
//   case:<id>:v<n>:evidence-index        EvidenceEntry[]  (every file of the evidence pack)
//   case:<id>:v<n>:evidence-zip          EvidenceEntry    (the prebuilt evidence zip)
//   evidence:<sha256>:<chunk#>           raw bytes, EVIDENCE_CHUNK_BYTES per chunk (the last one shorter).
//                                        Content-addressed: identical files share chunks across cases and versions.
// Every read is validated with zod. A corrupt record is logged and treated as missing, never thrown.
//
// Web APIs only (no node: imports): the evidence Edge Function (Deno) imports this module.
import { z } from "zod";
import {
  CaseContentSchema,
  CaseMetaSchema,
  CaseSealedSchema,
  EVIDENCE_CHUNK_BYTES,
  EvidenceEntrySchema,
  evidenceChunkCount,
} from "../../shared/case-records.ts";
import type { CaseContent, CaseLang, CaseMeta, CaseSealed, EvidenceEntry } from "../../shared/case-records.ts";
import type { ByteStore } from "./ByteStore.ts";
import { mapWithConcurrency } from "./KvStore.ts";
import type { KvStore, Versioned } from "./KvStore.ts";

export const caseKeys = {
  meta: (id: string): string => `case:${id}:meta`,
  content: (id: string, version: number, lang: CaseLang): string => `case:${id}:v${version}:content:${lang}`,
  sealed: (id: string, version: number): string => `case:${id}:v${version}:sealed`,
  evidenceIndex: (id: string, version: number): string => `case:${id}:v${version}:evidence-index`,
  evidenceZip: (id: string, version: number): string => `case:${id}:v${version}:evidence-zip`,
  chunk: (sha256: string, index: number): string => `evidence:${sha256}:${index}`,
} as const;

const META_KEY = /^case:[a-z0-9][a-z0-9-]{1,63}:meta$/;

const EvidenceIndexSchema = z.array(EvidenceEntrySchema);

/** Parses a stored record; a corrupt one is logged and becomes null so one bad key never fails a request. */
const parseRecord = <T>(schema: z.ZodType<T>, key: string, raw: unknown): T | null => {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`[incidentlab-cases] skipping corrupt record ${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return null;
};

export class CaseRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }

  private async read<T>(schema: z.ZodType<T>, key: string): Promise<T | null> {
    const found = await this.kv.get(key);
    return found ? parseRecord(schema, key, found.data) : null;
  }

  async getMeta(id: string): Promise<Versioned<CaseMeta> | null> {
    const key = caseKeys.meta(id);
    const found = await this.kv.get(key);
    if (!found) return null;
    const data = parseRecord(CaseMetaSchema, key, found.data);
    return data ? { data, etag: found.etag } : null;
  }

  /** Conditional meta write: `expectedEtag === null` means "only if new". Returns false when someone else won. */
  async saveMeta(meta: CaseMeta, expectedEtag: string | null): Promise<boolean> {
    const valid = CaseMetaSchema.parse(meta);
    return this.kv.setIfMatch(caseKeys.meta(valid.id), valid, expectedEtag);
  }

  /** Every case's meta, sorted by id. Corrupt metas are skipped. */
  async listMetas(): Promise<CaseMeta[]> {
    const keys = (await this.kv.listKeys("case:")).filter((k) => META_KEY.test(k));
    const metas = await mapWithConcurrency(keys, (key) => this.read(CaseMetaSchema, key));
    return metas.filter((m): m is CaseMeta => m !== null).sort((a, b) => a.id.localeCompare(b.id));
  }

  getContent(id: string, version: number, lang: CaseLang): Promise<CaseContent | null> {
    return this.read(CaseContentSchema, caseKeys.content(id, version, lang));
  }
  async putContent(id: string, version: number, lang: CaseLang, content: CaseContent): Promise<void> {
    await this.kv.set(caseKeys.content(id, version, lang), CaseContentSchema.parse(content));
  }

  getSealed(id: string, version: number): Promise<CaseSealed | null> {
    return this.read(CaseSealedSchema, caseKeys.sealed(id, version));
  }
  async putSealed(id: string, version: number, sealed: CaseSealed): Promise<void> {
    await this.kv.set(caseKeys.sealed(id, version), CaseSealedSchema.parse(sealed));
  }

  getEvidenceIndex(id: string, version: number): Promise<EvidenceEntry[] | null> {
    return this.read(EvidenceIndexSchema, caseKeys.evidenceIndex(id, version));
  }
  async putEvidenceIndex(id: string, version: number, index: readonly EvidenceEntry[]): Promise<void> {
    await this.kv.set(caseKeys.evidenceIndex(id, version), EvidenceIndexSchema.parse(index));
  }

  getEvidenceZip(id: string, version: number): Promise<EvidenceEntry | null> {
    return this.read(EvidenceEntrySchema, caseKeys.evidenceZip(id, version));
  }
  async putEvidenceZip(id: string, version: number, entry: EvidenceEntry): Promise<void> {
    await this.kv.set(caseKeys.evidenceZip(id, version), EvidenceEntrySchema.parse(entry));
  }
}

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return toHex(await crypto.subtle.digest("SHA-256", copy));
};

export type StoredFile = { readonly sha256: string; readonly size: number; readonly chunks: number };

/** Content-addressed evidence chunks on the byte store. */
export class EvidenceChunkRepository {
  private readonly bytes: ByteStore;
  constructor(bytes: ByteStore) {
    this.bytes = bytes;
  }

  getChunk(sha256: string, index: number): Promise<Uint8Array | null> {
    return this.bytes.getBytes(caseKeys.chunk(sha256, index));
  }

  /**
   * Stores a whole file as chunks and returns its address. A file whose chunks are all present already
   * (same bytes from another case or version) is not written again. Callers that receive a file in pieces
   * (#66) write chunks with `putChunk` instead.
   */
  async putFile(file: Uint8Array): Promise<StoredFile> {
    const sha256 = await sha256Hex(file);
    const chunks = evidenceChunkCount(file.byteLength);
    const existing = new Set(await this.bytes.listKeys(`evidence:${sha256}:`));
    for (let index = 0; index < chunks; index += 1) {
      const key = caseKeys.chunk(sha256, index);
      if (existing.has(key)) continue;
      await this.bytes.setBytes(key, file.subarray(index * EVIDENCE_CHUNK_BYTES, (index + 1) * EVIDENCE_CHUNK_BYTES));
    }
    return { sha256, size: file.byteLength, chunks };
  }

  async putChunk(sha256: string, index: number, bytes: Uint8Array): Promise<void> {
    await this.bytes.setBytes(caseKeys.chunk(sha256, index), bytes);
  }

  /** The chunk indexes stored for a file (content addressing: any case or version may have stored them). */
  async storedChunks(sha256: string): Promise<Set<number>> {
    const prefix = `evidence:${sha256}:`;
    const indexes = (await this.bytes.listKeys(prefix)).map((key) => key.slice(prefix.length)).filter((rest) => /^(0|[1-9][0-9]*)$/.test(rest)).map(Number);
    return new Set(indexes);
  }

  /**
   * Drops every chunk of a file. Only for a file whose stored bytes failed their sha256 check (so no case
   * version can be serving it correctly); chunks are otherwise never deleted, because they are shared.
   */
  async deleteChunks(sha256: string): Promise<void> {
    for (const index of await this.storedChunks(sha256)) await this.bytes.deleteBytes(caseKeys.chunk(sha256, index));
  }
}
