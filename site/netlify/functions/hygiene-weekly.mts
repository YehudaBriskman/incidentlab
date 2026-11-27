// Scheduled Netlify Function: once a week, trash guests idle for 30 days (restorable for 7 days), sweep expired
// sessions and stale rate-limit windows, keep 90 days of audit and drop expired trash (#177). The logic is
// AccountHygieneService; `scripts/data.ts gc-accounts` runs the same pass by hand (dry run first).
import type { Config } from "@netlify/functions";
import { BlobsKvStore } from "../../server/repositories/KvStore.ts";
import { createAccountHygiene } from "../../server/services/AccountHygieneService.ts";

export default async (): Promise<Response> => {
  try {
    const report = await createAccountHygiene(new BlobsKvStore(), () => new Date()).run({ apply: true });
    console.log(
      `[incidentlab-hygiene] trashed ${report.idleGuests.length} idle guests (${report.guestProgress} progress records), ` +
        `deleted ${report.expiredSessions} expired sessions, ${report.staleRateLimits} stale rate limits, ` +
        `${report.oldAudit} old audit entries, ${report.expiredTrash} expired trash entries, ${report.expiredResetRequests} expired reset requests`,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    // Logged loudly, like the backup: a silent failure lets the store grow again.
    console.error("[incidentlab-hygiene] FAILED", error);
    return new Response(null, { status: 500 });
  }
};

export const config: Config = { schedule: "@weekly" };
