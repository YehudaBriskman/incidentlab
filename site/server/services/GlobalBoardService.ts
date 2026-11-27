// Opting in to and out of the public global leaderboard (#175). The board is off by default: a player's
// username and score become public only after they turn it on. The account keeps the choice
// (`showOnGlobalBoard`), and the `globalboard:<accountId>` marker exists only while it is on, so the board
// lists the opted-in players without scanning every account.
import type { AccountView } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { toAccountView } from "./AuthService.ts";
import type { CachePurger } from "./CachePurger.ts";
import { noopCachePurger } from "./CachePurger.ts";
import type { ScoreService } from "./ScoreService.ts";

const MAX_WRITE_RETRIES = 3;

export class GlobalBoardService {
  private readonly repos: Repositories;
  private readonly scores: ScoreService;
  private readonly purger: CachePurger;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; scores: ScoreService; purger?: CachePurger | undefined; now: () => Date }) {
    this.repos = deps.repos;
    this.scores = deps.scores;
    this.purger = deps.purger ?? noopCachePurger;
    this.now = deps.now;
  }

  /** Shows or hides an approved player on the public board, and purges the CDN copy so the change is seen at once. */
  async setShown(player: AccountRecord, show: boolean): Promise<AccountView> {
    if (player.kind === "guest") throw new AppError(403, "guests are never on the leaderboard; create an account first", { code: "guest" });
    if (show) {
      await this.scores.ensure(player.id); // the board lists only accounts with a summary
    } else {
      await this.repos.globalBoard.remove(player.id); // off the board before the flag says so
    }
    const account = await this.saveFlag(player.id, show);
    if (show) await this.repos.globalBoard.add(player.id, this.now().toISOString());
    await this.purger.purge(["leaderboard"]);
    return toAccountView(account);
  }

  /** Puts an account restored from the trash back on the board if it had opted in. */
  async restoreMarker(account: AccountRecord): Promise<void> {
    if (account.kind !== "user" || !account.showOnGlobalBoard) return;
    await this.scores.ensure(account.id);
    await this.repos.globalBoard.add(account.id, this.now().toISOString());
    await this.purger.purge(["leaderboard"]);
  }

  private async saveFlag(accountId: string, show: boolean): Promise<AccountRecord> {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const found = await this.repos.accounts.get(accountId);
      if (!found) throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
      if (found.data.showOnGlobalBoard === show) return found.data;
      const account = { ...found.data, showOnGlobalBoard: show };
      if (await this.repos.accounts.saveIfMatch(account, found.etag)) return account;
    }
    throw new AppError(409, "concurrent update, please retry");
  }
}
