// Scale check (#185): seeds a public-site-sized store (seed-scale.ts) and calls the app directly, as a CDN miss
// would, counting the store operations per call. Reads (not time) are the budget: in production each one is a
// Blobs request inside the function's runtime, so a call that scans everything gets slow and costly long before it
// fails. Times here are in-memory and only show the shape.
//
//   node --experimental-strip-types tests/load/scale-check.ts            # print the table
//   node --experimental-strip-types tests/load/scale-check.ts --check    # exit 1 when a call reads more than its budget
//
// site/server/test/scale.test.ts runs the --check budgets on every PR (npm run test:server).
import { InMemoryKvStore } from "../../site/server/repositories/KvStore.ts";
import type { Versioned } from "../../site/server/repositories/KvStore.ts";
import { createApp } from "../../site/server/router.ts";
import { scaleSecrets, seedScale } from "./seed-scale.ts";

const ADMIN_KEY = "scale-admin-key-0123456789abcdef";

/** InMemoryKvStore that counts gets and listings, by key prefix. */
export class CountingKvStore extends InMemoryKvStore {
  gets = 0;
  lists = 0;
  writes = 0;
  readonly byPrefix = new Map<string, number>();
  reset(): void {
    this.gets = 0;
    this.lists = 0;
    this.writes = 0;
    this.byPrefix.clear();
  }
  private note(key: string): void {
    const prefix = key.slice(0, key.indexOf(":") + 1) || key;
    this.byPrefix.set(prefix, (this.byPrefix.get(prefix) ?? 0) + 1);
  }
  override get(key: string): Promise<Versioned<unknown> | null> {
    this.gets += 1;
    this.note(key);
    return super.get(key);
  }
  override listKeys(prefix: string): Promise<string[]> {
    this.lists += 1;
    return super.listKeys(prefix);
  }
  override setIfMatch(key: string, value: unknown, etag: string | null): Promise<boolean> {
    this.writes += 1;
    return super.setIfMatch(key, value, etag);
  }
}

export type ScaleRow = {
  readonly name: string;
  readonly path: string;
  /** who calls it and how often: the budget reasoning in docs/DATA.md */
  readonly audience: string;
  readonly status: number;
  readonly gets: number;
  readonly lists: number;
  readonly ms: number;
  readonly top: string;
};

/** Read budgets per call (gets + lists) that the CI check holds. Set with headroom over the measured values. */
export const READ_BUDGET: Readonly<Record<string, number>> = {
  leaderboard: 1300,
  classBoard: 200,
  meStats: 1300,
  meStatsWarm: 60,
  leaderboardCaseWarm: 10,
  adminUsersSearch: 600,
  classes: 30,
  adminUsers: 5000,
  adminClasses: 350,
  adminProgress: 1500,
};

export async function measureScale(): Promise<{ rows: ScaleRow[]; counts: Readonly<Record<string, number>> }> {
  const store = new CountingKvStore();
  const nowMs = Date.now();
  const seed = await seedScale(store, { nowMs });
  /**
   * A cold function instance: its own in-memory memos (board, directory, case list). The case list is loaded
   * before measuring (CaseSecretsProvider refreshes it once per instance), so each row counts only its own work.
   */
  const coldApp = async (): Promise<ReturnType<typeof createApp>> => {
    const fresh = createApp({ store, staticSecrets: scaleSecrets(), adminKey: () => ADMIN_KEY });
    await fresh.handle(new Request("http://localhost/api/today"), "10.0.0.1");
    return fresh;
  };
  let app = await coldApp();

  /** `instance: "cold"` measures on a new instance, "warm" on the one the previous row used. */
  const call = async (name: string, path: string, audience: string, auth: "none" | "player" | "admin", instance: "cold" | "warm" = "cold"): Promise<ScaleRow> => {
    if (instance === "cold") app = await coldApp();
    const headers: Record<string, string> = {};
    if (auth === "player") headers["cookie"] = `il_session=${seed.player.token}`;
    if (auth === "admin") headers["x-admin-key"] = ADMIN_KEY;
    store.reset();
    const started = performance.now();
    const res = await app.handle(new Request(`http://localhost${path}`, { headers }), "10.0.0.1");
    await res.arrayBuffer();
    const ms = performance.now() - started;
    const top = [...store.byPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p} ${n}`).join(", ");
    return { name, path, audience, status: res.status, gets: store.gets, lists: store.lists, ms: Math.round(ms), top };
  };

  const caseId = seed.caseIds[0] ?? "";
  const rows: ScaleRow[] = [];
  rows.push(await call("leaderboard", "/api/leaderboard", "public, CDN-cached 10 s", "none"));
  rows.push(await call("classBoard", `/api/classboard/${encodeURIComponent(seed.fullClass.boardToken)}`, "public, CDN-cached 10 s per URL", "none"));
  rows.push(await call("meStats", "/api/me/stats", "player, no-store, per home or stats view (first call on an instance)", "player"));
  rows.push(await call("meStatsWarm", "/api/me/stats", "player, no-store, same instance within 10 s", "player", "warm"));
  rows.push(await call("leaderboardCaseWarm", `/api/leaderboard?caseId=${seed.caseIds[1] ?? ""}`, "public, another variant on that instance within 10 s", "none", "warm"));
  rows.push(await call("classes", "/api/classes", "player, no-store, Classes page", "player"));
  rows.push(await call("adminUsers", "/api/admin/users?limit=50", "owner, no-store, on demand", "admin"));
  rows.push(await call("adminUsersSearch", "/api/admin/users?q=player_19&limit=50", "owner, a search on the same instance within 2 s", "admin", "warm"));
  rows.push(await call("adminAccountsOld", "/api/admin/accounts", "before #185: polled every 5 s by the console", "admin"));
  rows.push(await call("adminClasses", "/api/admin/classes", "owner, no-store, on demand", "admin"));
  rows.push(await call("adminProgress", `/api/admin/progress?caseId=${caseId}`, "owner, no-store, Live polls it every 5 s", "admin"));
  return { rows, counts: seed.counts };
}

export function overBudget(rows: readonly ScaleRow[]): string[] {
  return rows.flatMap((r) => {
    const budget = READ_BUDGET[r.name];
    if (r.status !== 200) return [`${r.name}: HTTP ${r.status}`];
    return budget !== undefined && r.gets + r.lists > budget ? [`${r.name}: ${r.gets + r.lists} reads > budget ${budget}`] : [];
  });
}

const isMain = process.argv[1]?.endsWith("scale-check.ts") ?? false;
if (isMain) {
  const { rows, counts } = await measureScale();
  console.log(`seeded: ${JSON.stringify(counts)}\n`);
  console.log("| Call | Path | Who / how often | Store gets | Listings | Time (in-memory) | Most read |");
  console.log("|---|---|---|---:|---:|---:|---|");
  for (const r of rows) console.log(`| ${r.name}${r.status === 200 ? "" : ` (HTTP ${r.status})`} |\`${r.path.replace(/classboard\/[^?]+/, "classboard/<token>")}\` | ${r.audience} | ${r.gets} | ${r.lists} | ${r.ms} ms | ${r.top} |`);
  if (process.argv.includes("--check")) {
    const failures = overBudget(rows);
    if (failures.length > 0) {
      console.error(`\nover budget:\n${failures.join("\n")}`);
      process.exit(1);
    }
    console.log("\nall calls within their read budgets");
  }
}
