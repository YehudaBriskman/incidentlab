// Binary twin of KvStore: raw bytes over the SAME Netlify Blobs store (`incidentlab-v2`), plus an in-memory
// map for tests and tests/local-server.ts. KvStore is JSON-only, so evidence chunks (`evidence:` keys) go
// through this interface instead.
//
// Web APIs only (no node: imports): the evidence Edge Function (Deno) imports this module.
import { getStore } from "@netlify/blobs";
import { PRIMARY_STORE } from "./KvStore.ts";
import type { BlobsCredentials, BlobsConsistency } from "./KvStore.ts";

export interface ByteStore {
  getBytes(key: string): Promise<Uint8Array | null>;
  setBytes(key: string, bytes: Uint8Array): Promise<void>;
  deleteBytes(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

type BlobStore = ReturnType<typeof getStore>;

/** Copies the view into a fresh ArrayBuffer of exactly its length (the Blobs client takes an ArrayBuffer). */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
};

export class BlobsByteStore implements ByteStore {
  private readonly injected: BlobStore | undefined;
  private readonly name: string;
  private readonly credentials: BlobsCredentials | undefined;
  private readonly consistency: BlobsConsistency;

  constructor(options: { store?: BlobStore; name?: string; credentials?: BlobsCredentials; consistency?: BlobsConsistency } = {}) {
    this.injected = options.store;
    this.name = options.name ?? PRIMARY_STORE;
    this.credentials = options.credentials;
    this.consistency = options.consistency ?? "strong";
  }

  // Resolved per call for the same reason as BlobsKvStore: the Blobs token comes from the request context.
  private get store(): BlobStore {
    if (this.injected) return this.injected;
    return this.credentials
      ? getStore({ name: this.name, consistency: this.consistency, siteID: this.credentials.siteID, token: this.credentials.token })
      : getStore({ name: this.name, consistency: this.consistency });
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const buffer = await this.store.get(key, { type: "arrayBuffer" });
    return buffer === null ? null : new Uint8Array(buffer);
  }
  async setBytes(key: string, bytes: Uint8Array): Promise<void> {
    await this.store.set(key, toArrayBuffer(bytes));
  }
  async deleteBytes(key: string): Promise<void> {
    await this.store.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    const { blobs } = await this.store.list({ prefix });
    return blobs.map((b) => b.key);
  }
}

export class InMemoryByteStore implements ByteStore {
  private readonly entries = new Map<string, Uint8Array>();

  async getBytes(key: string): Promise<Uint8Array | null> {
    const found = this.entries.get(key);
    return found === undefined ? null : found.slice(); // a copy, like a real store read
  }
  async setBytes(key: string, bytes: Uint8Array): Promise<void> {
    this.entries.set(key, bytes.slice());
  }
  async deleteBytes(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
