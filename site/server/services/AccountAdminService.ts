// Instructor-side account management: approve/reject/delete, password resets, progress resets, CSV export.
import { randomBytes } from "node:crypto";
import type { AccountRecordRole, AccountStatus, AccountView, AdminProgress } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { FirstBloodRepository } from "../repositories/config-repositories.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { toAccountView } from "./AuthService.ts";
import { ACCOUNT_ID_PATTERN, hashPassword, sha256Hex } from "./crypto.ts";
import type { GameService } from "./GameService.ts";
import type { ScoreService } from "./ScoreService.ts";
import type { StatsService } from "./StatsService.ts";
import type { TrashService } from "./TrashService.ts";
import type { TrashRepository } from "../repositories/trash-repository.ts";

// No look-alike characters (0/O, 1/l/I) so a password read aloud or off a projector is typed right.
const TEMP_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TEMP_PASSWORD_LENGTH = 10;

const temporaryPassword = (): string => {
  let out = "";
  while (out.length < TEMP_PASSWORD_LENGTH) {
    for (const byte of randomBytes(16)) {
      // Reject bytes past the largest multiple of the alphabet size to keep the distribution uniform.
      if (byte < 256 - (256 % TEMP_PASSWORD_ALPHABET.length) && out.length < TEMP_PASSWORD_LENGTH) out += TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length];
    }
  }
  return out;
};

/** RFC 4180 field: quote when needed, double inner quotes; neutralise spreadsheet formulas. */
const csvField = (value: string | number | null): string => {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export class AccountAdminService {
  private readonly repos: Repositories;
  private readonly firstBlood: FirstBloodRepository;
  private readonly game: GameService;
  private readonly stats: StatsService;
  private readonly trash: TrashService;
  private readonly trashRepo: TrashRepository;
  private readonly scores: ScoreService | null;
  private readonly now: () => Date;
  private readonly onBoardChange: () => void;

  constructor(deps: {
    repos: Repositories;
    firstBlood: FirstBloodRepository;
    game: GameService;
    stats: StatsService;
    trash: TrashService;
    trashRepo: TrashRepository;
    /** the board's score summaries follow progress resets and account deletes (#175) */
    scores?: ScoreService;
    now: () => Date;
    /** a ban or unban changes who is on the board: the board's shared read is dropped (#185) */
    onBoardChange?: () => void;
  }) {
    this.onBoardChange = deps.onBoardChange ?? (() => undefined);
    this.repos = deps.repos;
    this.firstBlood = deps.firstBlood;
    this.game = deps.game;
    this.stats = deps.stats;
    this.trash = deps.trash;
    this.trashRepo = deps.trashRepo;
    this.scores = deps.scores ?? null;
    this.now = deps.now;
  }

  async setStatus(accountId: string, status: Exclude<AccountStatus, "pending">): Promise<AccountView> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    // Rejecting keeps the session: the player then sees the "not approved" screen instead of a silent
    // sign-out. Every case route already refuses rejected accounts, and they can't sign in again.
    const account = { ...found.data, status, decidedAt: this.now().toISOString() };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    this.onBoardChange();
    return toAccountView(account);
  }

  /** Grants or revokes the author role. Sessions stay valid: the role is read from the record on each request. */
  async setRole(accountId: string, role: AccountRecordRole): Promise<AccountView> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    if (found.data.role === role) return toAccountView(found.data);
    const account = { ...found.data, role };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    return toAccountView(account);
  }

  /** How many active classes the account may own (#179); null goes back to the site default. Owned classes stay. */
  async setClassLimit(accountId: string, classLimit: number | null): Promise<{ accountId: string; classLimit: number | null }> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    if (found.data.classLimit !== classLimit && !(await this.repos.accounts.saveIfMatch({ ...found.data, classLimit }, found.etag))) {
      throw new AppError(409, "concurrent update, please retry");
    }
    return { accountId, classLimit };
  }

  /** Approves every pending account. Returns how many were approved. */
  async approveAll(): Promise<number> {
    const pending = (await this.repos.accounts.list()).filter((a) => a.status === "pending");
    const results = await mapWithConcurrency(pending, async (a) => {
      try {
        await this.setStatus(a.id, "approved");
        return 1;
      } catch {
        return 0; // deleted or changed meanwhile: skip it
      }
    });
    return results.reduce((sum: number, n) => sum + n, 0);
  }

  /** Sets a random temporary password, signs the account out and forces a change at next sign-in. */
  async resetPassword(accountId: string): Promise<string> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    const password = temporaryPassword();
    const account = {
      ...found.data,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      sessionEpoch: found.data.sessionEpoch + 1,
    };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    return password;
  }

  /** Soft delete: the account and its progress go to the trash (restorable for 7 days), then are removed. */
  async delete(accountId: string): Promise<{ username: string }> {
    this.assertId(accountId);
    const found = await this.repos.accounts.get(accountId);
    if (!found) throw new AppError(404, "account not found");
    const progress = (await this.repos.progress.list()).filter((r) => r.accountId === accountId);
    const memberships = await this.repos.classes.membershipsOf(accountId);
    // Trash first: if this write fails, nothing has been deleted yet.
    await this.trash.put({ kind: "account", label: `account ${found.data.username}`, account: found.data, progress, firstBlood: {}, memberships });
    // Sessions die with the account (authenticate() rejects sessions whose account is gone).
    await this.repos.progress.deleteMany({ accountId });
    await this.repos.classes.removeAccount(accountId); // out of every class, in both indexes (#179)
    await this.scores?.remove(accountId); // off the board at once; a restore rebuilds both from the trash
    await this.repos.accounts.delete(accountId);
    await this.repos.usernames.release(sha256Hex(found.data.usernameKey));
    return { username: found.data.username };
  }

  async liveProgress(caseId: string): Promise<{ generatedAt: string; caseId: string; players: AdminProgress[] }> {
    this.game.caseSecrets(caseId); // 404 for unknown cases
    // Only the accounts on this case (#185): the Live section polls this, so it never reads every account.
    const records = await this.repos.progress.list(caseId);
    const accounts = await mapWithConcurrency(records, async (record) => (await this.repos.accounts.get(record.accountId))?.data ?? null);
    const players = records
      .flatMap((record, i) => {
        const account = accounts[i];
        return account ? [this.game.toAdminView(record, account)] : [];
      })
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    return { generatedAt: this.now().toISOString(), caseId, players };
  }

  /**
   * Soft reset of progress (one player's case, one case, or everything): the records go to the trash
   * first. Resetting a whole case also frees its first bloods (kept in the same trash entry).
   */
  async resetProgress(filter: { caseId?: string; accountId?: string }): Promise<void> {
    if (filter.caseId !== undefined) this.game.caseSecrets(filter.caseId);
    if (filter.accountId !== undefined) this.assertId(filter.accountId);
    const records = (await this.repos.progress.list(filter.caseId)).filter((r) => filter.accountId === undefined || r.accountId === filter.accountId);
    const isWholeCase = filter.accountId === undefined;
    const firstBlood = isWholeCase ? await this.trashRepo.readKeys(filter.caseId === undefined ? "firstblood:" : `firstblood:${filter.caseId}:`) : {};
    if (records.length === 0 && Object.keys(firstBlood).length === 0) return;
    const scope = filter.caseId ?? "all cases";
    const label = filter.accountId === undefined ? `progress of ${scope} (${records.length} players)` : `progress of ${scope} for one player`;
    await this.trash.put({ kind: "progress", label, account: null, progress: records, firstBlood });
    await this.repos.progress.deleteMany(filter);
    if (isWholeCase) await this.firstBlood.clear(filter.caseId);
    const scores = this.scores;
    if (scores) await mapWithConcurrency(records, (r) => scores.syncCase(r.accountId, r.caseId));
  }

  /** One row per account per case the account has opened. */
  async exportCsv(): Promise<string> {
    const users = await this.stats.allUsers();
    const header = [
      "username", "status", "rank", "total_score", "case", "case_status", "case_score", "par", "solved", "revealed",
      "hints", "commands", "wrong", "first_bloods", "duration_seconds", "started_at", "completed_at", "achievements",
    ];
    const rows = users.flatMap((u) =>
      u.cases
        .filter((c) => c.status !== "not-started")
        .map((c) => [
          u.username, u.status, u.rank, u.totalScore, c.caseId, c.status, c.score, c.maxScore, c.solved, c.revealed,
          c.hintsUsed, c.commandsRevealed, c.wrongAttempts, c.firstBloods, c.durationSeconds, c.startedAt, c.completedAt,
          u.achievements.map((a) => a.id).join(" "),
        ]),
    );
    return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
  }

  private assertId(accountId: string): void {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError(400, "invalid account id");
  }
}
