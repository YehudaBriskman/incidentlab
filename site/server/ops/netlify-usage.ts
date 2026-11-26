// Monthly usage of the Netlify account behind the site, against the legacy Free plan limits (issue #142).
// Read-only: three GETs to the Netlify API. Used by `scripts/data.ts usage`. Lives under site/ so zod resolves
// from site/node_modules in CI (the root node_modules holds only the edge function deps).
//
// Bandwidth comes from /accounts/<id>/bandwidth, which is kept up to date. The per-feature counters in the
// account's `capabilities` (functions, edge functions, build minutes) are also shown, but Netlify may report
// them as 0 on the legacy plan; the Netlify UI (Team -> Usage) is the reference for those.
import { z } from "zod";

const API = "https://api.netlify.com/api/v1";
/** Share of a limit at which the report warns. */
export const WARN_SHARE = 0.7;

const Capability = z.object({ included: z.number(), used: z.number().optional() }).passthrough();
const AccountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type_name: z.string(),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
const SiteSchema = z.object({ account_id: z.string().optional(), account_slug: z.string().optional() }).passthrough();
const BandwidthSchema = z.object({ used: z.number(), included: z.number(), period_start_date: z.string(), period_end_date: z.string() }).passthrough();

export type UsageRow = { label: string; used: number | null; included: number; unit: "bytes" | "count" | "minutes" };
export type UsageReport = { account: string; plan: string; periodStart: string; periodEnd: string; rows: UsageRow[] };

/** The counters worth watching on the legacy Free plan, in the order printed. */
const COUNTERS: readonly { key: string; label: string; unit: UsageRow["unit"] }[] = [
  { key: "functions", label: "Function calls", unit: "count" },
  { key: "edge_functions", label: "Edge function calls", unit: "count" },
  { key: "build_minutes", label: "Build minutes", unit: "minutes" },
];

const get = async (path: string, token: string): Promise<unknown> => {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Netlify API ${path}: HTTP ${res.status}`);
  const body: unknown = await res.json();
  return body;
};

export async function fetchUsage(token: string, siteId: string): Promise<UsageReport> {
  const site = SiteSchema.parse(await get(`/sites/${encodeURIComponent(siteId)}`, token));
  const accounts = z.array(AccountSchema).parse(await get("/accounts", token));
  const account = accounts.find((a) => a.id === site.account_id || a.name === site.account_slug) ?? accounts[0];
  if (account === undefined) throw new Error("no Netlify account found for this token");
  const bandwidth = BandwidthSchema.parse(await get(`/accounts/${encodeURIComponent(account.id)}/bandwidth`, token));
  const rows: UsageRow[] = [{ label: "Bandwidth", used: bandwidth.used, included: bandwidth.included, unit: "bytes" }];
  for (const counter of COUNTERS) {
    const parsed = Capability.safeParse(account.capabilities[counter.key]);
    if (parsed.success) rows.push({ label: counter.label, used: parsed.data.used ?? null, included: parsed.data.included, unit: counter.unit });
  }
  return { account: account.name, plan: account.type_name, periodStart: bandwidth.period_start_date, periodEnd: bandwidth.period_end_date, rows };
}

const formatAmount = (value: number, unit: UsageRow["unit"]): string => {
  if (unit === "bytes") return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
  return unit === "minutes" ? `${value.toLocaleString("en-US")} min` : value.toLocaleString("en-US");
};

/** The printable report; a row at or above WARN_SHARE of its limit is flagged. Pure, for tests. */
export function formatUsage(report: UsageReport, now: Date): string[] {
  const end = Date.parse(report.periodEnd);
  const daysLeft = Number.isFinite(end) ? Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000)) : null;
  const lines = [
    `[usage] account ${report.account}, plan ${report.plan}${report.plan === "Free" ? " (legacy: never switch to credit-based pricing)" : ""}`,
    `[usage] period ${report.periodStart.slice(0, 10)} to ${report.periodEnd.slice(0, 10)}${daysLeft === null ? "" : `, ${daysLeft} days left`}`,
  ];
  for (const row of report.rows) {
    // Only bandwidth is kept current by this API; the capability counters read 0 on the legacy plan even after
    // real traffic, so a 0 there means "unknown", not "unused".
    if (row.used === null || (row.unit !== "bytes" && row.used === 0)) {
      lines.push(`[usage] ${row.label}: not reported by the API (limit ${formatAmount(row.included, row.unit)}/month; check Netlify UI -> Usage)`);
      continue;
    }
    const share = row.included > 0 ? row.used / row.included : 0;
    const warn = share >= WARN_SHARE ? "  WARNING: over 70% of the monthly limit" : "";
    lines.push(`[usage] ${row.label}: ${formatAmount(row.used, row.unit)} of ${formatAmount(row.included, row.unit)} (${(share * 100).toFixed(1)}%)${warn}`);
  }
  return lines;
}
