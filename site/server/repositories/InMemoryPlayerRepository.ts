import type { PlayerRecord } from "../domain/types.ts";
import type { PlayerRepository, VersionedPlayer } from "./PlayerRepository.ts";

// Yields to the event loop so concurrent callers interleave like they would against a real store.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, { record: PlayerRecord; version: number }>();
  private readonly ipHits = new Map<string, number[]>();

  async get(playerId: string): Promise<VersionedPlayer | null> {
    await tick();
    const found = this.players.get(playerId);
    return found ? { record: structuredClone(found.record), etag: String(found.version) } : null;
  }
  async saveIfMatch(player: PlayerRecord, expectedEtag: string | null): Promise<boolean> {
    await tick();
    const current = this.players.get(player.id);
    if (expectedEtag === null ? current !== undefined : current === undefined || String(current.version) !== expectedEtag) {
      return false;
    }
    this.players.set(player.id, { record: structuredClone(player), version: (current?.version ?? 0) + 1 });
    return true;
  }
  async delete(playerId: string): Promise<void> {
    this.players.delete(playerId);
  }
  async list(): Promise<PlayerRecord[]> {
    return [...this.players.values()].map((p) => structuredClone(p.record));
  }
  async deleteAll(): Promise<void> {
    this.players.clear();
  }
  async getIpHits(ipKey: string): Promise<number[]> {
    return [...(this.ipHits.get(ipKey) ?? [])];
  }
  async setIpHits(ipKey: string, hits: number[]): Promise<void> {
    this.ipHits.set(ipKey, [...hits]);
  }
}
