// Minimal key-value abstraction over Netlify Blobs (prod) and an in-memory map (tests / local).
// Repositories build on this; nothing above the repository layer touches storage directly.
import { getStore } from "@netlify/blobs";

export type Versioned<T> = { readonly data: T; readonly etag: string };

export interface KvStore {
  get(key: string): Promise<Versioned<unknown> | null>;
  /** Conditional write. `expectedEtag === null` means "only if new". Returns false when the condition fails. */
  setIfMatch(key: string, value: unknown, expectedEtag: string | null): Promise<boolean>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

const READ_CONCURRENCY = 10;

export const mapWithConcurrency = async <T, R>(items: readonly T[], fn: (item: T) => Promise<R>, limit = READ_CONCURRENCY): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
};

type BlobStore = ReturnType<typeof getStore>;

export class BlobsKvStore implements KvStore {
  private readonly injected: BlobStore | undefined;

  constructor(store?: BlobStore) {
    this.injected = store;
  }

  // Resolve the store on EVERY call: getStore() reads the per-request Blobs token from the
  // function context, and a store cached at cold start keeps an expired token on warm
  // instances ("Failed to decode token: Token expired") -> every request 500s.
  private get store(): BlobStore {
    return this.injected ?? getStore({ name: "incidentlab-v2", consistency: "strong" });
  }

  async get(key: string): Promise<Versioned<unknown> | null> {
    const entry = await this.store.getWithMetadata(key, { type: "json" });
    if (!entry || !entry.etag) return null;
    const data: unknown = entry.data;
    return { data, etag: entry.etag };
  }
  async setIfMatch(key: string, value: unknown, expectedEtag: string | null): Promise<boolean> {
    const result =
      expectedEtag === null
        ? await this.store.setJSON(key, value, { onlyIfNew: true })
        : await this.store.setJSON(key, value, { onlyIfMatch: expectedEtag });
    return result.modified;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.store.setJSON(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    const { blobs } = await this.store.list({ prefix });
    return blobs.map((b) => b.key);
  }
}

// Yields to the event loop so concurrent callers interleave like they would against a real store.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class InMemoryKvStore implements KvStore {
  private readonly entries = new Map<string, { json: string; version: number }>();

  async get(key: string): Promise<Versioned<unknown> | null> {
    await tick();
    const found = this.entries.get(key);
    if (!found) return null;
    const data: unknown = JSON.parse(found.json);
    return { data, etag: String(found.version) };
  }
  async setIfMatch(key: string, value: unknown, expectedEtag: string | null): Promise<boolean> {
    await tick();
    const current = this.entries.get(key);
    const ok = expectedEtag === null ? current === undefined : current !== undefined && String(current.version) === expectedEtag;
    if (!ok) return false;
    this.entries.set(key, { json: JSON.stringify(value), version: (current?.version ?? 0) + 1 });
    return true;
  }
  async set(key: string, value: unknown): Promise<void> {
    const current = this.entries.get(key);
    this.entries.set(key, { json: JSON.stringify(value), version: (current?.version ?? 0) + 1 });
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
