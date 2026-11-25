// Scheduled Netlify Function: once a day, snapshot the primary store into the separate backup store
// (daily/<date>.json) and drop snapshots older than 30 days. Restore with `scripts/data.ts restore`.
import type { Config } from "@netlify/functions";
import { BACKUP_STORE, BlobsKvStore } from "../../server/repositories/KvStore.ts";
import { writeDailySnapshot } from "../../server/services/BackupService.ts";

const RETENTION_DAYS = 30;

export default async (): Promise<Response> => {
  try {
    const result = await writeDailySnapshot({
      primary: new BlobsKvStore(),
      backups: new BlobsKvStore({ name: BACKUP_STORE }),
      now: new Date(),
      retentionDays: RETENTION_DAYS,
    });
    console.log(`[incidentlab-backup] wrote ${result.key}: ${result.entries} keys, pruned ${result.pruned} old snapshots`);
    return new Response(null, { status: 204 });
  } catch (error) {
    // Logged loudly: a silent backup failure is how data gets lost.
    console.error("[incidentlab-backup] FAILED", error);
    return new Response(null, { status: 500 });
  }
};

export const config: Config = { schedule: "@daily" };
