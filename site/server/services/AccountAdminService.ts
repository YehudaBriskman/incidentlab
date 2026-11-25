// Instructor-side account management: approve, reject, delete, plus progress resets.
import type { AccountStatus, AccountView, AdminProgress } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { toAccountView } from "./AuthService.ts";
import { ACCOUNT_ID_PATTERN, sha256Hex } from "./crypto.ts";
import type { GameService } from "./GameService.ts";

export class AccountAdminService {
  private readonly repos: Repositories;
  private readonly game: GameService;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; game: GameService; now: () => Date }) {
    this.repos = deps.repos;
    this.game = deps.game;
    this.now = deps.now;
  }

  async setStatus(accountId: string, status: Exclude<AccountStatus, "pending">): Promise<AccountView> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    const account = { ...found.data, status, decidedAt: this.now().toISOString() };
    // Rejecting signs the account out everywhere.
    if (status === "rejected") account.sessionEpoch += 1;
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    return toAccountView(account);
  }

  async delete(accountId: string): Promise<void> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    // Sessions die with the account (authenticate() rejects sessions whose account is gone).
    await this.repos.progress.deleteMany({ accountId });
    await this.repos.accounts.delete(accountId);
    await this.repos.usernames.release(sha256Hex(found.data.usernameKey));
  }

  async liveProgress(caseId: string): Promise<{ generatedAt: string; caseId: string; players: AdminProgress[] }> {
    this.game.caseSecrets(caseId); // 404 for unknown cases
    const [records, accounts] = await Promise.all([this.repos.progress.list(caseId), this.repos.accounts.list()]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const players = records
      .flatMap((record) => {
        const account = byId.get(record.accountId);
        return account ? [this.game.toAdminView(record, account)] : [];
      })
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    return { generatedAt: this.now().toISOString(), caseId, players };
  }

  async resetProgress(filter: { caseId?: string; accountId?: string }): Promise<void> {
    if (filter.caseId !== undefined) this.game.caseSecrets(filter.caseId);
    if (filter.accountId !== undefined) this.assertId(filter.accountId);
    await this.repos.progress.deleteMany(filter);
  }

  private assertId(accountId: string): void {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError(400, "invalid account id");
  }
}
