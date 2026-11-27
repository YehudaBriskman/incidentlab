// The schedule editor's month calendar: one case select per day (empty = the default case), today and past days
// marked, previous / next / this month. It only renders; the editor (manage/schedule.ts) owns the draft and the
// month on screen and re-renders it after each change.
import { T } from "../../i18n/strings-tools";
import { h } from "../../lib/dom";
import type { Schedule } from "../../../shared/contract";
import { caseTitle } from "./caseInfo";
import { isoDay, locale } from "./format";
import { headWithHint } from "./ui";

export type Month = { y: number; m: number };

export type CalendarOptions = {
  draft: Schedule;
  month: Month;
  /** Today's date (YYYY-MM-DD) in the schedule's time zone, or null when unknown. */
  todayIso: string | null;
  /** The options of a day's select: the empty choice first, then the cases. */
  caseOptions(selected: string | null, emptyLabel: string): HTMLOptionElement[];
  /** Applies a change to the draft (and re-renders the editor). */
  updateDraft(mutate: (d: Schedule) => void): void;
  /** Shows another month (and re-renders the editor). */
  onMonthChange(month: Month): void;
};

/** The month an ISO date falls in, or this month. */
export function monthOf(iso: string | null): Month {
  const match = iso ? /^(\d{4})-(\d{2})-/.exec(iso) : null;
  if (match) return { y: Number(match[1]), m: Number(match[2]) - 1 };
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() };
}

export function scheduleCalendar(opts: CalendarOptions): HTMLElement {
  const { draft, month } = opts;
  const { y, m } = month;
  const first = new Date(Date.UTC(y, m, 1));
  const startDow = first.getUTCDay(); // weeks start on Sunday (Israel)
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const todayIso = opts.todayIso ?? "";
  const monthLabel = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  const weekdayFmt = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });
  const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  // Day cells are narrow: a short "Default" label (the full title is in the tooltip and the settings above).
  const defaultLabel = draft.defaultCaseId ? T().admDefaultShort : T().admNoneOpt;
  const defaultTip = draft.defaultCaseId ? T().admDefaultOpt(caseTitle(draft.defaultCaseId)) : T().admNoneOpt;
  const rtl = document.documentElement.dir === "rtl";
  const shift = (delta: number): void => {
    const d = new Date(Date.UTC(y, m + delta, 1));
    opts.onMonthChange({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  };

  const cells: HTMLElement[] = [];
  for (let i = 0; i < 7; i += 1) {
    cells.push(h("div", { class: "cal-dow", "aria-hidden": "true" }, weekdayFmt.format(Date.UTC(2023, 0, 1 + i))));
  }
  for (let i = 0; i < startDow; i += 1) cells.push(h("div", { class: "cal-day is-blank", "aria-hidden": "true" }));
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = isoDay(y, m, d);
    const assigned = draft.days[iso] ?? null;
    const isToday = iso === todayIso;
    const isPast = todayIso !== "" && iso < todayIso;
    const select = h(
      "select",
      { class: "admin-input cal-select", id: `cal-${iso}`, "aria-label": T().admDayCaseLabel(dayFmt.format(Date.UTC(y, m, d))),
        title: assigned ? caseTitle(assigned) : defaultTip,
      },
      opts.caseOptions(assigned, defaultLabel),
    );
    select.addEventListener("change", () => {
      const v = select.value;
      opts.updateDraft((dr) => {
        if (v === "") delete dr.days[iso];
        else dr.days[iso] = v;
      });
    });
    cells.push(
      h(
        "div",
        { class: `cal-day${isToday ? " is-today" : ""}${assigned ? " is-set" : ""}${isPast ? " is-past" : ""}` },
        h(
          "div",
          { class: "cal-day-head" },
          // The weekday shows only in the phone list (the grid has a weekday header); the select's label names the day.
          h("span", { class: "cal-wd", "aria-hidden": "true" }, weekdayFmt.format(Date.UTC(y, m, d))),
          h("span", { class: "cal-num" }, String(d)),
          isToday ? h("span", { class: "today-tag" }, T().admTodayTag) : null),
        select,
      ),
    );
  }
  return h(
    "section",
    { class: "panel admin-panel" },
    h(
      "div",
      { class: "cal-head" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "cal-prev", "aria-label": T().admPrevMonth, onclick: () => shift(-1) }, rtl ? "→" : "←"),
      headWithHint(h("h2", { class: "admin-h2 cal-title", "aria-live": "polite" }, monthLabel), T().admCalendarHint),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "cal-next", "aria-label": T().admNextMonth, onclick: () => shift(1) }, rtl ? "←" : "→"),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          id: "cal-this",
          onclick: () => {
            opts.onMonthChange(monthOf(opts.todayIso));
          },
        },
        T().admThisMonth,
      ),
    ),
    h("p", { class: "muted small admin-hint is-touch-only" }, T().admCalendarHint),
    h("div", { class: "cal-grid" }, cells),
  );
}
