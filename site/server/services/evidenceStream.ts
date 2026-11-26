// Evidence delivery for DB-stored cases: resolves /evidence/db/<id>/v<n>/files/<path> and
// /evidence/db/<id>/v<n>.zip to an EvidenceEntry, then streams its 4 MiB chunks in order, with single
// byte-range support (206). The Edge Function (site/netlify/edge-functions/evidence.ts), the local server
// and the node tests all go through `EvidenceService.respond`.
//
// Web APIs only (no node: imports, no Buffer): the Edge Function runs on Deno.
import { CaseIdSchema } from "../../shared/contract.ts";
import { EVIDENCE_CHUNK_BYTES, EvidencePathSchema } from "../../shared/case-records.ts";
import type { CaseMeta, EvidenceEntry, EvidenceLocation } from "../../shared/case-records.ts";
import type { CaseRepository, EvidenceChunkRepository } from "../repositories/case-repository.ts";

export const EVIDENCE_DB_PREFIX = "/evidence/db/";

/**
 * Where a published case version's evidence is served from: today the Edge Function on this site. This is
 * the single switch point for moving evidence elsewhere (the content API hands it to the browser).
 */
export const evidenceLocation = (caseId: string, version: number): EvidenceLocation => {
  const base = `${EVIDENCE_DB_PREFIX}${encodeURIComponent(caseId)}/v${version}`;
  return { filesBase: `${base}/files/`, zip: `${base}.zip` };
};

/** The name a case's evidence zip downloads as. Toolbox commands say `unzip <caseId>-evidence.zip`. */
export const evidenceZipName = (caseId: string): string => `${caseId}-evidence.zip`;

/** Public routes see only `publishedVersion`, and only while the case is published (not a draft, not trashed). */
export const isPublicVersion = (meta: CaseMeta, version: number): boolean => meta.status === "published" && meta.publishedVersion === version;

export type EvidenceTarget =
  | { readonly kind: "file"; readonly caseId: string; readonly version: number; readonly path: string }
  | { readonly kind: "zip"; readonly caseId: string; readonly version: number };

const VERSION = /^v([1-9][0-9]{0,8})$/;
const ZIP_VERSION = /^v([1-9][0-9]{0,8})\.zip$/;

const decodeSegments = (rest: string): string[] | null => {
  try {
    return rest.split("/").map((s) => decodeURIComponent(s));
  } catch {
    return null; // malformed percent-encoding
  }
};

/** Parses a request pathname. Anything that is not exactly one of the two URL shapes is null (404). */
export const parseEvidencePath = (pathname: string): EvidenceTarget | null => {
  if (!pathname.startsWith(EVIDENCE_DB_PREFIX)) return null;
  const segments = decodeSegments(pathname.slice(EVIDENCE_DB_PREFIX.length));
  if (!segments) return null;
  const [caseId, second, third, ...rest] = segments;
  if (caseId === undefined || !CaseIdSchema.safeParse(caseId).success || second === undefined) return null;
  if (segments.length === 2) {
    const zip = ZIP_VERSION.exec(second);
    return zip?.[1] ? { kind: "zip", caseId, version: Number(zip[1]) } : null;
  }
  const version = VERSION.exec(second);
  if (!version?.[1] || third !== "files" || rest.length === 0) return null;
  const path = rest.join("/");
  return EvidencePathSchema.safeParse(path).success ? { kind: "file", caseId, version: Number(version[1]), path } : null;
};

/** An inclusive byte range. */
export type ByteRange = { readonly start: number; readonly end: number };

/**
 * Parses a `Range` header for a resource of `size` bytes (RFC 9110 §14.1.2, single range only).
 * null: no usable range, serve the whole file (absent, malformed or multi-range headers);
 * "unsatisfiable": answer 416.
 */
export const parseRange = (header: string | null, size: number): ByteRange | "unsatisfiable" | null => {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? null : { start, end };
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  zip: "application/zip",
  json: "application/json; charset=utf-8",
  pcap: "application/vnd.tcpdump.pcap",
  gz: "application/gzip",
  csv: "text/csv; charset=utf-8",
};
/** Content-Type from the extension. Anything textual (logs, html, svg, markdown...) is text/plain, so an
 *  evidence file can never run as a page on the site's origin. */
export const contentTypeFor = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const known = CONTENT_TYPES[ext];
  if (known) return known;
  return ["bin", "dat", "db", "sqlite", "img", "raw", "dmp", "evtx"].includes(ext) ? "application/octet-stream" : "text/plain; charset=utf-8";
};

const etagOf = (entry: EvidenceEntry): string => `"${entry.sha256}"`;

const matchesEtag = (header: string | null, etag: string): boolean =>
  header !== null && header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });

/**
 * Streams bytes [start, end] of a chunked file, one chunk at a time with one chunk read ahead. A missing
 * or wrong-sized chunk errors the stream (the client sees a truncated body, never wrong bytes).
 */
export const streamChunks = (chunks: EvidenceChunkRepository, entry: EvidenceEntry, range: ByteRange): ReadableStream<Uint8Array> => {
  const last = Math.floor(range.end / EVIDENCE_CHUNK_BYTES);
  let index = Math.floor(range.start / EVIDENCE_CHUNK_BYTES);
  const fetchChunk = (i: number): Promise<Uint8Array | null> | null => (i <= last ? chunks.getChunk(entry.sha256, i) : null);
  let pending = fetchChunk(index);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending === null) {
        controller.close();
        return;
      }
      const bytes = await pending;
      const base = index * EVIDENCE_CHUNK_BYTES;
      const expected = Math.min(EVIDENCE_CHUNK_BYTES, entry.size - base);
      if (bytes === null || bytes.byteLength !== expected) {
        console.error(`[incidentlab-evidence] chunk ${index} of ${entry.sha256} is ${bytes === null ? "missing" : "the wrong size"}`);
        controller.error(new Error("evidence chunk unavailable"));
        return;
      }
      index += 1;
      pending = fetchChunk(index);
      controller.enqueue(bytes.subarray(Math.max(range.start - base, 0), Math.min(range.end - base + 1, bytes.byteLength)));
    },
  });
};

const IMMUTABLE = "public, max-age=31536000, immutable";
// Edge Function responses do not get netlify.toml [[headers]], so the hardening headers are set here.
const HARDENING = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };

const notFound = (): Response =>
  new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...HARDENING } });

export type ResolvedEvidence = { readonly entry: EvidenceEntry; readonly downloadName: string | null };

export class EvidenceService {
  private readonly cases: CaseRepository;
  private readonly chunks: EvidenceChunkRepository;

  constructor(deps: { cases: CaseRepository; chunks: EvidenceChunkRepository }) {
    this.cases = deps.cases;
    this.chunks = deps.chunks;
  }

  /** The entry behind a target, or null when the case, version or file is unknown or not published. */
  async resolve(target: EvidenceTarget): Promise<ResolvedEvidence | null> {
    const meta = await this.cases.getMeta(target.caseId);
    if (!meta || !isPublicVersion(meta.data, target.version)) return null;
    if (target.kind === "zip") {
      const entry = await this.cases.getEvidenceZip(target.caseId, target.version);
      return entry ? { entry, downloadName: evidenceZipName(target.caseId) } : null;
    }
    const index = await this.cases.getEvidenceIndex(target.caseId, target.version);
    const entry = index?.find((e) => e.path === target.path);
    return entry ? { entry, downloadName: null } : null;
  }

  /** Streams a resolved entry, whole or one range of it. */
  read(entry: EvidenceEntry, range?: ByteRange): ReadableStream<Uint8Array> {
    return streamChunks(this.chunks, entry, range ?? { start: 0, end: entry.size - 1 });
  }

  /** The full HTTP exchange: GET/HEAD, ETag/304, Range/206/416, immutable caching, 404. */
  async respond(req: Request): Promise<Response> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store", ...HARDENING } });
    }
    const target = parseEvidencePath(new URL(req.url).pathname);
    const resolved = target ? await this.resolve(target) : null;
    if (!target || !resolved) return notFound();
    const { entry } = resolved;
    const etag = etagOf(entry);
    const base: Record<string, string> = {
      "cache-control": IMMUTABLE,
      etag,
      "accept-ranges": "bytes",
      "content-type": target.kind === "zip" ? "application/zip" : contentTypeFor(target.path),
      ...HARDENING,
      ...(resolved.downloadName ? { "content-disposition": `attachment; filename="${resolved.downloadName}"` } : {}),
    };
    if (matchesEtag(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: base });

    const ifRange = req.headers.get("if-range");
    const range = ifRange !== null && ifRange.trim() !== etag ? null : parseRange(req.headers.get("range"), entry.size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${entry.size}` } });
    }
    const body = (bytes: ByteRange | undefined): ReadableStream<Uint8Array> | null =>
      method === "HEAD" || entry.size === 0 ? null : this.read(entry, bytes);
    if (range === null) {
      return new Response(body(undefined), { status: 200, headers: { ...base, "content-length": String(entry.size) } });
    }
    return new Response(body(range), {
      status: 206,
      headers: { ...base, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${entry.size}` },
    });
  }
}
