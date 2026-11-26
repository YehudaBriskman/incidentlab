// Garbage collection of evidence chunks (#122). Chunks are content-addressed and shared across cases and
// versions, so nothing deletes them on case delete; uploads that never finish (or retried uploads) can leave
// chunks no version uses. This is a mark-and-sweep run by `scripts/data.ts gc-evidence` (dry run by default).
//
// Mark: every file named by any case version's evidence index or evidence zip (published, draft, archived or
// trashed: versions are never purged, so all of them count), plus the files of every live upload (not yet
// finalized and not expired: its chunks may be arriving right now).
// Sweep: `evidence:<sha256>:<n>` keys whose file nobody names, or whose chunk number is past the file's count.
//
// Safety, because a wrong sweep deletes live evidence that only a re-upload can restore:
// - the mark phase reads records strictly: an unreadable index aborts the run (the normal readers treat a
//   corrupt record as missing, which here would make its chunks look unreferenced);
// - nothing referenced while chunks exist aborts the run (a failed listing must not look like an empty DB);
// - `apply` refuses while an upload is live, and deletes exactly the keys of a fresh plan.
import { z } from "zod";
import { EvidenceEntrySchema } from "../../shared/case-records.ts";
import type { ByteStore } from "../repositories/ByteStore.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { UploadRecordSchema } from "../repositories/upload-repository.ts";

const INDEX_KEY = /^case:[a-z0-9][a-z0-9-]*:v\d+:evidence-index$/;
const ZIP_KEY = /^case:[a-z0-9][a-z0-9-]*:v\d+:evidence-zip$/;
const UPLOAD_KEY = /^upload:[0-9a-f]{24}$/;
const CHUNK_KEY = /^evidence:([0-9a-f]{64}):(0|[1-9][0-9]*)$/;

export type GcCandidate = { readonly key: string; readonly reason: "unreferenced" | "past-end" };
export type GcPlan = {
  readonly referencedFiles: number;
  readonly storedChunks: number;
  readonly liveUploads: number;
  readonly candidates: readonly GcCandidate[];
};

export class GcAbort extends Error {}

export class EvidenceGcService {
  private readonly kv: KvStore;
  private readonly bytes: ByteStore;
  private readonly now: () => Date;

  constructor(deps: { kv: KvStore; bytes: ByteStore; now: () => Date }) {
    this.kv = deps.kv;
    this.bytes = deps.bytes;
    this.now = deps.now;
  }

  /** Reads one record strictly: missing or invalid stops the whole run. */
  private async strict<S extends z.ZodType>(key: string, schema: S): Promise<z.infer<S>> {
    const found = await this.kv.get(key);
    if (found === null) throw new GcAbort(`${key} was listed but could not be read; nothing deleted`);
    const parsed = schema.safeParse(found.data);
    if (!parsed.success) throw new GcAbort(`${key} is not a valid record; fix it before collecting; nothing deleted`);
    return parsed.data;
  }

  /** What a sweep would delete right now. Read-only. */
  async plan(): Promise<GcPlan> {
    const wanted = new Map<string, number>(); // sha256 -> chunk count
    const want = (sha256: string, chunks: number): void => {
      wanted.set(sha256, Math.max(chunks, wanted.get(sha256) ?? 0));
    };

    const caseKeys = await this.kv.listKeys("case:");
    const indexes = await mapWithConcurrency(caseKeys.filter((k) => INDEX_KEY.test(k)), (k) => this.strict(k, z.array(EvidenceEntrySchema)));
    for (const index of indexes) for (const entry of index) want(entry.sha256, entry.chunks);
    const zips = await mapWithConcurrency(caseKeys.filter((k) => ZIP_KEY.test(k)), (k) => this.strict(k, EvidenceEntrySchema));
    for (const zip of zips) want(zip.sha256, zip.chunks);

    const uploads = await mapWithConcurrency((await this.kv.listKeys("upload:")).filter((k) => UPLOAD_KEY.test(k)), (k) => this.strict(k, UploadRecordSchema));
    const nowMs = this.now().getTime();
    const live = uploads.filter((u) => u.finalized === null && Date.parse(u.expiresAt) > nowMs);
    for (const upload of live) {
      for (const entry of upload.manifest.evidence) want(entry.sha256, entry.chunks);
      want(upload.evidenceZip.sha256, upload.evidenceZip.chunks);
    }

    const stored = (await this.bytes.listKeys("evidence:")).filter((k) => CHUNK_KEY.test(k));
    if (wanted.size === 0 && stored.length > 0) {
      throw new GcAbort(`no case version or upload references any evidence, yet ${stored.length} chunks are stored; refusing to treat that as garbage`);
    }
    const candidates: GcCandidate[] = [];
    for (const key of stored) {
      const match = CHUNK_KEY.exec(key);
      if (!match) continue;
      const count = wanted.get(match[1] ?? "");
      if (count === undefined) candidates.push({ key, reason: "unreferenced" });
      else if (Number(match[2]) >= count) candidates.push({ key, reason: "past-end" });
    }
    return { referencedFiles: wanted.size, storedChunks: stored.length, liveUploads: live.length, candidates };
  }

  /** Plans again and deletes exactly its candidates. Refuses while an upload is live. Returns the deleted keys. */
  async sweep(): Promise<string[]> {
    const fresh = await this.plan();
    if (fresh.liveUploads > 0) throw new GcAbort(`${fresh.liveUploads} upload(s) in progress; run again when they finish or expire`);
    const deleted: string[] = [];
    for (const { key } of fresh.candidates) {
      await this.bytes.deleteBytes(key);
      deleted.push(key);
    }
    return deleted;
  }
}
