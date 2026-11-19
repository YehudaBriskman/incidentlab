import type { PlayerRecord } from "../domain/types.ts";

export type VersionedPlayer = { readonly record: PlayerRecord; readonly etag: string };

export interface PlayerRepository {
  get(playerId: string): Promise<VersionedPlayer | null>;
  /**
   * Conditional write. `expectedEtag === null` means "only if new".
   * Returns false (without writing) when the stored version no longer matches.
   */
  saveIfMatch(player: PlayerRecord, expectedEtag: string | null): Promise<boolean>;
  delete(playerId: string): Promise<void>;
  list(): Promise<PlayerRecord[]>;
  deleteAll(): Promise<void>;
  /** Timestamps (epoch ms) of recent player creations for a hashed IP key. */
  getIpHits(ipKey: string): Promise<number[]>;
  setIpHits(ipKey: string, hits: number[]): Promise<void>;
}
