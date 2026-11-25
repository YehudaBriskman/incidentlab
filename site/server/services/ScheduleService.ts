// "Incident of the day": which case is featured on a given date, and whether only that case may be started.
import type { Schedule, TodayResponse } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { ScheduleRepository } from "../repositories/repositories.ts";

export const isValidTimeZone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/** YYYY-MM-DD of `date` as seen in `timezone`. */
export const localDate = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

export class ScheduleService {
  private readonly repository: ScheduleRepository;
  private readonly releasedCaseIds: readonly string[];
  private readonly now: () => Date;

  constructor(deps: { repository: ScheduleRepository; releasedCaseIds: readonly string[]; now: () => Date }) {
    this.repository = deps.repository;
    this.releasedCaseIds = deps.releasedCaseIds;
    this.now = deps.now;
  }

  get(): Promise<Schedule> {
    return this.repository.get();
  }

  async save(schedule: Schedule): Promise<Schedule> {
    if (!isValidTimeZone(schedule.timezone)) throw new AppError(400, `unknown time zone: ${schedule.timezone}`);
    const referenced = [schedule.defaultCaseId, ...Object.values(schedule.days)].filter((id): id is string => id !== null);
    const unknown = referenced.find((id) => !this.releasedCaseIds.includes(id));
    if (unknown !== undefined) throw new AppError(400, `case is not released: ${unknown}`);
    // Drop entries older than a year so the record can't grow without bound.
    const cutoff = localDate(new Date(this.now().getTime() - 366 * 24 * 60 * 60 * 1000), schedule.timezone);
    const days = Object.fromEntries(Object.entries(schedule.days).filter(([day]) => day >= cutoff).sort(([a], [b]) => a.localeCompare(b)));
    const cleaned: Schedule = { ...schedule, days };
    await this.repository.save(cleaned);
    return cleaned;
  }

  async today(): Promise<TodayResponse> {
    const schedule = await this.repository.get();
    const date = localDate(this.now(), schedule.timezone);
    const scheduled = schedule.days[date] ?? schedule.defaultCaseId;
    const caseId = scheduled !== null && this.releasedCaseIds.includes(scheduled) ? scheduled : null;
    return { date, timezone: schedule.timezone, caseId, lockToToday: schedule.lockToToday, releasedCaseIds: [...this.releasedCaseIds] };
  }

  async canStart(caseId: string): Promise<boolean> {
    const today = await this.today();
    return !today.lockToToday || today.caseId === caseId;
  }

  /** Throws 403 when the schedule only allows today's case and `caseId` isn't it. */
  async assertCanStart(caseId: string): Promise<void> {
    if (!(await this.canStart(caseId))) {
      throw new AppError(403, "this case isn't open today", { code: "not-today" });
    }
  }
}
