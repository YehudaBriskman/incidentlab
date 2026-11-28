// The schedule editor: the incident of the day, the default case, the time zone, and
// a month calendar (manage/scheduleCalendar.ts) with one case per day. Edits stay in a draft until Save; a sticky
// save bar shows while there is something unsaved, an error, or a fresh "saved".
// Scoped by its options: the schedule loads and saves through `api`, today's case comes from the dashboard.
import { T } from "../../i18n/strings-tools";
import { h, setChildren } from "../../lib/dom";
import { formField } from "../../components/formLayout";
import type { Schedule, TodayResponse } from "../../../shared/contract";
import { caseTitle } from "./caseInfo";
import { errMessage, locale } from "./format";
import { isolateText, nameNode } from "../../lib/bidi";
import { formatIsoDay } from "../../lib/bidi-core";
import type { ManageHost } from "./host";
import { monthOf, scheduleCalendar, type Month } from "./scheduleCalendar";

const DEFAULT_TIMEZONE = "Asia/Jerusalem";

export type ScheduleApi = {
  load(): Promise<Schedule>;
  /** Resolves to the schedule as saved. */
  save(schedule: Schedule): Promise<Schedule>;
};

export type ScheduleOptions = {
  host: ManageHost;
  /** The section element the editor renders into. */
  panel: HTMLElement;
  api: ScheduleApi;
  /** Today's date, time zone and case, and the released cases (the day selects list them). */
  today(): TodayResponse | null;
  /** True while the editor is the section on screen (a late load renders only then). */
  isActive(): boolean;
  /** An unsaved draft carried over from the previous render (a language switch): it wins over the first load. */
  carried?: Schedule | null;
  /** A save went through: the dashboard hides the "saved" note after a moment. */
  onSaved?: () => void;
  /** After a save, before the editor re-renders: the dashboard refreshes today's case. */
  afterSave?: () => Promise<void>;
};

export type SchedulePanel = {
  load(): Promise<void>;
  render(): void;
  /** Only the "incident of the day" line (the poll keeps it current without touching the form). */
  renderToday(): void;
  /** The draft differs from the saved schedule. */
  dirty(): boolean;
  /** The draft, or null before the first load. */
  draft(): Schedule | null;
  /** Drops the unsaved edits (back to the saved schedule). */
  discard(): void;
  /** The sticky save bar is on screen. */
  barVisible(): boolean;
  /** Hides the "saved" note. */
  clearNote(): void;
};

const cloneSchedule = (s: Schedule): Schedule => ({ ...s, days: { ...s.days } });

function scheduleSig(s: Schedule): string {
  const days = Object.entries(s.days).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([s.timezone, s.defaultCaseId, s.lockToToday, days]);
}

function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [DEFAULT_TIMEZONE, "UTC"];
  }
}

export function createSchedulePanel(opts: ScheduleOptions): SchedulePanel {
  const { host } = opts;
  let carried = opts.carried ?? null;
  const sch = {
    server: null as Schedule | null,
    draft: null as Schedule | null,
    loading: false,
    saving: false,
    error: null as string | null,
    msg: null as string | null,
    month: null as Month | null,
  };

  const scheduleTodayEl = h("p", { class: "sched-today" });

  function dirty(): boolean {
    const { server, draft } = sch;
    return server !== null && draft !== null && scheduleSig(server) !== scheduleSig(draft);
  }

  /** The save bar shows only while there is something to say: unsaved edits, an error, or a fresh "saved". */
  function barVisible(): boolean {
    return sch.draft !== null && (dirty() || sch.error !== null || sch.msg !== null);
  }

  function discard(): void {
    if (!sch.server) return;
    sch.draft = cloneSchedule(sch.server);
    sch.msg = null;
    sch.error = null;
  }

  async function load(): Promise<void> {
    sch.loading = true;
    sch.error = null;
    render();
    try {
      const s = await opts.api.load();
      if (host.disposed()) return;
      sch.server = cloneSchedule(s);
      // A draft carried over from the previous render (language switch) wins over the fresh copy.
      sch.draft = carried ? cloneSchedule(carried) : cloneSchedule(s);
      carried = null;
      if (!sch.month) sch.month = monthOf(opts.today()?.date ?? null);
    } catch (err: unknown) {
      if (host.disposed() || host.handleAuthError(err)) return;
      sch.error = errMessage(err);
    } finally {
      sch.loading = false;
    }
    if (opts.isActive()) render();
  }

  function caseOptions(selected: string | null, emptyLabel: string): HTMLOptionElement[] {
    const released = opts.today()?.releasedCaseIds ?? [];
    const options = [h("option", { value: "", selected: selected === null }, emptyLabel)];
    for (const id of released) options.push(h("option", { value: id, selected: id === selected }, caseTitle(id)));
    if (selected !== null && !released.includes(selected)) {
      options.push(h("option", { value: selected, selected: true }, T().admNotReleased(caseTitle(selected))));
    }
    return options;
  }

  function renderToday(): void {
    const today = opts.today();
    if (!today) {
      scheduleTodayEl.textContent = "";
      return;
    }
    setChildren(
      scheduleTodayEl,
      // the date in the UI locale, the date and the zone isolated so "(28 Nov 2026, Asia/Jerusalem)" keeps its order in Hebrew
      h("strong", {}, T().admTodayIs(isolateText(formatIsoDay(locale(), today.date)), isolateText(today.timezone))),
      " ",
      today.caseId ? nameNode(caseTitle(today.caseId)) : h("span", { class: "muted" }, T().admNoCaseToday),
    );
  }

  function updateDraft(mutate: (d: Schedule) => void): void {
    if (!sch.draft) return;
    mutate(sch.draft);
    sch.msg = null;
    sch.error = null;
    host.withFocusKept(render);
  }

  async function onSaveSchedule(): Promise<void> {
    if (!sch.draft) return;
    if (!isValidTimeZone(sch.draft.timezone)) {
      document.getElementById("sched-tz")?.focus();
      return;
    }
    sch.saving = true;
    sch.error = null;
    sch.msg = null;
    render();
    try {
      const saved = await opts.api.save(sch.draft);
      if (host.disposed()) return;
      sch.server = cloneSchedule(saved);
      sch.draft = cloneSchedule(saved);
      sch.msg = T().admScheduleSaved;
      opts.onSaved?.();
      await opts.afterSave?.();
    } catch (err: unknown) {
      if (host.disposed() || host.handleAuthError(err)) return;
      sch.error = errMessage(err);
    } finally {
      sch.saving = false;
    }
    if (opts.isActive()) render();
  }

  function render(): void {
    const { panel } = opts;
    renderToday();
    const todayPanel = h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admIncidentOfDay), scheduleTodayEl);
    if (!sch.draft) {
      setChildren(
        panel,
        todayPanel,
        sch.error
          ? h(
              "section",
              { class: "panel admin-panel" },
              h("p", { class: "admin-error", role: "alert" }, T().admScheduleLoadFailed(sch.error)),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => void load() }, T().admRetry),
            )
          : h("p", { class: "muted admin-loading" }, T().admLoading),
      );
      return;
    }
    const draft = sch.draft;
    const month = sch.month ?? monthOf(opts.today()?.date ?? null);
    sch.month = month;
    const isDirty = dirty();
    const tzValid = isValidTimeZone(draft.timezone);

    const defaultSelect = h("select", { class: "admin-input", id: "sched-default" }, caseOptions(draft.defaultCaseId, T().admNoneOpt));
    defaultSelect.addEventListener("change", () => {
      const v = defaultSelect.value;
      updateDraft((d) => {
        d.defaultCaseId = v === "" ? null : v;
      });
    });

    const tzListId = "sched-tz-list";
    const tzInput = h("input", {
      type: "text",
      class: "admin-input",
      id: "sched-tz",
      list: tzListId,
      value: draft.timezone,
      placeholder: DEFAULT_TIMEZONE,
      autocomplete: "off",
      spellcheck: "false",
      dir: "ltr",
    });
    // Validate while typing (in place: re-rendering would move the caret); the draft updates on change.
    const tzField = formField({ input: tzInput, label: T().admTimezone, help: T().admTimezoneHelp });
    tzField.setError(tzValid ? null : T().admTimezoneInvalid);
    tzInput.addEventListener("input", () => {
      const v = tzInput.value.trim();
      const ok = v === "" || isValidTimeZone(v);
      tzField.setError(ok ? null : T().admTimezoneInvalid);
      syncSave(ok);
    });
    tzInput.addEventListener("change", () => {
      const v = tzInput.value.trim();
      updateDraft((d) => {
        d.timezone = v === "" ? DEFAULT_TIMEZONE : v;
      });
    });
    const tzList = h("datalist", { id: tzListId }, timeZoneList().map((z) => h("option", { value: z })));

    const saveBtn = h(
      "button",
      { type: "button", class: "btn btn-primary", id: "sched-save", "aria-describedby": "sched-status" },
      sch.saving ? T().admSaving : T().admSaveSchedule,
    );
    saveBtn.addEventListener("click", () => void onSaveSchedule());
    const entries = Object.keys(draft.days).length;
    const statusEl = h("span", { class: "small", id: "sched-status", role: "status" });
    // An unknown time zone blocks Save, and the save bar says so (the field shows the details).
    function syncSave(tzOk: boolean): void {
      saveBtn.disabled = !isDirty || sch.saving || !tzOk;
      const blocked = isDirty && !tzOk;
      statusEl.className = `small ${blocked || isDirty ? "sched-dirty" : "muted"}`;
      statusEl.textContent = blocked ? T().admScheduleFixTz : isDirty ? T().admUnsaved : (sch.msg ?? T().admScheduledDays(entries));
    }
    syncSave(tzValid);
    const discardBtn = h(
      "button",
      { type: "button", class: "btn btn-ghost", id: "sched-discard", disabled: !isDirty || sch.saving },
      T().admDiscard,
    );
    discardBtn.addEventListener("click", () => {
      discard();
      render();
    });

    setChildren(
      panel,
      todayPanel,
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admScheduleSettings),
        h(
          "div",
          { class: "sched-form" },
          formField({ input: defaultSelect, label: T().admDefaultCase, help: T().admDefaultCaseHelp }).nodes,
          tzField.nodes,
          tzList,
        ),
      ),
      scheduleCalendar({
        draft,
        month,
        todayIso: opts.today()?.date ?? null,
        caseOptions,
        updateDraft,
        onMonthChange: (next) => {
          sch.month = next;
          host.withFocusKept(render);
        },
      }),
      h(
        "div",
        { class: "sched-actions panel admin-panel", hidden: !barVisible() },
        saveBtn,
        discardBtn,
        statusEl,
        sch.error ? h("p", { class: "admin-error", role: "alert" }, T().admScheduleSaveFailed(sch.error)) : null,
      ),
    );
    host.syncSaveBar();
  }

  return {
    load,
    render,
    renderToday,
    dirty,
    draft: () => sch.draft,
    discard,
    barVisible,
    clearNote: () => {
      sch.msg = null;
    },
  };
}
