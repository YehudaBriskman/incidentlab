// Client side of the chunked case upload (#66), shared by the CLI (scripts/data.ts upload) and the upload
// page that follows. Web APIs only (fetch-shaped transport, crypto.subtle, shared/zip.ts).
//
// It validates the package locally first (the full validateCasePackage, including the evidence.zip
// listing the server does not re-read), then: create the upload, send the missing chunks (at most
// `parallel` at a time, each retried), send the named parts, finalize into a draft and optionally publish.
// Re-running after a failure resumes: the server lists only the chunks it still lacks.
import {
  ChunkResponseSchema,
  CreateUploadResponseSchema,
  FinalizeResponseSchema,
  PartResponseSchema,
  PublishResponseSchema,
  UPLOAD_LIMITS,
  partNameForEntry,
} from "./author-contract.ts";
import type { CreateUploadResponse, FinalizeResponse, PublishResponse, UploadPartName } from "./author-contract.ts";
import { PACKAGE_ENTRIES, EVIDENCE_PREFIX, validateCasePackage } from "./case-package.ts";
import { EVIDENCE_CHUNK_BYTES } from "./case-records.ts";
import { ErrorBodySchema } from "./contract.ts";
import { openZip } from "./zip.ts";
import type { z } from "zod";

export type UploadRequest = { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: Uint8Array<ArrayBuffer> | string };
/** Sends one request to the API; `path` starts with /api/. The CLI adds the base URL and X-Admin-Key. */
export type UploadTransport = (path: string, init: UploadRequest) => Promise<Response>;

export type UploadProgress =
  | { readonly phase: "validated"; readonly caseId: string; readonly files: number; readonly bytes: number }
  | { readonly phase: "created"; readonly uploadId: string; readonly missingChunks: number; readonly totalChunks: number }
  | { readonly phase: "chunk"; readonly sent: number; readonly total: number; readonly bytes: number }
  | { readonly phase: "parts"; readonly sent: number; readonly total: number }
  | { readonly phase: "finalized"; readonly version: number }
  | { readonly phase: "published"; readonly version: number };

export type UploadOptions = {
  readonly send: UploadTransport;
  readonly publish?: boolean;
  readonly acceptAnswerChanges?: boolean;
  readonly parallel?: number;
  readonly retries?: number;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** waits between retries (tests pass a no-op) */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type UploadOutcome = {
  readonly upload: CreateUploadResponse;
  readonly chunksSent: number;
  readonly chunksSkipped: number;
  readonly draft: FinalizeResponse;
  readonly published: PublishResponse | null;
};

export class UploadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: readonly string[];
  constructor(message: string, options: { status?: number; code?: string | undefined; details?: readonly string[] } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code;
    this.details = options.details ?? [];
  }
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const failure = async (res: Response, what: string): Promise<UploadError> => {
  const text = await res.text();
  let parsed: z.infer<typeof ErrorBodySchema> | null = null;
  try {
    const body = ErrorBodySchema.safeParse(JSON.parse(text));
    parsed = body.success ? body.data : null;
  } catch {
    parsed = null;
  }
  return new UploadError(`${what}: ${res.status} ${parsed?.error ?? text.slice(0, 200)}`, { status: res.status, code: parsed?.code, details: parsed?.details ?? [] });
};

/** 5xx, 429 and network errors are worth retrying; a 4xx answer is final. */
const retryable = (error: unknown): boolean => !(error instanceof UploadError) || error.status === 0 || error.status === 429 || error.status >= 500;

export async function uploadCasePackage(bytes: Uint8Array, options: UploadOptions): Promise<UploadOutcome> {
  const { send } = options;
  const parallel = Math.max(1, Math.min(UPLOAD_LIMITS.parallelChunks, options.parallel ?? UPLOAD_LIMITS.parallelChunks));
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = options.onProgress ?? (() => undefined);

  const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let n = 0; ; n += 1) {
      try {
        return await run();
      } catch (error) {
        if (n >= retries || !retryable(error)) throw error;
        await sleep(500 * 2 ** n);
      }
    }
  };
  const call = async <T>(schema: z.ZodType<T>, path: string, init: UploadRequest, what: string): Promise<T> => {
    let res: Response;
    try {
      res = await send(path, init);
    } catch (error) {
      throw new UploadError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) throw await failure(res, what);
    return schema.parse(await res.json());
  };
  const postJson = <T>(schema: z.ZodType<T>, path: string, body: unknown, what: string): Promise<T> =>
    call(schema, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, what);
  const putBytes = <T>(schema: z.ZodType<T>, path: string, body: Uint8Array<ArrayBuffer>, what: string): Promise<T> =>
    call(schema, path, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body }, what);

  // 1. The same checks the build runs, before anything is sent.
  const report = await validateCasePackage(bytes);
  if (!report.ok || !report.parsed) throw new UploadError("the package is not valid", { code: "invalid-package", details: report.errors });
  const { manifest } = report.parsed;
  const zip = openZip(bytes);
  const evidenceZip = await zip.read(PACKAGE_ENTRIES.evidenceZip);
  const zipSha = await sha256Hex(evidenceZip);
  progress({ phase: "validated", caseId: manifest.id, files: manifest.evidence.length, bytes: manifest.evidence.reduce((s, e) => s + e.size, evidenceZip.byteLength) });

  // 2. Create the upload; the server answers with the chunks it does not hold yet.
  const upload = await attempt(() =>
    postJson(CreateUploadResponseSchema, "/api/author/uploads", { manifest, evidenceZip: { sha256: zipSha, size: evidenceZip.byteLength } }, "start upload"),
  );
  const chunksBySha = new Map<string, number>(manifest.evidence.map((e) => [e.sha256, e.chunks]));
  chunksBySha.set(zipSha, Math.ceil(evidenceZip.byteLength / EVIDENCE_CHUNK_BYTES));
  const totalChunks = [...chunksBySha.values()].reduce((s, n) => s + n, 0);
  progress({ phase: "created", uploadId: upload.uploadId, missingChunks: upload.missingChunks.length, totalChunks });

  // 3. Missing chunks, `parallel` at a time.
  const entryFor = new Map<string, string>(manifest.evidence.map((e) => [e.sha256, `${EVIDENCE_PREFIX}${e.path}`]));
  const cache = new Map<string, Uint8Array<ArrayBuffer>>([[zipSha, evidenceZip]]);
  const fileBytes = async (sha: string): Promise<Uint8Array<ArrayBuffer>> => {
    const cached = cache.get(sha);
    if (cached) return cached;
    const entry = entryFor.get(sha);
    if (!entry) throw new UploadError(`the server asked for an unknown file ${sha}`);
    const read = await zip.read(entry);
    cache.set(sha, read);
    return read;
  };
  let sent = 0;
  let sentBytes = 0;
  const queue = [...upload.missingChunks];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { sha256, index } = next;
      const file = await fileBytes(sha256);
      const chunk = file.slice(index * upload.chunkBytes, (index + 1) * upload.chunkBytes);
      await attempt(() => putBytes(ChunkResponseSchema, `/api/author/uploads/${upload.uploadId}/chunks/${sha256}/${index}`, chunk, `chunk ${index} of ${sha256.slice(0, 12)}`));
      sent += 1;
      sentBytes += chunk.byteLength;
      progress({ phase: "chunk", sent, total: upload.missingChunks.length, bytes: sentBytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, () => worker()));

  // 4. Named parts: every required one, plus the optional Hebrew debrief when the package has it.
  const names: UploadPartName[] = [...upload.parts];
  if (zip.get(PACKAGE_ENTRIES.debriefHe)) names.push("sealed.debrief.he.md");
  let partsSent = 0;
  for (const name of names) {
    const entry = zip.entries.map((e) => e.name).find((n) => partNameForEntry(n) === name);
    if (!entry) throw new UploadError(`the package has no entry for part ${name}`);
    const body = await zip.read(entry);
    await attempt(() => putBytes(PartResponseSchema, `/api/author/uploads/${upload.uploadId}/parts/${name}`, body, `part ${name}`));
    partsSent += 1;
    progress({ phase: "parts", sent: partsSent, total: names.length });
  }

  // 5. Finalize into a draft, then publish if asked.
  const draft = await attempt(() => postJson(FinalizeResponseSchema, `/api/author/uploads/${upload.uploadId}/finalize`, {}, "finalize"));
  progress({ phase: "finalized", version: draft.version });
  let published: PublishResponse | null = null;
  if (options.publish) {
    published = await publishCaseVersion(send, draft.caseId, draft.version, options.acceptAnswerChanges ?? false).catch((error: unknown) => {
      if (!(error instanceof UploadError)) throw error;
      throw new UploadError(`draft v${draft.version} is stored, but ${error.message}`, { status: error.status, code: error.code, details: error.details });
    });
    progress({ phase: "published", version: published.publishedVersion });
  }
  return { upload, chunksSent: sent, chunksSkipped: totalChunks - upload.missingChunks.length, draft, published };
}

/** Publishes a stored version (an older one is a rollback). 409 code "answer-drift" unless acceptAnswerChanges. */
export async function publishCaseVersion(send: UploadTransport, caseId: string, version: number, acceptAnswerChanges: boolean): Promise<PublishResponse> {
  let res: Response;
  try {
    res = await send(`/api/author/cases/${encodeURIComponent(caseId)}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, acceptAnswerChanges }),
    });
  } catch (error) {
    throw new UploadError(`publish: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw await failure(res, "publish");
  return PublishResponseSchema.parse(await res.json());
}
