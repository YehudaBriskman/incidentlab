import { getStore } from "@netlify/blobs";
import { z } from "zod";
import { PlayerRecordSchema } from "../domain/types.ts";
import type { PlayerRecord } from "../domain/types.ts";
import type { PlayerRepository, VersionedPlayer } from "./PlayerRepository.ts";

const RATE_LIMIT_PREFIX = "ratelimit:";
const READ_CONCURRENCY = 10;
const IpHitsSchema = z.array(z.number());

type BlobStore = ReturnType<typeof getStore>;

const mapWithConcurrency = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
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

export class BlobsPlayerRepository implements PlayerRepository {
  private readonly store: BlobStore;

  constructor(store?: BlobStore) {
    this.store = store ?? getStore({ name: "incidentlab-players", consistency: "strong" });
  }

  async get(playerId: string): Promise<VersionedPlayer | null> {
    const entry = await this.store.getWithMetadata(playerId, { type: "json" });
    if (!entry || !entry.etag) return null;
    const raw: unknown = entry.data;
    const parsed = PlayerRecordSchema.safeParse(raw);
    return parsed.success ? { record: parsed.data, etag: entry.etag } : null;
  }
  async saveIfMatch(player: PlayerRecord, expectedEtag: string | null): Promise<boolean> {
    const result =
      expectedEtag === null
        ? await this.store.setJSON(player.id, player, { onlyIfNew: true })
        : await this.store.setJSON(player.id, player, { onlyIfMatch: expectedEtag });
    return result.modified;
  }
  async delete(playerId: string): Promise<void> {
    await this.store.delete(playerId);
  }
  private async playerKeys(): Promise<string[]> {
    const { blobs } = await this.store.list();
    return blobs.map((b) => b.key).filter((key) => !key.startsWith(RATE_LIMIT_PREFIX));
  }
  async list(): Promise<PlayerRecord[]> {
    const keys = await this.playerKeys();
    const records = await mapWithConcurrency(keys, READ_CONCURRENCY, async (key) => (await this.get(key))?.record ?? null);
    return records.filter((r): r is PlayerRecord => r !== null);
  }
  async deleteAll(): Promise<void> {
    const keys = await this.playerKeys();
    await mapWithConcurrency(keys, READ_CONCURRENCY, (key) => this.store.delete(key));
  }
  async getIpHits(ipKey: string): Promise<number[]> {
    const raw: unknown = await this.store.get(RATE_LIMIT_PREFIX + ipKey, { type: "json" });
    const parsed = IpHitsSchema.safeParse(raw);
    return parsed.success ? parsed.data : [];
  }
  async setIpHits(ipKey: string, hits: number[]): Promise<void> {
    await this.store.setJSON(RATE_LIMIT_PREFIX + ipKey, hits);
  }
}
