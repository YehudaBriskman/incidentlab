// Whether a player may play a class event run (#253): the gate in front of every play route that names a run.
// A run is accepted only when, right now:
//   - the class exists and the player is an active member of it (else 403 "not-a-member");
//   - the class is active and its event window is live: startsAt <= now < endsAt (else 409 "event-not-live");
//   - the case is assigned to the class, or the class has no assigned cases and the case is public (else 409
//     "event-not-live": the event does not include this case).
// A refusal never falls back to the player's own run. Two small reads per call (the class and the membership).
import { caseCounts, classWindow } from "../domain/class-board.ts";
import { eventKeyOf, isEventLive } from "../domain/event-run.ts";
import type { EventRun } from "../domain/event-run.ts";
import { AppError } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { Player } from "./GameService.ts";

const notAMember = (): AppError => new AppError(403, "you are not an active member of that class", { code: "not-a-member" });
const notLive = (message: string): AppError => new AppError(409, message, { code: "event-not-live" });

export class EventRunService {
  private readonly repos: Repositories;
  private readonly publicCaseIds: () => readonly string[];
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; publicCaseIds: () => readonly string[]; now: () => Date }) {
    this.repos = deps.repos;
    this.publicCaseIds = deps.publicCaseIds;
    this.now = deps.now;
  }

  /** The event run the player may play on this case now; throws the refusal otherwise. */
  async resolve(player: Player, caseId: string, classId: string): Promise<EventRun> {
    const [found, member] = await Promise.all([this.repos.classes.get(classId), this.repos.classes.getMember(classId, player.id)]);
    if (!found || member?.data.status !== "active") throw notAMember();
    const record = found.data;
    if (record.status !== "active") throw notLive("that class is archived");
    const now = this.now();
    const eventKey = eventKeyOf(record.event);
    if (eventKey === null || !isEventLive(record.event, now)) throw notLive("that class has no event live now");
    const window = classWindow(record, { now, publicCaseIds: this.publicCaseIds() });
    if (!caseCounts(caseId, window)) throw notLive("this case is not part of that class event");
    return { classId: record.id, className: record.name, eventKey };
  }
}
