// Restore and expiry for soft-deleted data. Restores are additive: they never overwrite data that was
// created after the delete (a player who re-registered, or progress made after a reset).
import { TRASH_RETENTION_DAYS } from "../../shared/contract.ts";
import type { TrashEntry } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { TrashBundle, TrashRepository } from "../repositories/trash-repository.ts";
import { sha256Hex } from "./crypto.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_ID = /^[0-9TZ:.-]+:[0-9a-f]{8}$/;

export class TrashService {
  private readonly trash: TrashRepository;
  private readonly repos: Repositories;
  private readonly now: () => Date;

  constructor(deps: { trash: TrashRepository; repos: Repositories; now: () => Date }) {
    this.trash = deps.trash;
    this.repos = deps.repos;
    this.now = deps.now;
  }

  put(bundle: Omit<TrashBundle, "deletedAt">): Promise<string> {
    return this.trash.put({ ...bundle, deletedAt: this.now().toISOString() });
  }

  /** Live entries, newest first. Expired entries are purged as a side effect. */
  async list(): Promise<TrashEntry[]> {
    const nowMs = this.now().getTime();
    const out: TrashEntry[] = [];
    for (const { id, bundle } of await this.trash.list()) {
      const expiresMs = Date.parse(bundle.deletedAt) + TRASH_RETENTION_DAYS * DAY_MS;
      if (expiresMs <= nowMs) {
        await this.trash.delete(id);
        continue;
      }
      out.push({ id, kind: bundle.kind, label: bundle.label, deletedAt: bundle.deletedAt, expiresAt: new Date(expiresMs).toISOString(), records: bundle.progress.length });
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async restore(id: string): Promise<{ restored: number; skipped: number; label: string }> {
    if (!TRASH_ID.test(id)) throw new AppError(400, "invalid trash id");
    const bundle = await this.trash.get(id);
    if (!bundle) throw new AppError(404, "nothing to restore (expired or already restored)");

    let restored = 0;
    let skipped = 0;
    if (bundle.account) {
      const account = bundle.account;
      if (await this.repos.accounts.get(account.id)) throw new AppError(409, "that account exists again", { code: "conflict" });
      if (!(await this.repos.usernames.claim(sha256Hex(account.usernameKey), account.id))) {
        throw new AppError(409, `the username ${account.username} was taken by someone else since`, { code: "conflict" });
      }
      await this.repos.accounts.saveIfMatch(account, null);
      restored += 1;
    }
    for (const record of bundle.progress) {
      if (await this.repos.progress.saveIfMatch(record, null)) restored += 1;
      else skipped += 1; // newer progress exists: keep it
    }
    for (const [key, value] of Object.entries(bundle.firstBlood)) {
      await this.trash.restoreKeyIfAbsent(key, value);
    }
    await this.trash.delete(id);
    return { restored, skipped, label: bundle.label };
  }
}
