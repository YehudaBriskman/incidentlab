// Append-only log of admin actions. Writing is best effort: a failed audit write never blocks the action.
import type { AuditEntry } from "../../shared/contract.ts";
import type { AuditRepository } from "../repositories/config-repositories.ts";

export type AuditInput = { readonly action: string; readonly target?: string | null; readonly detail?: string | null; readonly via: AuditEntry["via"] };

export class AuditService {
  private readonly repository: AuditRepository;
  private readonly now: () => Date;

  constructor(deps: { repository: AuditRepository; now: () => Date }) {
    this.repository = deps.repository;
    this.now = deps.now;
  }

  async record(input: AuditInput): Promise<void> {
    try {
      await this.repository.append({ at: this.now().toISOString(), action: input.action, target: input.target ?? null, detail: input.detail ?? null, via: input.via });
    } catch (error) {
      console.error("[incidentlab-api] audit write failed", error);
    }
  }

  latest(limit: number): Promise<AuditEntry[]> {
    return this.repository.latest(Math.max(1, Math.min(500, Math.floor(limit))));
  }
}
