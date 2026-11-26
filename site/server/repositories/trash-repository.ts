// Soft-delete storage: `trash:<isoTimestamp>:<random>` holds everything a delete or reset removed (for a
// deleted case: which case, and the status to put back).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CaseStatusSchema } from "../../shared/case-records.ts";
import { AccountRecordSchema, ProgressRecordSchema } from "../domain/types.ts";
import { mapWithConcurrency } from "./KvStore.ts";
import type { KvStore } from "./KvStore.ts";

export const TrashBundleSchema = z.object({
  kind: z.enum(["account", "progress", "case"]),
  label: z.string(),
  deletedAt: z.string(),
  account: AccountRecordSchema.nullable(),
  progress: z.array(ProgressRecordSchema),
  /** first-blood claims cleared by a case reset: key -> value */
  firstBlood: z.record(z.string(), z.unknown()),
  /** a deleted case (#66): its id and the status to restore. The case records stay in place while trashed. */
  caseId: z.string().nullable().default(null),
  caseStatus: CaseStatusSchema.nullable().default(null),
});
export type TrashBundle = z.infer<typeof TrashBundleSchema>;

export class TrashRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }

  async put(bundle: TrashBundle): Promise<string> {
    const id = `${bundle.deletedAt}:${randomBytes(4).toString("hex")}`;
    await this.kv.set(`trash:${id}`, bundle);
    return id;
  }

  async get(id: string): Promise<TrashBundle | null> {
    const parsed = TrashBundleSchema.safeParse((await this.kv.get(`trash:${id}`))?.data);
    return parsed.success ? parsed.data : null;
  }

  async list(): Promise<Array<{ id: string; bundle: TrashBundle }>> {
    const keys = await this.kv.listKeys("trash:");
    const rows = await mapWithConcurrency(keys, async (key) => {
      const parsed = TrashBundleSchema.safeParse((await this.kv.get(key))?.data);
      return parsed.success ? { id: key.slice("trash:".length), bundle: parsed.data } : null;
    });
    return rows.filter((r): r is { id: string; bundle: TrashBundle } => r !== null);
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`trash:${id}`);
  }

  /** Raw access for the first-blood keys a reset removes and a restore puts back. */
  async readKeys(prefix: string): Promise<Record<string, unknown>> {
    const keys = await this.kv.listKeys(prefix);
    const rows = await mapWithConcurrency(keys, async (key) => [key, (await this.kv.get(key))?.data] as const);
    return Object.fromEntries(rows.filter(([, v]) => v !== undefined));
  }

  /** Writes a key only if it doesn't exist. True when written. */
  restoreKeyIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.kv.setIfMatch(key, value, null);
  }
}
