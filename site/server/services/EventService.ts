// Live event window, announcement and leaderboard freeze; plus the class settings (invite code).
import type { LiveEvent, Settings } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { EventRepository, SettingsRepository } from "../repositories/config-repositories.ts";
import { noopCachePurger, type CachePurger } from "./CachePurger.ts";

/** The event's own times must make sense: it ends after it starts, and the board freezes before the end. Classes use it too. */
export const assertEventWindow = (event: { startsAt: string | null; endsAt: string | null; freezeAt: string | null }): void => {
  const { startsAt, endsAt, freezeAt } = event;
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) throw new AppError(400, "the event must end after it starts");
  if (freezeAt !== null && endsAt !== null && Date.parse(freezeAt) > Date.parse(endsAt)) throw new AppError(400, "freeze the leaderboard before the event ends");
};

export class EventService {
  private readonly events: EventRepository;
  private readonly settingsRepo: SettingsRepository;
  private readonly now: () => Date;
  private readonly purger: CachePurger;

  constructor(deps: { events: EventRepository; settings: SettingsRepository; now: () => Date; purger?: CachePurger }) {
    this.events = deps.events;
    this.settingsRepo = deps.settings;
    this.now = deps.now;
    this.purger = deps.purger ?? noopCachePurger;
  }

  async get(): Promise<{ event: LiveEvent; serverTime: string }> {
    return { event: await this.events.get(), serverTime: this.now().toISOString() };
  }

  async save(event: LiveEvent): Promise<{ event: LiveEvent; serverTime: string }> {
    assertEventWindow(event);
    const { startsAt, endsAt } = event;
    if (event.enforceWindow && (startsAt === null || endsAt === null)) throw new AppError(400, "set a start and an end to enforce the window");
    await this.events.save(event);
    // Both public GETs read the event: /api/event directly, /api/leaderboard through the freeze moment.
    await this.purger.purge(["event", "leaderboard"]);
    return this.get();
  }

  /** Throws 403 "event-closed" when the event enforces its window and now is outside it. */
  async assertOpen(): Promise<void> {
    const event = await this.events.get();
    if (!event.enforceWindow || event.startsAt === null || event.endsAt === null) return;
    const nowMs = this.now().getTime();
    if (nowMs < Date.parse(event.startsAt)) throw new AppError(403, "the event hasn't started yet", { code: "event-closed" });
    if (nowMs >= Date.parse(event.endsAt)) throw new AppError(403, "the event is over", { code: "event-closed" });
  }

  /** The moment the public leaderboard is frozen at, or null when it is live. */
  async freezeMoment(): Promise<string | null> {
    const { freezeAt } = await this.events.get();
    return freezeAt !== null && this.now().getTime() >= Date.parse(freezeAt) ? freezeAt : null;
  }

  settings(): Promise<Settings> {
    return this.settingsRepo.get();
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    await this.settingsRepo.save(settings);
    return settings;
  }
}
