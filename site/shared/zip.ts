// A small zip reader for case packages (docs/CASE_CONTRACT.md, "Case package"), used by the build-time
// validator (scripts/check-packages.mts) and meant for the browser upload too (#66). It has no Node imports:
// it parses the central directory itself and inflates with the built-in DecompressionStream('deflate-raw'),
// which Node and every current browser provide.
//
// Supported: stored (0) and deflated (8) entries, UTF-8 names, CRC-32 and size checks on every read.
// Not supported (rejected with a ZipError): zip64, multi-disk archives, encrypted entries.

export class ZipError extends Error {
  override name = "ZipError";
}

export interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchive {
  /** entries in central-directory order */
  readonly entries: readonly ZipEntry[];
  get(name: string): ZipEntry | undefined;
  /** the entry's uncompressed bytes, checked against its size and CRC-32 */
  read(entry: ZipEntry | string): Promise<Uint8Array>;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Rejects absolute paths, backslashes and empty, '.' or '..' segments (a trailing '/' marks a directory). */
const isSafeName = (name: string): boolean => {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
};

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Failures surface on the readable side; keep the writer's promises from rejecting unhandled.
  writer.write(new Uint8Array(data)).catch(() => undefined);
  writer.close().catch(() => undefined);
  try {
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch (err) {
    throw new ZipError(`corrupt deflate data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function openZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);

  if (bytes.length < EOCD_MIN) throw new ZipError("not a zip: too short");
  let eocd = -1;
  for (let at = bytes.length - EOCD_MIN; at >= Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT); at--) {
    if (u32(at) === SIG_EOCD && at + EOCD_MIN + u16(at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip: no end of central directory record");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) throw new ZipError("multi-disk zips are not supported");
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
  if (u16(eocd + 8) !== count) throw new ZipError("corrupt central directory: entry counts disagree");
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt central directory: it overlaps the end record");

  const names = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cdOffset + cdSize || u32(at) !== SIG_CENTRAL) throw new ZipError(`corrupt central directory at entry ${i}`);
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > cdOffset + cdSize) throw new ZipError(`corrupt central directory at entry ${i}`);
    let name: string;
    try {
      name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    } catch {
      throw new ZipError(`entry ${i} has a name that is not UTF-8`);
    }
    if (flags & 0x1) throw new ZipError(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw new ZipError(`${name}: compression method ${method} is not supported`);
    if (!isSafeName(name)) throw new ZipError(`${name}: unsafe entry name`);
    if (byName.has(name)) throw new ZipError(`${name}: duplicate entry`);
    const entry: ZipEntry = {
      name,
      method,
      crc32: u32(at + 16),
      compressedSize: u32(at + 20),
      size: u32(at + 24),
      localHeaderOffset: u32(at + 42),
    };
    if (entry.localHeaderOffset + 30 > cdOffset) throw new ZipError(`${name}: local header outside the archive`);
    entries.push(entry);
    byName.set(name, entry);
    at = next;
  }
  if (at !== cdOffset + cdSize) throw new ZipError("corrupt central directory: size does not match its entries");

  return {
    entries,
    get: (name) => byName.get(name),
    async read(ref) {
      const entry = typeof ref === "string" ? byName.get(ref) : ref;
      if (!entry) throw new ZipError(`no entry ${String(ref)}`);
      const local = entry.localHeaderOffset;
      if (u32(local) !== SIG_LOCAL) throw new ZipError(`${entry.name}: bad local header`);
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      const end = start + entry.compressedSize;
      if (end > cdOffset) throw new ZipError(`${entry.name}: data runs past the central directory`);
      const raw = bytes.subarray(start, end);
      const data = entry.method === 0 ? raw.slice() : await inflateRaw(raw);
      if (data.length !== entry.size) throw new ZipError(`${entry.name}: size ${data.length}, expected ${entry.size}`);
      if (crc32(data) !== entry.crc32) throw new ZipError(`${entry.name}: CRC-32 mismatch`);
      return data;
    },
  };
}
