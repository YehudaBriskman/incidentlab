// The event form: the window (start, end, freeze), the announcement, a live status line
// with the countdown, and quick actions (start now for an hour, end now, freeze / unfreeze) that save only the
// timing. Controls are built once and synced from the draft, so polling never steals focus; a sticky save bar
// shows while there is something unsaved. Scoped by its options: the event loads and saves through `api`.
import { T } from "../../i18n/strings-tools";
import { h, setChildren } from "../../lib/dom";
import { toast } from "../../lib/overlay";
import { formField } from "../../components/formLayout";
import type { LiveEvent } from "../../../shared/contract";
import type { AdminEventResult } from "../../lib/admin-api";
import { errMessage, formatDateTime, formatDateTimeZone, formatDuration, locale, ms } from "./format";
import type { ManageHost } from "./host";
import { browserTimeZone, cloneEvent, eventSig, isoToLocalInput, localInputToIso, normalizeEvent } from "./eventModel";
import { headWithHint } from "./ui";

/** "Start now" opens the window for this long. */
const EVENT_QUICK_MINUTES = 60;

export type EventApi = {
  /** The saved event and the server clock. */
  load(): Promise<AdminEventResult>;
  /** Resolves to the event as saved, with the server clock. */
  save(event: LiveEvent): Promise<AdminEventResult>;
};

export type EventOptions = {
  host: ManageHost;
  /** The section element the form renders into. */
  panel: HTMLElement;
  api: EventApi;
  /** True while the form is the section on screen (late responses re-render only then). */
  isActive(): boolean;
  /** An unsaved draft carried over from the previous render (a language switch): it wins over the first load. */
  carried?: LiveEvent | null;
  /** A save went through: the dashboard hides the "saved" note after a moment. */
  onSaved?: () => void;
};

export type EventPanel = {
  load(): Promise<void>;
  render(): void;
  /** The save bar, buttons, field errors and status (no form rebuild). */
  renderControls(): void;
  /** The status line and countdown (ticks every second). */
  renderStatus(): void;
  /** A polled copy of the saved event: the draft follows it unless it has unsaved edits. */
  applyPoll(res: AdminEventResult): void;
  /** Bumped by every save: a poll that started earlier must not overwrite the saved value. */
  rev(): number;
  saving(): boolean;
  /** The saved event, or null before the first load. */
  server(): LiveEvent | null;
  /** The server clock (from the last response). */
  serverNow(): number;
  dirty(): boolean;
  draft(): LiveEvent | null;
  discard(): void;
  barVisible(): boolean;
  /** Hides the "saved" note. */
  clearNote(): void;
};

export function createEventPanel(opts: EventOptions): EventPanel {
  const { host } = opts;
  let carried = opts.carried ?? null;
  const ev = {
    server: null as LiveEvent | null,
    draft: null as LiveEvent | null,
    /** serverTime - Date.now() at the last response */
    offsetMs: 0,
    rev: 0,
    loading: false,
    saving: false,
    error: null as string | null,
    msg: null as string | null,
  };

  const serverNow = (): number => Date.now() + ev.offsetMs;
  const isoAt = (t: number): string => new Date(Math.floor(t / 1000) * 1000).toISOString();

  function dirty(): boolean {
    const { server, draft } = ev;
    return server !== null && draft !== null && eventSig(server) !== eventSig(draft);
  }

  function barVisible(): boolean {
    return ev.draft !== null && (dirty() || ev.error !== null || ev.msg !== null || ev.saving);
  }

  function discard(): void {
    if (!ev.server) return;
    ev.draft = cloneEvent(ev.server);
    ev.msg = null;
    ev.error = null;
    if (eventBuilt) syncEventForm();
  }

  /** Field-level problems the server would reject, shown next to the field (not only in the save bar). */
  function eventFieldErrors(d: LiveEvent): { end: string | null; freeze: string | null } {
    const start = ms(d.startsAt);
    const end = ms(d.endsAt);
    const freeze = ms(d.freezeAt);
    return {
      end: start !== null && end !== null && end <= start ? T().admErrEndBeforeStart : null,
      freeze: freeze !== null && end !== null && freeze > end ? T().admErrFreezeAfterEnd : null,
    };
  }

  const evStatusEl = h("p", { class: "adm-ev-status", "aria-live": "off" });
  const evClockEl = h("p", { class: "muted small adm-ev-clock" });
  const evBodyEl = h("div", { class: "admin-tabpanel adm-ev-body" });

  const evName = h("input", { type: "text", id: "ev-name", class: "admin-input", maxlength: 80, placeholder: T().admEventNamePh, autocomplete: "off", dir: "auto" });
  const timeInput = (id: string): HTMLInputElement =>
    h("input", { type: "datetime-local", id, class: "admin-input ev-time", step: 60, dir: "ltr", "aria-describedby": `${id}-preview ev-tz` });
  /** The picker shows the browser's own format (often US): this line repeats the value in the app locale, with the zone. */
  const timePreview = (id: string): HTMLParagraphElement => h("p", { class: "muted small ev-time-preview", id: `${id}-preview` });
  const evStart = timeInput("ev-start");
  const evEnd = timeInput("ev-end");
  const evFreeze = timeInput("ev-freeze");
  const evStartPreview = timePreview("ev-start");
  const evEndPreview = timePreview("ev-end");
  const evFreezePreview = timePreview("ev-freeze");
  const evAnnText = h("textarea", { id: "ev-ann", class: "admin-input ev-ann", maxlength: 280, rows: 3, dir: "auto", "aria-describedby": "ev-ann-help ev-ann-count" });
  const evAnnCount = h("span", { class: "muted small", id: "ev-ann-count" });
  const evAnnLevel = h(
    "select",
    { id: "ev-ann-level", class: "admin-input" },
    h("option", { value: "info" }, T().admLevel("info")),
    h("option", { value: "warning" }, T().admLevel("warning")),
  );
  const evAnnClear = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admAnnClear);
  const evStartNow = h("button", { type: "button", class: "btn btn-sm" }, T().admStartNow);
  const evEndNow = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admEndNow);
  const evFreezeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admFreezeNow);
  const evSave = h("button", { type: "button", class: "btn btn-primary", id: "ev-save" }, T().admSaveEvent);
  const evDiscard = h("button", { type: "button", class: "btn btn-ghost", id: "ev-discard" }, T().admDiscard);
  const evStateEl = h("span", { class: "small", role: "status" });
  const evErrorEl = h("p", { class: "admin-error", role: "alert" });
  const evBar = h("div", { class: "sched-actions panel admin-panel" }, evSave, evDiscard, evStateEl, evErrorEl);

  function clearTimeBtn(input: HTMLInputElement, label: string, apply: (d: LiveEvent) => void): HTMLButtonElement {
    return h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        "aria-label": T().admClearTimeLabel(label),
        onclick: () => {
          input.value = "";
          editEvent(apply);
        },
      },
      T().admClearTime,
    );
  }

  // The form's fields (components/formLayout.ts): label, inline error, control; the time fields add the locale
  // preview and a Clear button, and stay described by the preview and the time-zone note.
  const evNameField = formField({ input: evName, label: T().admEventName });
  // A note (the freeze explanation) goes under the control, so the three time inputs line up across columns.
  const timeField = (input: HTMLInputElement, label: string, preview: HTMLElement, apply: (d: LiveEvent) => void, note?: string) => {
    const noteId = `${input.id}-note`;
    return formField({
      input,
      label,
      describedBy: [preview.id, ...(note ? [noteId] : []), "ev-tz"],
      extra: h(
        "div",
        { class: "ev-time-extra" },
        preview,
        clearTimeBtn(input, label, apply),
        note ? h("p", { class: "muted small ev-time-note", id: noteId }, note) : null,
      ),
    });
  };
  const evStartField = timeField(evStart, T().admStartsAt, evStartPreview, (d) => (d.startsAt = null));
  const evEndField = timeField(evEnd, T().admEndsAt, evEndPreview, (d) => (d.endsAt = null));
  const evFreezeField = timeField(evFreeze, T().admFreezeAt, evFreezePreview, (d) => (d.freezeAt = null), T().admFreezeHelp);

  /** Mutates the draft from a control and refreshes the derived bits (no form rebuild). */
  function editEvent(mutate: (d: LiveEvent) => void): void {
    if (!ev.draft) return;
    mutate(ev.draft);
    ev.msg = null;
    ev.error = null;
    renderControls();
  }

  evName.addEventListener("input", () => editEvent((d) => (d.name = evName.value)));
  evStart.addEventListener("change", () => editEvent((d) => (d.startsAt = localInputToIso(evStart.value))));
  evEnd.addEventListener("change", () => editEvent((d) => (d.endsAt = localInputToIso(evEnd.value))));
  evFreeze.addEventListener("change", () => editEvent((d) => (d.freezeAt = localInputToIso(evFreeze.value))));
  const levelOf = (v: string): "info" | "warning" => (v === "warning" ? "warning" : "info");
  evAnnText.addEventListener("input", () => editEvent((d) => (d.announcement = { text: evAnnText.value, level: levelOf(evAnnLevel.value) })));
  evAnnLevel.addEventListener("change", () => editEvent((d) => (d.announcement = { text: evAnnText.value, level: levelOf(evAnnLevel.value) })));
  evAnnClear.addEventListener("click", () => {
    evAnnText.value = "";
    editEvent((d) => (d.announcement = null));
    evAnnText.focus();
  });
  evSave.addEventListener("click", () => {
    const d = ev.draft;
    if (!d) return;
    const errs = eventFieldErrors(d);
    const first = errs.end ? evEnd : errs.freeze ? evFreeze : null;
    if (first) {
      ev.msg = null;
      renderControls();
      evStateEl.textContent = T().admFixFields;
      first.focus();
      return;
    }
    void onSaveEvent();
  });
  evDiscard.addEventListener("click", () => discard());

  /**
   * Quick actions change only the timing of the SAVED event (server clock) and save just that; half-edited
   * fields in the form are neither saved nor lost: they are re-applied on top of the result.
   */
  async function quickEvent(mutate: (d: LiveEvent, now: number) => void): Promise<boolean> {
    if (!ev.server || ev.saving) return false;
    const base = cloneEvent(ev.server);
    const draftBefore = ev.draft ? cloneEvent(ev.draft) : null;
    const next = cloneEvent(base);
    mutate(next, serverNow());
    ev.rev += 1;
    ev.saving = true;
    ev.error = null;
    ev.msg = null;
    renderControls();
    try {
      const res = await opts.api.save(normalizeEvent(next));
      if (host.disposed()) return false;
      applyResult(res, false);
      const merged = cloneEvent(res.event);
      if (draftBefore) {
        // Keep each field the instructor had edited (it differs from the old saved value) and the action didn't touch.
        const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
        if (!same(draftBefore.name, base.name)) merged.name = draftBefore.name;
        if (!same(draftBefore.startsAt, base.startsAt) && same(next.startsAt, base.startsAt)) merged.startsAt = draftBefore.startsAt;
        if (!same(draftBefore.endsAt, base.endsAt) && same(next.endsAt, base.endsAt)) merged.endsAt = draftBefore.endsAt;
        if (!same(draftBefore.freezeAt, base.freezeAt) && same(next.freezeAt, base.freezeAt)) merged.freezeAt = draftBefore.freezeAt;
        if (!same(draftBefore.announcement, base.announcement)) merged.announcement = draftBefore.announcement ? { ...draftBefore.announcement } : null;
      }
      ev.draft = merged;
      ev.msg = T().admEventSaved;
      opts.onSaved?.();
      syncEventForm();
    } catch (err: unknown) {
      if (host.disposed() || host.handleAuthError(err)) return false;
      ev.error = errMessage(err);
    } finally {
      ev.saving = false;
    }
    if (opts.isActive()) renderControls();
    return ev.error === null;
  }

  /** The "(other edits stay unsaved)" note, only when there are other edits. */
  const draftNote = (): string | undefined => (dirty() ? T().admDraftStays : undefined);

  evStartNow.addEventListener("click", () =>
    void quickEvent((d, now) => {
      d.startsAt = isoAt(now);
      d.endsAt = isoAt(now + EVENT_QUICK_MINUTES * 60_000);
      // A freeze from an earlier run (or past the new end) would freeze the new event at the wrong moment.
      const f = ms(d.freezeAt);
      if (f !== null && (f < now || f > now + EVENT_QUICK_MINUTES * 60_000)) d.freezeAt = null;
    }),
  );
  evEndNow.addEventListener("click", () => {
    const saved = ev.server;
    if (!saved) return;
    const name = saved.name.trim() || T().admTheEvent;
    void host.askConfirm({
      title: T().admEndTitle(name),
      body: T().admEndBodyOpen,
      note: draftNote(),
      confirmLabel: T().admEndNow,
      tone: "danger",
      returnFocus: () => evEndNow,
    }).then((ok) => {
      if (!ok) return;
      void quickEvent((d, now) => {
        d.endsAt = isoAt(now);
        const s = ms(d.startsAt);
        if (s !== null && s >= now) d.startsAt = isoAt(now - 60_000);
        const f = ms(d.freezeAt);
        if (f !== null && f > now) d.freezeAt = null; // never reached: the standings at the end are final anyway
      });
    });
  });
  evFreezeBtn.addEventListener("click", () => {
    const unfreeze = isFrozen();
    void host.askConfirm({
      title: unfreeze ? T().admUnfreezeTitle : T().admFreezeTitle,
      body: unfreeze ? T().admUnfreezeBody : T().admFreezeBody,
      note: draftNote(),
      confirmLabel: unfreeze ? T().admUnfreeze : T().admFreezeNow,
      tone: unfreeze ? "primary" : "danger",
      returnFocus: () => evFreezeBtn,
    }).then(async (ok) => {
      if (!ok) return;
      const previous = ev.server?.freezeAt ?? null;
      const saved = await quickEvent((d, now) => {
        if (unfreeze) {
          d.freezeAt = null;
          return;
        }
        const end = ms(d.endsAt);
        d.freezeAt = end !== null && end < now ? isoAt(end) : isoAt(now);
      });
      if (!saved) return;
      toast({
        tone: "success",
        text: unfreeze ? T().admUnfrozenToast : T().admFrozenToast,
        action: { label: T().admUndo, run: () => void quickEvent((d) => void (d.freezeAt = previous)) },
      });
    });
  });

  function isFrozen(): boolean {
    const f = ms(ev.server?.freezeAt ?? null);
    return f !== null && f <= serverNow();
  }

  function applyResult(res: AdminEventResult, fromPoll: boolean): void {
    ev.offsetMs = (ms(res.serverTime) ?? Date.now()) - Date.now();
    const changed = ev.server === null || eventSig(ev.server) !== eventSig(res.event);
    const keepDraft = fromPoll && ev.draft !== null && dirty();
    ev.server = cloneEvent(res.event);
    if (!keepDraft && (changed || ev.draft === null)) {
      ev.draft = cloneEvent(res.event);
      if (opts.isActive()) syncEventForm();
    } else if (opts.isActive()) {
      renderControls();
    }
  }

  async function load(): Promise<void> {
    ev.loading = true;
    ev.error = null;
    render();
    try {
      const rev = ev.rev;
      const res = await opts.api.load();
      if (host.disposed()) return;
      if (rev === ev.rev) applyResult(res, false);
      // A draft carried over from the previous render (language switch) wins over the fresh copy.
      if (carried) {
        ev.draft = cloneEvent(carried);
        carried = null;
      }
    } catch (err: unknown) {
      if (host.disposed() || host.handleAuthError(err)) return;
      ev.error = errMessage(err);
    } finally {
      ev.loading = false;
    }
    if (opts.isActive()) render();
  }

  async function onSaveEvent(): Promise<void> {
    if (!ev.draft || ev.saving) return;
    ev.rev += 1;
    ev.saving = true;
    ev.error = null;
    ev.msg = null;
    renderControls();
    try {
      const res = await opts.api.save(normalizeEvent(ev.draft));
      if (host.disposed()) return;
      applyResult(res, false);
      ev.draft = cloneEvent(res.event);
      ev.msg = T().admEventSaved;
      opts.onSaved?.();
      syncEventForm();
    } catch (err: unknown) {
      if (host.disposed() || host.handleAuthError(err)) return;
      ev.error = errMessage(err);
    } finally {
      ev.saving = false;
    }
    if (opts.isActive()) renderControls();
  }

  /** Copies the draft into the controls (after a load, save, discard or quick action). */
  function syncEventForm(): void {
    const d = ev.draft;
    if (!d) return;
    evName.value = d.name;
    evStart.value = isoToLocalInput(d.startsAt);
    evEnd.value = isoToLocalInput(d.endsAt);
    evFreeze.value = isoToLocalInput(d.freezeAt);
    evAnnText.value = d.announcement?.text ?? "";
    evAnnLevel.value = d.announcement?.level ?? "info";
    renderControls();
  }

  function renderControls(): void {
    const isDirty = dirty();
    const busy = ev.saving || ev.draft === null;
    evSave.disabled = busy || !isDirty;
    evSave.textContent = ev.saving ? T().admSaving : T().admSaveEvent;
    evDiscard.disabled = busy || !isDirty;
    for (const b of [evStartNow, evEndNow, evFreezeBtn]) b.disabled = busy;
    evAnnClear.disabled = busy || evAnnText.value === "";
    evAnnCount.textContent = T().admCharsLeft(280 - evAnnText.value.length);
    evStateEl.textContent = isDirty ? T().admUnsaved : ev.msg ?? "";
    evStateEl.className = `small ${isDirty ? "sched-dirty" : "muted"}`;
    evErrorEl.textContent = ev.error ? T().admSaveFailed(ev.error) : "";
    evErrorEl.hidden = ev.error === null;
    const errs = ev.draft ? eventFieldErrors(ev.draft) : { end: null, freeze: null };
    evEndField.setError(errs.end);
    evFreezeField.setError(errs.freeze);
    if (ev.draft) {
      const preview = (el: HTMLElement, iso: string | null): void => {
        el.textContent = iso === null ? T().admTimeNotSet : formatDateTimeZone(iso);
      };
      preview(evStartPreview, ev.draft.startsAt);
      preview(evEndPreview, ev.draft.endsAt);
      preview(evFreezePreview, ev.draft.freezeAt);
    }
    evBar.hidden = !barVisible();
    host.syncSaveBar();
    renderStatus();
  }

  /** Status line + countdown from the saved event and the server clock (ticks every second). */
  function renderStatus(): void {
    const e = ev.server;
    evFreezeBtn.textContent = isFrozen() ? T().admUnfreeze : T().admFreezeNow;
    if (!e) {
      evStatusEl.textContent = "";
      evClockEl.textContent = "";
      return;
    }
    const now = serverNow();
    const start = ms(e.startsAt);
    const end = ms(e.endsAt);
    let phase: string;
    let tone: "live" | "idle" | "soon" | "over";
    if (start === null && end === null) {
      phase = T().admStatusNoWindow;
      tone = "idle";
    } else if (start !== null && now < start) {
      phase = T().admStatusStartsIn(formatDuration(start - now));
      tone = "soon";
    } else if (end !== null && now >= end) {
      phase = T().admStatusEnded(formatDuration(now - end));
      tone = "over";
    } else if (end === null) {
      phase = T().admStatusLiveOpen;
      tone = "live";
    } else {
      phase = start === null ? T().admStatusEndsIn(formatDuration(end - now)) : T().admStatusLive(formatDuration(end - now));
      tone = "live";
    }
    const parts = [phase];
    const f = ms(e.freezeAt);
    if (f !== null) parts.push(f <= now ? T().admStatusFrozen(formatDateTime(e.freezeAt)) : T().admStatusFreezesIn(formatDuration(f - now)));
    const label = e.name.trim();
    // Each part carries its separator at its own end, so a wrapped line never starts with a stray "·" (#129).
    const segs: Array<{ text: string; strong: boolean }> = [
      ...(label ? [{ text: label, strong: true }] : []),
      ...parts.map((text) => ({ text, strong: false })),
    ];
    setChildren(
      evStatusEl,
      h("span", { class: `adm-ev-dot is-${tone}`, "aria-hidden": "true" }),
      segs.map((s, i) =>
        h("span", { class: "adm-ev-part" }, s.strong ? h("strong", {}, s.text) : s.text, i < segs.length - 1 ? " ·" : ""),
      ),
    );
    evClockEl.textContent = T().admServerClock(new Intl.DateTimeFormat(locale(), { timeStyle: "medium" }).format(now));
  }

  function buildEventPanel(): void {
    const tz = browserTimeZone();
    setChildren(
      evBodyEl,
      h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admEventTitle), evStatusEl, evClockEl),
      h(
        "section",
        { class: "panel admin-panel" },
        headWithHint(h("h2", { class: "admin-h2" }, T().admQuickActions), T().admQuickHelp),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admQuickHelp),
        h("div", { class: "adm-ev-quick" }, evStartNow, evEndNow, evFreezeBtn),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admScheduleSettings),
        h(
          "div",
          { class: "sched-form adm-ev-form" },
          evNameField.nodes,
          evStartField.nodes,
          evEndField.nodes,
          evFreezeField.nodes,
          h("p", { class: "muted small ev-tz", id: "ev-tz" }, T().admTzNote(tz.name, tz.offset)),
        ),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admAnnouncement),
        h("p", { class: "muted small admin-hint", id: "ev-ann-help" }, T().admAnnouncementHelp),
        h(
          "div",
          { class: "adm-ev-ann" },
          h("label", { class: "visually-hidden", for: "ev-ann" }, T().admAnnouncement),
          evAnnText,
          h(
            "div",
            { class: "adm-ev-ann-row" },
            h("label", { class: "admin-label", for: "ev-ann-level" }, T().admAnnLevel),
            evAnnLevel,
            evAnnClear,
            evAnnCount,
          ),
        ),
      ),
      evBar,
    );
  }

  let eventBuilt = false;
  function render(): void {
    const { panel } = opts;
    if (!ev.draft) {
      eventBuilt = false;
      setChildren(
        panel,
        ev.error
          ? h(
              "section",
              { class: "panel admin-panel" },
              h("p", { class: "admin-error", role: "alert" }, T().admLoadSectionFailed(ev.error)),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => void load() }, T().admRetry),
            )
          : h("p", { class: "muted admin-loading" }, T().admLoading),
      );
      return;
    }
    if (!eventBuilt) {
      eventBuilt = true;
      buildEventPanel();
      setChildren(panel, evBodyEl);
      syncEventForm();
      return;
    }
    renderControls();
  }

  return {
    load,
    render,
    renderControls,
    renderStatus,
    applyPoll: (res) => applyResult(res, true),
    rev: () => ev.rev,
    saving: () => ev.saving,
    server: () => ev.server,
    serverNow,
    dirty,
    draft: () => ev.draft,
    discard,
    barVisible,
    clearNote: () => {
      ev.msg = null;
    },
  };
}
