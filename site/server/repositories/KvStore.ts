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

/** The live data store. Never rename it: a new name means an empty store (that's how round-1 data was orphaned). */
export const PRIMARY_STORE = "incidentlab-v2";
/** Daily and pre-deploy snapshots live in a separate store so a bad write to the primary can't touch them. */
export const BACKUP_STORE = "incidentlab-backups";
/** Pre-accounts store (round 1). Read-only: only migration 002 reads it. */
export const LEGACY_STORE = "incidentlab-players";

/** Explicit credentials for scripts that run outside a Netlify Function (backup/restore/migrate CLI). */
export type BlobsCredentials = { readonly siteID: string; readonly token: string };

export class BlobsKvStore implements KvStore {
  private readonly injected: BlobStore | undefined;
  private readonly name: string;
  private readonly credentials: BlobsCredentials | undefined;

  constructor(options: { store?: BlobStore; name?: string; credentials?: BlobsCredentials } = {}) {
    this.injected = options.store;
    this.name = options.name ?? PRIMARY_STORE;
    this.credentials = options.credentials;
  }

  // Resolve the store on EVERY call: getStore() reads the per-request Blobs token from the
  // function context, and a store cached at cold start keeps an expired token on warm
  // instances ("Failed to decode token: Token expired") -> every request 500s.
  private get store(): BlobStore {
    if (this.injected) return this.injected;
    return this.credentials
      ? getStore({ name: this.name, consistency: "strong", siteID: this.credentials.siteID, token: this.credentials.token })
      : getStore({ name: this.name, consistency: "strong" });
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
