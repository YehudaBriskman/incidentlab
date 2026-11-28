// "Request author access" (#234): a player asks the owner for the author role; the request is an item in the owner's
// review queue (#/admin/reviews). The owner grants it (the account becomes an author, AccountAdminService.setRole)
// or declines it (the request is deleted). There is no email, so the player sees the state on #/author.
//
// Abuse limits: only approved full accounts that are not authors yet may ask; one open request per account (a
// second ask updates the note); and at most AUTHOR_REQUEST_LIMIT asks a day per account, so a script can't churn
// the owner's queue.
import type { AuthorAccessRequest } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { AuthorRequestRecord, AuthorRequestRepository } from "../repositories/author-request-repository.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { AccountRepository } from "../repositories/repositories.ts";
import { ACCOUNT_ID_PATTERN } from "./crypto.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

export const AUTHOR_REQUEST_LIMIT: RateLimitRule = { bucket: "author-request", max: 3, windowMs: 24 * 60 * 60_000, message: "you asked for author access a few times today; the owner has your request" };

const noRequest = (): AppError => new AppError(404, "no open author access request for that account", { code: "no-author-request" });

export class AuthorAccessService {
  private readonly requests: AuthorRequestRepository;
  private readonly accounts: AccountRepository;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;

  constructor(deps: { requests: AuthorRequestRepository; accounts: AccountRepository; limiter: RateLimiter; now: () => Date }) {
    this.requests = deps.requests;
    this.accounts = deps.accounts;
    this.limiter = deps.limiter;
    this.now = deps.now;
  }

  private view(record: AuthorRequestRecord, account: AccountRecord): AuthorAccessRequest {
    return { accountId: record.accountId, username: account.username, note: record.note, createdAt: record.createdAt };
  }

  /** Files (or updates the note of) the player's request. */
  async request(account: AccountRecord, note: string | null): Promise<AuthorAccessRequest> {
    if (account.kind !== "user") throw new AppError(403, "create an account first; guests can't author cases", { code: "guest" });
    if (account.role === "author") throw new AppError(409, "this account is already an author", { code: "already-author" });
    await this.limiter.assertAllowed(AUTHOR_REQUEST_LIMIT, account.id);
    await this.limiter.hit(AUTHOR_REQUEST_LIMIT, account.id);
    const found = await this.requests.get(account.id);
    const record: AuthorRequestRecord = {
      schemaVersion: 1,
      accountId: account.id,
      note: note === null || note === "" ? null : note,
      createdAt: found?.data.createdAt ?? this.now().toISOString(), // the queue keeps its place
    };
    if (!(await this.requests.saveIfMatch(record, found?.etag ?? null))) throw new AppError(409, "concurrent update, please retry");
    return this.view(record, account);
  }

  async mine(account: AccountRecord): Promise<AuthorAccessRequest | null> {
    const found = await this.requests.get(account.id);
    return found === null ? null : this.view(found.data, account);
  }

  /** The owner's queue, oldest first. A request whose account is gone, or already an author, is dropped. */
  async list(): Promise<AuthorAccessRequest[]> {
    const records = await this.requests.list();
    const rows = await mapWithConcurrency(records, async (record) => {
      const account = (await this.accounts.get(record.accountId))?.data ?? null;
      if (account === null || account.role === "author") {
        await this.requests.delete(record.accountId);
        return null;
      }
      return this.view(record, account);
    });
    return rows.filter((r): r is AuthorAccessRequest => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  count(): Promise<number> {
    return this.requests.count();
  }

  /** The owner decided: the request is gone either way (the role change itself is AccountAdminService.setRole). */
  async close(accountId: string): Promise<void> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError(400, "invalid account id");
    if ((await this.requests.get(accountId)) === null) throw noRequest();
    await this.requests.delete(accountId);
  }

  /** Throws 404 unless the account has an open request (checked before the owner's grant changes the role). */
  async assertOpen(accountId: string): Promise<void> {
    if (!ACCOUNT_ID_PATTERN.test(accountId) || (await this.requests.get(accountId)) === null) throw noRequest();
  }
}
