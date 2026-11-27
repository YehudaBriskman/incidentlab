// "Incident of the day": which case is featured on a given date (the daily card and streaks). Since #180 it never
// decides whether a case may be played; `lockToToday` is stored and returned but no longer enforced.
import type { Schedule, TodayResponse } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { ScheduleRepository } from "../repositories/repositories.ts";
import { noopCachePurger, type CachePurger } from "./CachePurger.ts";

export const isValidTimeZone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/** Whole seconds from `date` to the next midnight in `timezone` (1..86400), so a cached "today" never outlives its day. */
export const secondsUntilNextDay = (date: Date, timezone: string): number => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const elapsed = part("hour") * 3600 + part("minute") * 60 + part("second");
  return Math.max(1, 86_400 - elapsed);
};

/** YYYY-MM-DD of `date` as seen in `timezone`. */
export const localDate = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

export class ScheduleService {
  private readonly repository: ScheduleRepository;
  /** read per call: the DB-published cases (#68), so a publish releases a case without a redeploy */
  private readonly releasedCaseIds: () => readonly string[];
  private readonly now: () => Date;
  private readonly purger: CachePurger;

  constructor(deps: { repository: ScheduleRepository; releasedCaseIds: () => readonly string[]; now: () => Date; purger?: CachePurger }) {
    this.repository = deps.repository;
    this.releasedCaseIds = deps.releasedCaseIds;
    this.now = deps.now;
    this.purger = deps.purger ?? noopCachePurger;
  }

  get(): Promise<Schedule> {
    return this.repository.get();
  }

  async save(schedule: Schedule): Promise<Schedule> {
    if (!isValidTimeZone(schedule.timezone)) throw new AppError(400, `unknown time zone: ${schedule.timezone}`);
    const referenced = [schedule.defaultCaseId, ...Object.values(schedule.days)].filter((id): id is string => id !== null);
    const unknown = referenced.find((id) => !this.releasedCaseIds().includes(id));
    if (unknown !== undefined) throw new AppError(400, `case is not released: ${unknown}`);
    // Drop entries older than a year so the record can't grow without bound.
    const cutoff = localDate(new Date(this.now().getTime() - 366 * 24 * 60 * 60 * 1000), schedule.timezone);
    const days = Object.fromEntries(Object.entries(schedule.days).filter(([day]) => day >= cutoff).sort(([a], [b]) => a.localeCompare(b)));
    const cleaned: Schedule = { ...schedule, days };
    await this.repository.save(cleaned);
    await this.purger.purge(["today"]); // the public, CDN-cached GET /api/today
    return cleaned;
  }

  async today(): Promise<TodayResponse> {
    const schedule = await this.repository.get();
    const date = localDate(this.now(), schedule.timezone);
    const scheduled = schedule.days[date] ?? schedule.defaultCaseId;
    const caseId = scheduled !== null && this.releasedCaseIds().includes(scheduled) ? scheduled : null;
    return { date, timezone: schedule.timezone, caseId, lockToToday: schedule.lockToToday, releasedCaseIds: [...this.releasedCaseIds()] };
  }

  /** Seconds until the schedule's next day starts: the most a cached "today" may be served for. */
  secondsUntilNextDay(timezone: string): number {
    return secondsUntilNextDay(this.now(), timezone);
  }
}
