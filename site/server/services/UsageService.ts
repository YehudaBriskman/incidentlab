// The function-call budget on the owner overview (#235): how many of the legacy Free plan's 125,000 monthly function
// calls are used. Read from the Netlify API (site/server/ops/netlify-usage.ts, the code behind `scripts/data.ts
// usage`) only when a server-side token is configured (NETLIFY_USAGE_TOKEN; never required), and at most once an
// hour: the answer, or the error, is kept in Blobs under `config:usage` (the config: prefix), so opening the overview
// never costs a Netlify API call, and every function instance shares the same hourly answer.
//
// Netlify may report the function counter as 0 on the legacy plan (docs/DATA.md "Capacity budget"): a 0 is shown as
// "not reported", never as "0 calls used".
import { FUNCTION_CALL_LIMIT } from "../../shared/contract.ts";
import type { OverviewUsage } from "../../shared/contract.ts";
import type { CachedUsageRecord, UsageCacheRepository } from "../repositories/config-repositories.ts";
import type { UsageReport } from "../ops/netlify-usage.ts";

export const USAGE_CACHE_MS = 60 * 60 * 1000;

export type UsageSource = {
  /** the server-side Netlify token, or undefined when not configured (read per call so env changes apply) */
  token(): string | undefined;
  siteId(): string | undefined;
  fetch(token: string, siteId: string): Promise<UsageReport>;
};

type CachedUsage = CachedUsageRecord;

const NOT_CONFIGURED: OverviewUsage = {
  status: "not-configured", limit: FUNCTION_CALL_LIMIT, functionCalls: null, bandwidthBytes: null, bandwidthLimitBytes: null,
  periodStart: null, periodEnd: null, fetchedAt: null, error: null,
};

/** The cached shape from one report. Pure, for tests. */
export const usageFromReport = (report: UsageReport, fetchedAt: string): CachedUsage => {
  const calls = report.rows.find((r) => r.label === "Function calls");
  const bandwidth = report.rows.find((r) => r.unit === "bytes");
  const reported = calls !== undefined && calls.used !== null && calls.used > 0;
  return {
    fetchedAt,
    status: reported ? "ok" : "not-reported",
    functionCalls: reported ? Math.round(calls.used ?? 0) : null,
    limit: calls !== undefined && calls.included > 0 ? calls.included : FUNCTION_CALL_LIMIT,
    bandwidthBytes: bandwidth?.used === null || bandwidth === undefined ? null : Math.round(bandwidth.used),
    bandwidthLimitBytes: bandwidth === undefined ? null : Math.round(bandwidth.included),
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    error: null,
  };
};

export class UsageService {
  private readonly cache: UsageCacheRepository;
  private readonly source: UsageSource | null;
  private readonly now: () => Date;

  constructor(deps: { cache: UsageCacheRepository; source?: UsageSource | undefined; now: () => Date }) {
    this.cache = deps.cache;
    this.source = deps.source ?? null;
    this.now = deps.now;
  }

  async current(): Promise<OverviewUsage> {
    const token = this.source?.token();
    const siteId = this.source?.siteId();
    if (this.source === null || token === undefined || token === "" || siteId === undefined || siteId === "") return NOT_CONFIGURED;
    const cached = await this.cache.get();
    const nowMs = this.now().getTime();
    if (cached !== null && nowMs - Date.parse(cached.fetchedAt) < USAGE_CACHE_MS) return cached;
    const fetchedAt = this.now().toISOString();
    let next: CachedUsage;
    try {
      next = usageFromReport(await this.source.fetch(token, siteId), fetchedAt);
    } catch (err: unknown) {
      // Cached too: a failing API is asked again in an hour, not on every overview load.
      next = { ...NOT_CONFIGURED, status: "error", fetchedAt, error: err instanceof Error ? err.message.slice(0, 200) : "unknown error" };
    }
    await this.cache.save(next);
    return next;
  }
}
