// In-progress chunked case uploads (#66), on the `incidentlab-v2` store:
//   upload:<uploadId>                    UploadRecord (JSON): owner, manifest, expiry, and the finalize result
//   upload:<uploadId>:verified:<sha256>  {at} (JSON): this file's stored chunks hashed to its sha256
//   upload:<uploadId>:part:<name>        raw bytes (ByteStore): one named part (content JSON, sealed parts)
// The evidence chunks themselves go straight to the content-addressed `evidence:` keys. `upload:` keys are
// ephemeral: they expire after UPLOAD_LIMITS.ttlHours, are swept on the next upload, and are not backed up.
import { z } from "zod";
import { UploadIdSchema, UploadDiffSchema, UploadPartNameSchema } from "../../shared/author-contract.ts";
import type { UploadPartName } from "../../shared/author-contract.ts";
import { CasePackageManifestSchema, Sha256Schema } from "../../shared/case-records.ts";
import type { ByteStore } from "./ByteStore.ts";
import type { KvStore, Versioned } from "./KvStore.ts";

export const UploadFileSchema = z.object({
  sha256: Sha256Schema,
  size: z.number().int().min(0),
  chunks: z.number().int().min(0),
});
export type UploadFile = z.infer<typeof UploadFileSchema>;

export const UploadRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
  id: UploadIdSchema,
  caseId: z.string(),
  /** account id of the uploader, or "admin" */
  owner: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  manifest: CasePackageManifestSchema,
  evidenceZip: UploadFileSchema,
  /** set once finalize stored the draft; a repeated finalize returns it */
  finalized: z.object({ version: z.number().int().min(1), diff: UploadDiffSchema }).nullable().default(null),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;

const RECORD_KEY = /^upload:([0-9a-f]{24})$/;
const recordKey = (id: string): string => `upload:${id}`;
const verifiedPrefix = (id: string): string => `upload:${id}:verified:`;
const partPrefix = (id: string): string => `upload:${id}:part:`;

export class UploadRepository {
  private readonly kv: KvStore;
  private readonly bytes: ByteStore;

  constructor(deps: { kv: KvStore; bytes: ByteStore }) {
    this.kv = deps.kv;
    this.bytes = deps.bytes;
  }

  async get(id: string): Promise<Versioned<UploadRecord> | null> {
    const found = await this.kv.get(recordKey(id));
    if (!found) return null;
    const parsed = UploadRecordSchema.safeParse(found.data);
    if (!parsed.success) {
      console.warn(`[incidentlab-uploads] skipping corrupt record ${recordKey(id)}`);
      return null;
    }
    return { data: parsed.data, etag: found.etag };
  }

  /** Conditional write: `expectedEtag === null` creates. False when someone else won. */
  save(record: UploadRecord, expectedEtag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(recordKey(record.id), UploadRecordSchema.parse(record), expectedEtag);
  }

  /** Ids of every stored upload record (for the expiry sweep). */
  async listIds(): Promise<string[]> {
    const keys = await this.kv.listKeys("upload:");
    return keys.map((k) => RECORD_KEY.exec(k)?.[1]).filter((id): id is string => id !== undefined);
  }

  async markVerified(id: string, sha256: string, at: string): Promise<void> {
    await this.kv.set(`${verifiedPrefix(id)}${sha256}`, { at });
  }
  async verifiedFiles(id: string): Promise<Set<string>> {
    const prefix = verifiedPrefix(id);
    return new Set((await this.kv.listKeys(prefix)).map((k) => k.slice(prefix.length)));
  }

  async putPart(id: string, name: UploadPartName, bytes: Uint8Array): Promise<void> {
    await this.bytes.setBytes(`${partPrefix(id)}${name}`, bytes);
  }
  getPart(id: string, name: UploadPartName): Promise<Uint8Array | null> {
    return this.bytes.getBytes(`${partPrefix(id)}${name}`);
  }
  async partNames(id: string): Promise<UploadPartName[]> {
    const prefix = partPrefix(id);
    return (await this.bytes.listKeys(prefix))
      .map((k) => UploadPartNameSchema.safeParse(k.slice(prefix.length)))
      .flatMap((p) => (p.success ? [p.data] : []));
  }

  /** Drops the parts and verification markers (after finalize, the record stays until it expires). */
  async removeScratch(id: string): Promise<void> {
    for (const key of await this.bytes.listKeys(partPrefix(id))) await this.bytes.deleteBytes(key);
    for (const key of await this.kv.listKeys(verifiedPrefix(id))) await this.kv.delete(key);
  }

  /** Drops everything an upload stored under `upload:` (its evidence chunks stay: they are shared). */
  async remove(id: string): Promise<void> {
    await this.removeScratch(id);
    await this.kv.delete(recordKey(id));
  }
}
