// Append-only log of admin actions. Writing is best effort: a failed audit write never blocks the action.
// Every entry names its actor (#185): "admin" for the ADMIN_KEY owner, or the acting account's id.
import type { AuditEntry } from "../../shared/contract.ts";
import type { AuditRepository } from "../repositories/config-repositories.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { ACCOUNT_ID_PATTERN } from "./crypto.ts";

export type AuditInput = {
  readonly action: string;
  readonly target?: string | null;
  readonly detail?: string | null;
  readonly via: AuditEntry["via"];
  /** "admin" or the acting account's id */
  readonly actor: string;
};

/** The audit log page: the entries and display names for the ids they mention. */
export type AuditPage = { readonly entries: AuditEntry[]; readonly names: Record<string, string> };

export class AuditService {
  private readonly repository: AuditRepository;
  private readonly repos: Pick<Repositories, "accounts" | "classes"> | null;
  private readonly now: () => Date;

  constructor(deps: { repository: AuditRepository; repos?: Pick<Repositories, "accounts" | "classes">; now: () => Date }) {
    this.repository = deps.repository;
    this.repos = deps.repos ?? null;
    this.now = deps.now;
  }

  async record(input: AuditInput): Promise<void> {
    try {
      await this.repository.append({
        at: this.now().toISOString(),
        action: input.action,
        target: input.target ?? null,
        detail: input.detail ?? null,
        via: input.via,
        actor: input.actor,
      });
    } catch (error) {
      console.error("[incidentlab-api] audit write failed", error);
    }
  }

  latest(limit: number): Promise<AuditEntry[]> {
    return this.repository.latest(Math.max(1, Math.min(500, Math.floor(limit))));
  }

  /**
   * The newest entries and the names behind their ids: one read per distinct account id (actors and account
   * targets) and per distinct class id (class actions), at most `limit` of each. Admin only, on demand.
   */
  async page(limit: number): Promise<AuditPage> {
    const entries = await this.latest(limit);
    const repos = this.repos;
    if (repos === null) return { entries, names: {} };
    const accountIds = new Set<string>();
    const classIds = new Set<string>();
    for (const e of entries) {
      if (e.actor !== null && ACCOUNT_ID_PATTERN.test(e.actor)) accountIds.add(e.actor);
      if (e.target === null || !ACCOUNT_ID_PATTERN.test(e.target)) continue;
      // Class and account ids share a shape: the action says which one the target is.
      if (e.action.startsWith("class.")) classIds.add(e.target);
      else if (e.action.startsWith("account.") || e.action === "progress.restart") accountIds.add(e.target);
    }
    const names: Record<string, string> = {};
    await Promise.all([
      mapWithConcurrency([...accountIds], async (id) => {
        const found = await repos.accounts.get(id);
        if (found) names[id] = found.data.username;
      }),
      mapWithConcurrency([...classIds], async (id) => {
        const found = await repos.classes.get(id);
        if (found) names[id] = found.data.name;
      }),
    ]);
    return { entries, names };
  }
}
