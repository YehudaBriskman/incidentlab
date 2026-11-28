// Class boards on capability URLs and class live progress (#181).
//
// The board (`GET /api/classboard/<boardToken>`) is public and CDN-cached: the token is the capability, given only
// to the class's active members and admins. It reads the class, one listing of `classmember:<classId>:` and, per
// active member, the account (username only) and the `score:` summary: never a progress record, never a scan.
// What counts is decided by the class's window rules (domain/class-board.ts).
//
// Event runs (#253): while the class has an event window, the board also lists the event occurrence's records
// (`eventprogress:<classId>:<eventKey>:`, one key listing plus one read per record) and lets them replace the
// members' own runs of those cases (domain/class-board.ts, withEventRuns).
//
// Solves don't purge the board's CDN copy: a purge per correct answer would cost a purge call per solve during a
// class night, while the 10 s cache window already bounds how stale the board can be. Class edits do purge it
// (ClassService), so a rotated token, an archive or a removed member applies at once.
import { createHash, timingSafeEqual } from "node:crypto";
import type { AdminProgress, ClassBoardResponse } from "../../shared/contract.ts";
import { classBoardRows, classWindow, withEventRuns } from "../domain/class-board.ts";
import { eventKeyOf, isEventLive } from "../domain/event-run.ts";
import type { ProgressRecord } from "../domain/types.ts";
import type { ClassBoardMember } from "../domain/class-board.ts";
import type { ClassRecord } from "../domain/classes.ts";
import { AppError } from "../domain/types.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { ACCOUNT_ID_PATTERN } from "./crypto.ts";
import type { GameService } from "./GameService.ts";

/** Longer than any token we issue (`<12>.<32>`); anything longer is refused before it is hashed. */
const MAX_TOKEN_CHARS = 128;

const boardNotFound = (): AppError => new AppError(404, "not found");

/** Constant-time comparison of two tokens of any length (both are hashed to 32 bytes first). */
export const sameToken = (given: string, stored: string): boolean => {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(stored, "utf8").digest();
  return timingSafeEqual(a, b);
};

/** The class id a board token names, or null when the token can't be one of ours. */
export const classIdOfToken = (token: string): string | null => {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const dot = token.indexOf(".");
  const classId = dot < 0 ? "" : token.slice(0, dot);
  return ACCOUNT_ID_PATTERN.test(classId) ? classId : null;
};

export class ClassBoardService {
  private readonly repos: Repositories;
  private readonly game: GameService;
  private readonly publicCaseIds: () => readonly string[];
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; game: GameService; publicCaseIds: () => readonly string[]; now: () => Date }) {
    this.repos = deps.repos;
    this.game = deps.game;
    this.publicCaseIds = deps.publicCaseIds;
    this.now = deps.now;
  }

  /** The class behind a board token; a generic 404 for a malformed, unknown, rotated or archived one. */
  async classOfToken(token: string): Promise<ClassRecord> {
    const classId = classIdOfToken(token);
    if (classId === null) throw boardNotFound();
    const found = await this.repos.classes.get(classId);
    if (!found || !sameToken(token, found.data.boardToken) || found.data.status !== "active") throw boardNotFound();
    return found.data;
  }

  /** The class board, overall or for one case. */
  async board(token: string, caseId: string | null): Promise<ClassBoardResponse> {
    const record = await this.classOfToken(token);
    const now = this.now();
    const window = classWindow(record, { now, publicCaseIds: this.publicCaseIds() });
    const members = await this.boardMembers(record);
    const rows = classBoardRows(members, window, { caseId });
    return {
      caseId,
      period: "all",
      periodStart: null,
      frozen: window.cutoff !== null,
      frozenAt: window.cutoff,
      generatedAt: now.toISOString(),
      entries: rows.map((row) => ({
        rank: row.rank,
        username: row.username,
        score: row.score,
        stagesSolved: row.stagesSolved,
        casesCompleted: row.casesCompleted,
        firstBloods: row.firstBloods,
        lastSolveAt: row.lastSolveAt,
      })),
      classId: record.id,
      className: record.name,
      event: record.event,
      // The board is a CDN-cached capability URL: it never names a private case (#184), whose points still count.
      caseIds: record.caseIds.filter((id) => window.publicCaseIds.includes(id)),
    };
  }

  /**
   * Class admins' live view of one case: each active member's progress, the same view as the admin Live tab.
   * Reads only the members' own `progress:<caseId>:<member>` records (at most `memberLimit` of them); members who
   * haven't opened the case are left out. While the class event is live, a member's event run of the case
   * replaces their own run (#268), the same rule as the class board.
   */
  async liveProgress(record: ClassRecord, caseId: string): Promise<{ generatedAt: string; caseId: string; players: AdminProgress[] }> {
    this.game.caseSecrets(caseId); // 404 for unknown cases
    const active = (await this.repos.classes.listMembers(record.id, record.memberLimit)).filter(({ member }) => member.status === "active");
    const eventKey = isEventLive(record.event, this.now()) ? eventKeyOf(record.event) : null;
    const eventStore = eventKey === null ? null : this.repos.eventProgress.forEvent(record.id, eventKey);
    const rows = await mapWithConcurrency(active, async ({ accountId }) => {
      const [account, own, event] = await Promise.all([
        this.repos.accounts.get(accountId),
        this.repos.progress.get(caseId, accountId),
        eventStore === null ? Promise.resolve(null) : eventStore.get(caseId, accountId),
      ]);
      const progress = event ?? own;
      return account && progress ? this.game.toAdminView(progress.data, account.data) : null;
    });
    const players = rows.filter((p): p is AdminProgress => p !== null).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    return { generatedAt: this.now().toISOString(), caseId, players };
  }

  /**
   * Active members with a full, approved account, and their score summaries (none yet = nothing solved), with the
   * current event occurrence's event-run records in place of their own runs of those cases (#253).
   */
  private async boardMembers(record: ClassRecord): Promise<ClassBoardMember[]> {
    const eventKey = eventKeyOf(record.event);
    const [listed, eventRecords] = await Promise.all([
      this.repos.classes.listMembers(record.id, record.memberLimit),
      eventKey === null ? Promise.resolve([]) : this.repos.eventProgress.listEvent(record.id, eventKey),
    ]);
    const active = listed.filter(({ member }) => member.status === "active");
    const runsOf = new Map<string, ProgressRecord[]>();
    for (const run of eventRecords) runsOf.set(run.accountId, [...(runsOf.get(run.accountId) ?? []), run]);
    const members = await mapWithConcurrency(active, async ({ accountId }): Promise<ClassBoardMember | null> => {
      const [account, score] = await Promise.all([this.repos.accounts.get(accountId), this.repos.scores.get(accountId)]);
      if (!account || account.data.kind !== "user" || account.data.status !== "approved") return null;
      return { accountId, username: account.data.username, cases: withEventRuns(score?.data.cases ?? {}, runsOf.get(accountId) ?? []) };
    });
    return members.filter((m): m is ClassBoardMember => m !== null);
  }
}
