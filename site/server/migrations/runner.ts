// Data migrations: numbered, idempotent steps over the KV store, recorded in a ledger so each runs once.
// Rules (docs/DATA.md): never delete or rename data in a migration; write new keys or add fields; the code
// that ships before a migration must already read both the old and the new shape (expand → migrate → contract).
import { z } from "zod";
import type { KvStore } from "../repositories/KvStore.ts";

export type MigrationContext = {
  readonly kv: KvStore;
  /** Pre-accounts store; only present where it exists (production CLI). */
  readonly legacy: KvStore | null;
  readonly now: () => Date;
  /** true = count what would change, write nothing */
  readonly dryRun: boolean;
  readonly log: (message: string) => void;
};

export type MigrationResult = { readonly scanned: number; readonly changed: number; readonly note?: string };

export type Migration = {
  /** "NNN-kebab-name"; order = lexical order of ids */
  readonly id: string;
  readonly description: string;
  run(ctx: MigrationContext): Promise<MigrationResult>;
};

const LEDGER_KEY = "config:migrations";
const LedgerSchema = z.object({
  applied: z.array(z.object({ id: z.string(), at: z.string(), scanned: z.number(), changed: z.number(), note: z.string().optional() })),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export const readLedger = async (kv: KvStore): Promise<Ledger> => {
  const parsed = LedgerSchema.safeParse((await kv.get(LEDGER_KEY))?.data);
  return parsed.success ? parsed.data : { applied: [] };
};

export const pendingMigrations = async (kv: KvStore, migrations: readonly Migration[]): Promise<Migration[]> => {
  const done = new Set((await readLedger(kv)).applied.map((a) => a.id));
  return [...migrations].sort((a, b) => a.id.localeCompare(b.id)).filter((m) => !done.has(m.id));
};

export type RunReport = { readonly dryRun: boolean; readonly results: ReadonlyArray<{ id: string; description: string } & MigrationResult> };

/** Runs every pending migration in order. A dry run reports counts and records nothing. */
export const runMigrations = async (input: {
  kv: KvStore;
  legacy: KvStore | null;
  migrations: readonly Migration[];
  dryRun: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<RunReport> => {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => undefined);
  const results: Array<{ id: string; description: string } & MigrationResult> = [];
  for (const migration of await pendingMigrations(input.kv, input.migrations)) {
    log(`${input.dryRun ? "[dry-run] " : ""}${migration.id}: ${migration.description}`);
    const result = await migration.run({ kv: input.kv, legacy: input.legacy, now, dryRun: input.dryRun, log });
    results.push({ id: migration.id, description: migration.description, ...result });
    if (!input.dryRun) {
      // Re-read the ledger each time so concurrent runs can't erase each other's entries.
      const ledger = await readLedger(input.kv);
      ledger.applied.push({ id: migration.id, at: now().toISOString(), scanned: result.scanned, changed: result.changed, ...(result.note ? { note: result.note } : {}) });
      await input.kv.set(LEDGER_KEY, ledger);
    }
  }
  return { dryRun: input.dryRun, results };
};
