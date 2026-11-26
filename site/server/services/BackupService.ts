// Snapshot, diff and restore the whole primary store. Used by the daily scheduled function, the
// pre-deploy backup in scripts/data.ts, and the restore CLI. A snapshot is plain JSON, so it can also be
// read or edited by hand in an emergency.
import { z } from "zod";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";

/**
 * Keys a JSON snapshot never holds:
 * - ephemeral: rate-limit windows and login sessions are never backed up or restored;
 * - binary: `evidence:` chunks are raw bytes (ByteStore), not JSON. They are content-addressed and rebuilt
 *   from the case package, so a snapshot skips them (and a restore with --prune leaves them alone).
 */
const SKIPPED_PREFIXES = ["ratelimit:", "session:", "evidence:"];
export const isSnapshotKey = (key: string): boolean => !SKIPPED_PREFIXES.some((p) => key.startsWith(p));
const isDurable = isSnapshotKey;

export const SnapshotSchema = z.object({
  format: z.literal("incidentlab-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  source: z.string(),
  entries: z.record(z.string(), z.unknown()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type SnapshotDiff = {
  /** in the snapshot, missing from the store (restore would add) */
  readonly added: string[];
  /** in both, different values (restore would overwrite) */
  readonly changed: string[];
  /** in the store, not in the snapshot (restore leaves them unless prune) */
  readonly extra: string[];
  readonly unchanged: number;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

export const takeSnapshot = async (kv: KvStore, input: { source: string; now: Date }): Promise<Snapshot> => {
  const keys = (await kv.listKeys("")).filter(isDurable).sort();
  const values = await mapWithConcurrency(keys, async (key) => [key, (await kv.get(key))?.data] as const);
  const entries: Record<string, unknown> = {};
  for (const [key, value] of values) if (value !== undefined) entries[key] = value;
  return { format: "incidentlab-backup", version: 1, createdAt: input.now.toISOString(), source: input.source, entries };
};

export const diffSnapshot = async (kv: KvStore, snapshot: Snapshot): Promise<SnapshotDiff> => {
  const current = await takeSnapshot(kv, { source: "current", now: new Date(0) });
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [key, value] of Object.entries(snapshot.entries)) {
    if (!isDurable(key)) continue;
    if (!(key in current.entries)) added.push(key);
    else if (stableJson(current.entries[key]) !== stableJson(value)) changed.push(key);
    else unchanged += 1;
  }
  const extra = Object.keys(current.entries).filter((key) => !(key in snapshot.entries));
  return { added: added.sort(), changed: changed.sort(), extra: extra.sort(), unchanged };
};

/**
 * Writes the snapshot back. Without `prune`, keys created after the snapshot are kept (nothing is lost
 * that the snapshot doesn't know about). With `prune`, they are deleted to match the snapshot exactly.
 */
export const restoreSnapshot = async (kv: KvStore, snapshot: Snapshot, options: { prune: boolean }): Promise<SnapshotDiff> => {
  const diff = await diffSnapshot(kv, snapshot);
  await mapWithConcurrency([...diff.added, ...diff.changed], (key) => kv.set(key, snapshot.entries[key]));
  if (options.prune) await mapWithConcurrency(diff.extra, (key) => kv.delete(key));
  return diff;
};

/** Daily snapshots in the backup store: daily/<YYYY-MM-DD>.json, keeping `retentionDays`. */
export const writeDailySnapshot = async (input: { primary: KvStore; backups: KvStore; now: Date; retentionDays: number }): Promise<{ key: string; entries: number; pruned: number }> => {
  const snapshot = await takeSnapshot(input.primary, { source: "daily", now: input.now });
  const key = `daily/${input.now.toISOString().slice(0, 10)}.json`;
  await input.backups.set(key, snapshot);
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const old = (await input.backups.listKeys("daily/")).filter((k) => k.slice("daily/".length, "daily/".length + 10) < cutoff);
  await mapWithConcurrency(old, (k) => input.backups.delete(k));
  return { key, entries: Object.keys(snapshot.entries).length, pruned: old.length };
};
