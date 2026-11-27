// Class management (#/class/<id>/manage, #182): the manage panels of views/manage/* mounted with class-scoped
// calls (lib/class-api.ts), for the class's admins and the site admin. Sections, in the global nav under Classes:
// - Members (manage/classMembers.ts): requests, approve or decline, promote or demote, remove; the actions follow
//   the permission matrix in docs/API.md. There is no password reset and no account delete here.
// - Live (manage/live.ts) on /api/classes/:id/progress: polled at most every 15 s, only while it is the section
//   on screen and the tab is visible. Without restart or reset (site-admin actions).
// - Schedule (manage/schedule.ts) and Event (manage/event.ts): the class's case of the day and event night, saved
//   with PATCH. Cases: the assigned cases. Settings: name, join mode, join code and link, board link, archive.
// Nothing else polls. Class data is admin-authored and rendered as text only.
import "../admin.css";
import "../classes.css";
import type { ClassDetail, ClassMember, LiveEvent, Schedule, TodayResponse } from "../../shared/contract";
import { formActions, formField } from "../components/formLayout";
import { caseSummaries } from "../content/load";
import { getLang } from "../i18n/i18n";
import { TC } from "../i18n/strings-classes";
import { T } from "../i18n/strings-tools";
import { ApiError } from "../lib/api";
import type { AdminProgressResult } from "../lib/admin-api";
import {
  approveClassMember,
  archiveClass,
  classToday,
  fetchClass,
  fetchClassMembers,
  fetchClassProgress,
  joinLink,
  removeClassMember,
  restoreClass,
  rotateBoardToken,
  rotateJoinCode,
  setClassMemberRole,
  updateClass,
} from "../lib/class-api";
import { isClassAdmin, isOwnerLike, type ClassCaller } from "../lib/class-permissions";
import { copyButton, h, setChildren } from "../lib/dom";
import { loadErrorText } from "../lib/errors";
import { serverNow } from "../lib/event";
import { banner, closeMenu, toast } from "../lib/overlay";
import { cachedAccount, isGuest, loadAccount } from "../lib/session";
import { clickClosedDrawer, navSubLink, showSubNav } from "../shell/nav";
import { setPageCrumb } from "../shell/topbar";
import type { NavSection, ViewResult } from "../shell/types";
import { asLiveEvent } from "./leaderboard";
import { createClassMembersPanel } from "./manage/classMembers";
import { createEventPanel } from "./manage/event";
import { NARROW_QUERY, createManageHost } from "./manage/host";
import { createLivePanel } from "./manage/live";
import { createSchedulePanel } from "./manage/schedule";
import { headWithHint } from "./manage/ui";
import { classChips } from "./classes";

/** The live progress poll: at most every 15 s (budget: one function call per tick per open dashboard). */
const LIVE_POLL_MS = 15_000;
const SAVED_NOTE_MS = 4000;

type TabId = "members" | "live" | "schedule" | "event" | "cases" | "settings";
const TABS: readonly TabId[] = ["members", "live", "schedule", "event", "cases", "settings"];
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t === v);

const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths}</svg>`;
const ICONS: Readonly<Record<TabId, string>> = {
  members: svgIcon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  live: svgIcon('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  schedule: svgIcon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
  event: svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/>'),
  cases: svgIcon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13l2 2 4-4"/>'),
  settings: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
};

const tabLabel = (tab: TabId): string => {
  switch (tab) {
    case "members":
      return TC().secMembers;
    case "live":
      return TC().secLive;
    case "schedule":
      return TC().secSchedule;
    case "event":
      return TC().secEvent;
    case "cases":
      return TC().secCases;
    case "settings":
      return TC().secSettings;
  }
};

const manageHash = (id: string, tab: TabId): string => `#/class/${encodeURIComponent(id)}/manage?tab=${tab}`;
const readTab = (): TabId | null => {
  const tab = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab");
  return isTabId(tab) ? tab : null;
};
const isManageHash = (hash: string, id: string): boolean => hash.replace(/^#\/?/, "").split("?")[0] === `class/${encodeURIComponent(id)}/manage`;

const classSchedule = (c: ClassDetail | null): Schedule | null =>
  c?.schedule === undefined ? null : { ...c.schedule, days: { ...c.schedule.days }, lockToToday: false };
const classEvent = (c: ClassDetail | null): LiveEvent | null => (c?.event === undefined ? null : asLiveEvent(c.event));
const errText = (err: unknown): string => (err instanceof Error ? err.message : TC().unknownError);
const tabHidden = (): boolean => document.visibilityState === "hidden";

/** The dashboard the router re-attaches on Back/Forward between sections (same class, same language). */
type Instance = { id: string; lang: string; container: HTMLElement; side: HTMLElement; alive: () => boolean; reattach: () => void; dispose: () => void };
let active: Instance | null = null;

/** Tears the dashboard down when the route leaves it (the router calls this on every route change). */
export function stopClassManage(nextHash: string): void {
  if (active !== null && !isManageHash(nextHash, active.id)) active.dispose();
}

export function classManageView(id: string): ViewResult {
  const reuse = active !== null && active.alive() && active.id === id && active.lang === getLang() ? active : null;
  const main = h("div", { class: "view" });
  const side = reuse?.side ?? h("ul", { class: "nav-sub-list admin-nav" });
  const nav: NavSection = { under: "classes", label: TC().manageTitle, content: side };
  return {
    main,
    nav,
    layout: "fit",
    start: () => {
      if (reuse !== null) {
        main.replaceChildren(reuse.container);
        reuse.reattach();
        return;
      }
      active?.dispose();
      renderManage(main, side, id);
    },
  };
}

function renderManage(root: HTMLElement, side: HTMLElement, id: string): void {
  const container = h("div", { class: "admin class-manage" });
  root.replaceChildren(container);
  let disposed = false;
  let pollId: number | null = null;
  let tickId: number | null = null;
  let savedNoteTimer: number | null = null;
  const narrowMq = window.matchMedia(NARROW_QUERY);

  const state = {
    tab: readTab() ?? ("members" as TabId),
    cls: null as ClassDetail | null,
    members: null as ClassMember[] | null,
    progress: null as AdminProgressResult | null,
    liveCaseId: null as string | null,
    narrow: narrowMq.matches,
    banner: null as string | null,
    liveLoading: false,
    /** Why the last live-progress fetch failed (shown in the Live panel with Retry), or null. */
    liveError: null as string | null,
  };

  const caller = (): ClassCaller => ({ membership: state.cls?.membership ?? null, accountId: cachedAccount()?.id ?? null });

  const statusBanner = banner({ tone: "warning", text: "", dismissible: true, className: "admin-banner", onDismiss: () => void (state.banner = null) });
  statusBanner.hide();
  function renderBanner(): void {
    if (state.banner === null) return statusBanner.hide();
    statusBanner.update({ text: state.banner });
    statusBanner.show();
  }

  function handleAuthError(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    if (err.status === 401) {
      state.banner = TC().signedOut;
      renderBanner();
      return true;
    }
    if (err.status === 404) {
      showGone();
      return true;
    }
    return false;
  }

  const host = createManageHost({
    container,
    disposed: () => disposed,
    narrow: () => state.narrow,
    refresh: () => void refresh(),
    handleAuthError,
    setBanner: (text) => {
      state.banner = text;
      renderBanner();
    },
    syncSaveBar: () => syncSaveBar(),
  });
  // Errors from the class API read better in the class's own words.
  const showActionError = (err: unknown): void => {
    if (handleAuthError(err)) return;
    state.banner = TC().actionFailed(errText(err));
    renderBanner();
  };
  host.showActionError = showActionError;

  // ---- sections in the global nav -------------------------------------------------------------------------
  const tabPanels = new Map<TabId, HTMLElement>();
  const links = new Map<TabId, HTMLAnchorElement>();
  for (const tab of TABS) tabPanels.set(tab, h("section", { id: `class-panel-${tab}`, class: "admin-tabpanel", "aria-label": tabLabel(tab), tabindex: "0" }));
  const navSpec: NavSection = { under: "classes", label: TC().manageTitle, content: side };

  function buildSidebar(): void {
    side.setAttribute("aria-label", TC().sections);
    setChildren(
      side,
      TABS.map((tab) => {
        const link = navSubLink(manageHash(id, tab), { label: tabLabel(tab), icon: { svg: ICONS[tab] }, className: "admin-side-link" });
        link.addEventListener("click", (e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          const focusPanel = clickClosedDrawer();
          if (selectTab(tab) && focusPanel) tabPanels.get(tab)?.focus({ preventScroll: true });
        });
        links.set(tab, link);
        return h("li", {}, link);
      }),
    );
  }

  function syncTabs(): void {
    setPageCrumb(tabLabel(state.tab));
    for (const tab of TABS) {
      const link = links.get(tab);
      if (tab === state.tab) link?.setAttribute("aria-current", "page");
      else link?.removeAttribute("aria-current");
      const panel = tabPanels.get(tab);
      if (panel) panel.hidden = tab !== state.tab;
    }
  }

  function syncSaveBar(): void {
    const open = (state.tab === "schedule" && schedule.barVisible()) || (state.tab === "event" && eventForm.barVisible());
    document.documentElement.classList.toggle("admin-savebar-open", open);
  }

  const dirtyName = (): string => {
    if (state.tab === "schedule" && schedule.dirty()) return tabLabel("schedule");
    if (state.tab === "event" && eventForm.dirty()) return tabLabel("event");
    return "";
  };

  /** Leaving Schedule or Event with unsaved edits asks first. Returns false when the switch waits for that. */
  function selectTab(tab: TabId, fromUrl = false): boolean {
    if (tab === state.tab) return true;
    const leaving = state.tab;
    const dirty = dirtyName();
    if (dirty !== "") {
      void host
        // The same words as the admin dashboard's leave guard: the same panels hold the drafts.
        .askConfirm({ title: T().admLeaveTitle, body: T().admLeaveConfirm(dirty), confirmLabel: T().admLeaveDiscard, cancelLabel: T().admLeaveStay, tone: "danger" })
        .then((ok) => {
          if (!ok || disposed || state.tab !== leaving) return;
          if (leaving === "schedule") schedule.discard();
          else eventForm.discard();
          if (selectTab(tab)) tabPanels.get(tab)?.focus({ preventScroll: true });
        });
      return false;
    }
    state.tab = tab;
    if (!fromUrl) history.pushState(history.state, "", manageHash(id, tab));
    syncTabs();
    syncSaveBar();
    renderTab();
    void loadTab();
    return true;
  }

  // ---- header -------------------------------------------------------------------------------------------
  const titleEl = h("h1", { class: "admin-title", dir: "auto" });
  const chipsEl = h("span", { class: "class-chips" });
  const projectorLink = h("a", { class: "btn btn-sm", hidden: true }, TC().projector);
  const backLink = h("a", { class: "btn btn-ghost btn-sm", href: `#/class/${encodeURIComponent(id)}` }, TC().backToClass);

  function drawHeader(): void {
    const c = state.cls;
    if (c === null) return;
    titleEl.textContent = c.name;
    setChildren(chipsEl, classChips(c));
    projectorLink.hidden = c.boardToken === undefined || c.status !== "active";
    if (c.boardToken !== undefined) projectorLink.href = `#/classboard/${encodeURIComponent(c.boardToken)}?projector=1`;
    document.title = `${TC().manageTitle} · ${c.name} · IncidentLab`;
  }

  function buildDashboard(): void {
    setChildren(
      container,
      h(
        "header",
        { class: "admin-head" },
        h("div", { class: "admin-head-title" }, h("p", { class: "eyebrow" }, TC().manageTitle), titleEl, chipsEl),
        h("div", { class: "admin-head-actions" }, backLink, projectorLink),
      ),
      statusBanner.el,
      [...tabPanels.values()],
    );
    buildSidebar();
    showSubNav(navSpec);
    drawHeader();
    setChildren(tabPanels.get("members") ?? container, members.sections());
    live.mount(tabPanels.get("live") ?? container);
    buildCasesPanel();
    buildSettingsPanel();
    syncTabs();
  }

  function showGone(): void {
    disposeTimers();
    showSubNav(null);
    setChildren(
      container,
      h(
        "section",
        { class: "class-note", "aria-labelledby": "class-gone-title" },
        h("h1", { id: "class-gone-title", class: "class-note-title", tabindex: "-1" }, TC().notFoundTitle),
        h("p", {}, TC().notFoundBody),
        h("div", { class: "class-note-actions" }, h("a", { class: "btn", href: "#/classes" }, TC().allClasses)),
      ),
    );
  }

  // ---- members ------------------------------------------------------------------------------------------
  const members = createClassMembersPanel({
    host,
    members: { get: () => state.members, set: (list) => void (state.members = list === null ? null : [...list]) },
    api: {
      approve: (accountId) => approveClassMember(id, accountId),
      remove: (accountId) => removeClassMember(id, accountId),
      setRole: (accountId, role) => setClassMemberRole(id, accountId, role),
    },
    caller,
    memberLimit: () => state.cls?.admin?.memberLimit ?? null,
    joinMode: () => state.cls?.admin?.joinMode ?? null,
  });

  // ---- live ---------------------------------------------------------------------------------------------
  /** The cases the class plays: its assigned cases, or every published case. */
  const classCases = (): string[] => {
    const assigned = state.cls?.caseIds ?? [];
    return assigned.length > 0 ? [...assigned] : caseSummaries().map((c) => c.id);
  };
  const todayCaseId = (): string | null => classToday(state.cls?.schedule)?.caseId ?? null;
  const live = createLivePanel({
    host,
    caseId: () => state.liveCaseId,
    cases: () => ({ released: classCases(), todayId: todayCaseId() }),
    progress: () => state.progress,
    // Everyone who should be playing (#229): active members, not the class's admins.
    roster: () => state.members?.filter((m) => m.status === "active" && m.role === "member").map((m) => ({ accountId: m.accountId, username: m.username })) ?? null,
    shareUrl: () => {
      const code = state.cls?.admin?.joinCode;
      return code === undefined ? null : joinLink(code);
    },
    loadError: () => state.liveError,
    onRetry: () => void loadLive(),
    onSelectCase: (caseId) => {
      if (caseId === state.liveCaseId) return;
      state.liveCaseId = caseId;
      state.progress = null;
      state.liveError = null;
      live.render();
      void loadLive();
    },
    // No restart and no reset for a class: those are the site admin's (they touch the player's own record).
    api: {},
  });

  function ensureLiveCase(): void {
    const cases = classCases();
    if (state.liveCaseId !== null && cases.includes(state.liveCaseId)) return;
    const today = todayCaseId();
    state.liveCaseId = today !== null && cases.includes(today) ? today : (cases[0] ?? null);
  }

  /** Fetches live progress now, then again in 15 s while Live is on screen and the tab is visible. */
  async function loadLive(): Promise<void> {
    if (pollId !== null) window.clearTimeout(pollId);
    pollId = null;
    if (disposed || state.tab !== "live" || tabHidden()) return;
    ensureLiveCase();
    const caseId = state.liveCaseId;
    if (caseId === null) return live.render();
    if (state.liveLoading) return;
    state.liveLoading = true;
    try {
      // The roster once per visit (the Members tab refreshes it), so Live can count who hasn't started (#229).
      if (state.members === null) state.members = await fetchClassMembers(id).catch((): null => null);
      const progress = await fetchClassProgress(id, caseId);
      if (disposed) return;
      if (progress.caseId === state.liveCaseId) state.progress = progress;
      state.liveError = null;
      state.banner = null;
      renderBanner();
      if (state.tab === "live") live.render();
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      // Scoped to the Live panel (with Retry), never left as its empty "no cases" state.
      state.liveError = loadErrorText(err);
      if (state.tab === "live") live.render();
    } finally {
      state.liveLoading = false;
      if (!disposed && state.tab === "live" && !tabHidden()) pollId = window.setTimeout(() => void loadLive(), LIVE_POLL_MS);
    }
  }

  // ---- schedule and event (the admin panels, on PATCH) ------------------------------------------------
  function todayView(): TodayResponse | null {
    const c = state.cls;
    const today = classToday(c?.schedule);
    if (c?.schedule === undefined || today === null) return null;
    return { date: today.date, timezone: c.schedule.timezone, caseId: today.caseId, lockToToday: false, releasedCaseIds: caseSummaries().map((s) => s.id) };
  }

  function clearSavedNoteLater(): void {
    if (savedNoteTimer !== null) window.clearTimeout(savedNoteTimer);
    savedNoteTimer = window.setTimeout(() => {
      savedNoteTimer = null;
      if (disposed) return;
      schedule.clearNote();
      eventForm.clearNote();
      if (state.tab === "schedule") host.withFocusKept(schedule.render);
      if (state.tab === "event") eventForm.renderControls();
    }, SAVED_NOTE_MS);
  }

  const schedule = createSchedulePanel({
    host,
    panel: tabPanels.get("schedule") ?? container,
    api: {
      load: async () => {
        state.cls = await fetchClass(id);
        const s = classSchedule(state.cls);
        if (s === null) throw new Error(TC().notAdmin);
        return s;
      },
      save: async (s) => {
        state.cls = await updateClass(id, { schedule: { timezone: s.timezone, defaultCaseId: s.defaultCaseId, days: s.days } });
        drawHeader();
        return classSchedule(state.cls) ?? s;
      },
    },
    today: todayView,
    isActive: () => state.tab === "schedule",
    onSaved: () => clearSavedNoteLater(),
  });

  const eventForm = createEventPanel({
    host,
    panel: tabPanels.get("event") ?? container,
    api: {
      load: async () => {
        state.cls = await fetchClass(id);
        const ev = classEvent(state.cls);
        if (ev === null) throw new Error(TC().notAdmin);
        return { event: ev, serverTime: new Date(serverNow()).toISOString() };
      },
      save: async (ev) => {
        state.cls = await updateClass(id, { event: { name: ev.name, startsAt: ev.startsAt, endsAt: ev.endsAt, freezeAt: ev.freezeAt, announcement: ev.announcement } });
        return { event: classEvent(state.cls) ?? ev, serverTime: new Date(serverNow()).toISOString() };
      },
    },
    isActive: () => state.tab === "event",
    onSaved: () => clearSavedNoteLater(),
    audience: "class",
  });

  // ---- assigned cases -----------------------------------------------------------------------------------
  const casesForm = h("form", { class: "class-cases-form", novalidate: true });
  const casesCountEl = h("p", { class: "muted small", "aria-live": "polite" });
  const casesMsgEl = h("p", { class: "small", role: "status" });
  let casesDraft: Set<string> | null = null;

  function buildCasesPanel(): void {
    setChildren(
      tabPanels.get("cases") ?? container,
      h(
        "section",
        { class: "panel admin-panel", "aria-labelledby": "class-cases-title" },
        headWithHint(h("h2", { class: "admin-h2", id: "class-cases-title" }, TC().casesTitle), TC().casesHint),
        h("p", { class: "muted small admin-hint is-touch-only" }, TC().casesHint),
        casesForm,
      ),
    );
  }

  function renderCases(): void {
    const c = state.cls;
    if (c === null) return;
    const saved = new Set(c.caseIds ?? []);
    if (casesDraft === null) casesDraft = new Set(saved);
    const draft = casesDraft;
    const all = caseSummaries();
    const boxes = all.map((s) => {
      const box = h("input", { type: "checkbox", id: `class-case-${s.id}`, value: s.id, checked: draft.has(s.id) });
      box.addEventListener("change", () => {
        if (box.checked) draft.add(s.id);
        else draft.delete(s.id);
        casesMsgEl.textContent = "";
        drawCount();
      });
      return h("label", { class: "check class-case-option", for: `class-case-${s.id}` }, box, h("span", { dir: "auto" }, s.title));
    });
    const drawCount = (): void => {
      casesCountEl.textContent = draft.size === 0 ? TC().anyCase : TC().selectedCount(draft.size, all.length);
    };
    drawCount();
    const save = h("button", { type: "submit", class: "btn btn-primary btn-sm" }, TC().save);
    const clear = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, TC().clearAll);
    clear.addEventListener("click", () => {
      draft.clear();
      for (const b of casesForm.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) b.checked = false;
      drawCount();
    });
    casesForm.onsubmit = (ev) => {
      ev.preventDefault();
      save.setAttribute("aria-disabled", "true");
      save.textContent = TC().saving;
      const ids = all.map((s) => s.id).filter((cid) => draft.has(cid));
      updateClass(id, { caseIds: ids })
        .then((next) => {
          state.cls = next;
          casesDraft = null;
          casesMsgEl.textContent = TC().saved;
          renderCases();
        })
        .catch((err: unknown) => {
          if (handleAuthError(err)) return;
          casesMsgEl.textContent = TC().saveFailed(errText(err));
          save.removeAttribute("aria-disabled");
          save.textContent = TC().save;
        });
    };
    setChildren(
      casesForm,
      h("fieldset", { class: "class-case-set" }, h("legend", { class: "admin-label" }, TC().casesLegend), h("div", { class: "class-case-grid" }, boxes)),
      casesCountEl,
      formActions(save, clear),
      casesMsgEl,
    );
  }

  // ---- settings -----------------------------------------------------------------------------------------
  const settingsEl = h("div", { class: "class-settings" });
  function buildSettingsPanel(): void {
    setChildren(tabPanels.get("settings") ?? container, settingsEl);
  }

  /** A settings call: the class comes back, the header and the section redraw, a toast says it worked. */
  async function settingsCall(call: () => Promise<ClassDetail>, done: string): Promise<void> {
    try {
      state.cls = await call();
      drawHeader();
      renderSettings();
      toast({ tone: "success", text: done });
    } catch (err: unknown) {
      showActionError(err);
    }
  }

  function settingsSection(titleId: string, title: string, hint: string | null, ...body: Node[]): HTMLElement {
    return h(
      "section",
      { class: "panel admin-panel", "aria-labelledby": titleId },
      hint === null ? h("h2", { class: "admin-h2", id: titleId }, title) : headWithHint(h("h2", { class: "admin-h2", id: titleId }, title), hint),
      hint === null ? null : h("p", { class: "muted small admin-hint is-touch-only" }, hint),
      ...body,
    );
  }

  function renderSettings(): void {
    const c = state.cls;
    const a = c?.admin;
    if (c === null || a === undefined) return;
    const archived = c.status === "archived";
    const owner = isOwnerLike(caller());

    // name
    const nameField = formField({ label: TC().nameLabel, help: TC().nameHelp, input: h("input", { id: "class-rename", class: "admin-input", type: "text", maxlength: "60", value: c.name, dir: "auto", disabled: archived }) });
    const renameBtn = h("button", { type: "submit", class: "btn btn-sm", disabled: archived }, TC().rename);
    const nameForm = h("form", { class: "class-inline-form", novalidate: true }, nameField.nodes, formActions(renameBtn));
    nameForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const value = nameField.input.value.trim();
      if (value === "" || value.length > 60) {
        nameField.setError(value === "" ? TC().nameRequired : TC().nameTooLong);
        nameField.input.focus();
        return;
      }
      nameField.setError(null);
      if (value === c.name) return;
      void settingsCall(() => updateClass(id, { name: value }), TC().renamed).then(() => syncTabs());
    });

    // join mode
    const modeRadios = (["code", "approval"] as const).map((mode) => {
      const input = h("input", { type: "radio", name: "class-join-mode", id: `class-mode-${mode}`, value: mode, checked: a.joinMode === mode, disabled: archived });
      input.addEventListener("change", () => {
        if (input.checked && mode !== state.cls?.admin?.joinMode) void settingsCall(() => updateClass(id, { joinMode: mode }), TC().modeSaved);
      });
      return h("label", { class: "check", for: `class-mode-${mode}` }, input, h("span", {}, mode === "code" ? TC().modeCode : TC().modeApproval));
    });

    // join code and link
    const link = joinLink(a.joinCode);
    const rotateCodeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: archived }, TC().rotateCode);
    rotateCodeBtn.addEventListener("click", () => {
      void host
        .askConfirm({ title: TC().rotateCodeTitle, body: TC().rotateCodeBody, confirmLabel: TC().rotateCodeConfirm, tone: "primary", returnFocus: () => settingsEl.querySelector<HTMLElement>("#class-code-value") })
        .then((ok) => {
          if (ok) void settingsCall(() => rotateJoinCode(id), TC().codeRotated);
        });
    });

    // board link
    const boardUrl = c.boardToken === undefined ? "" : `${location.origin}${location.pathname}#/classboard/${encodeURIComponent(c.boardToken)}`;
    const rotateBoardBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: archived }, TC().rotateBoard);
    rotateBoardBtn.addEventListener("click", () => {
      void host
        .askConfirm({ title: TC().rotateBoardTitle, body: TC().rotateBoardBody, confirmLabel: TC().rotateBoardConfirm, tone: "danger", returnFocus: () => settingsEl.querySelector<HTMLElement>("#class-board-url") })
        .then((ok) => {
          if (ok) void settingsCall(() => rotateBoardToken(id), TC().boardRotated);
        });
    });

    // archive / restore (owner and site admin only)
    const archiveBtn = h("button", { type: "button", class: archived ? "btn btn-sm" : "btn btn-danger btn-sm" }, archived ? TC().restore : TC().archive);
    archiveBtn.addEventListener("click", () => {
      if (archived) {
        void settingsCall(() => restoreClass(id), TC().restoredToast(c.name));
        return;
      }
      void host
        .askConfirm({
          title: TC().archiveConfirmTitle(c.name),
          body: TC().archiveConfirmBody,
          confirmLabel: TC().archive,
          busyLabel: TC().archiving,
          tone: "danger",
          run: async () => {
            state.cls = await archiveClass(id);
          },
          returnFocus: () => settingsEl.querySelector<HTMLElement>("#class-archive-title"),
        })
        .then((ok) => {
          if (!ok) return;
          drawHeader();
          renderSettings();
          toast({ tone: "success", text: TC().archivedToast(c.name) });
        });
    });

    setChildren(
      settingsEl,
      archived ? h("p", { class: "class-archived-note", role: "note" }, TC().archivedNote) : null,
      settingsSection("class-name-title", TC().nameTitle, null, nameForm),
      settingsSection(
        "class-mode-title",
        TC().joinModeTitle,
        TC().limitNote(a.memberLimit),
        h("fieldset", { class: "class-mode-set", "aria-labelledby": "class-mode-title" }, modeRadios),
      ),
      settingsSection(
        "class-code-title",
        TC().codeTitle,
        TC().codeHelp,
        h(
          "div",
          { class: "class-share" },
          h("code", { class: "admin-share-url class-code-value", id: "class-code-value", tabindex: "0", dir: "ltr" }, a.joinCode),
          copyButton(() => a.joinCode, TC().copyCode),
        ),
        h("div", { class: "class-share" }, h("code", { class: "admin-share-url", dir: "ltr" }, link), copyButton(() => link, TC().copyLink)),
        h("div", { class: "admin-reset" }, rotateCodeBtn),
      ),
      c.boardToken === undefined
        ? h("span")
        : settingsSection(
            "class-board-title",
            TC().boardLinkTitle,
            TC().boardLinkHelp,
            h("div", { class: "class-share" }, h("code", { class: "admin-share-url", id: "class-board-url", tabindex: "0", dir: "ltr" }, boardUrl), copyButton(() => boardUrl, TC().copyBoardLink)),
            h("div", { class: "admin-reset" }, h("a", { class: "btn btn-sm", href: `#/classboard/${encodeURIComponent(c.boardToken)}?projector=1` }, TC().openProjector), rotateBoardBtn),
          ),
      owner
        ? settingsSection("class-archive-title", TC().archiveTitle, archived ? TC().restoreHelp : TC().archiveHelp, h("div", { class: "admin-reset" }, archiveBtn))
        : h("p", { class: "muted small" }, TC().ownerOnly),
    );
  }

  // ---- loading ------------------------------------------------------------------------------------------
  function renderTab(): void {
    switch (state.tab) {
      case "members":
        members.render();
        break;
      case "live":
        live.render();
        break;
      case "schedule":
        schedule.render();
        break;
      case "event":
        eventForm.render();
        break;
      case "cases":
        renderCases();
        break;
      case "settings":
        renderSettings();
        break;
    }
  }

  /** The data the section on screen needs: members, live progress, or the class itself. */
  async function loadTab(): Promise<void> {
    if (disposed) return;
    if (pollId !== null) window.clearTimeout(pollId);
    pollId = null;
    switch (state.tab) {
      case "members":
        try {
          state.members = await fetchClassMembers(id);
          if (!disposed && state.tab === "members") members.render();
        } catch (err: unknown) {
          showActionError(err);
        }
        return;
      case "live":
        return loadLive();
      case "schedule":
        if (!schedule.draft()) return schedule.load();
        return;
      case "event":
        if (!eventForm.draft()) return eventForm.load();
        return;
      case "cases":
      case "settings":
        renderTab();
        return;
    }
  }

  async function refresh(): Promise<void> {
    try {
      state.cls = await fetchClass(id);
      if (disposed) return;
      drawHeader();
      await loadTab();
    } catch (err: unknown) {
      showActionError(err);
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------
  function onVisibility(): void {
    if (document.visibilityState === "hidden") {
      if (pollId !== null) window.clearTimeout(pollId);
      pollId = null;
    } else if (state.tab === "live") void loadLive();
  }
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (schedule.dirty() || eventForm.dirty()) e.preventDefault();
  }
  function onNarrowChange(): void {
    state.narrow = narrowMq.matches;
    closeMenu();
    renderTab();
  }
  function disposeTimers(): void {
    if (pollId !== null) window.clearTimeout(pollId);
    if (tickId !== null) window.clearInterval(tickId);
    if (savedNoteTimer !== null) window.clearTimeout(savedNoteTimer);
    pollId = null;
    tickId = null;
    savedNoteTimer = null;
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disposeTimers();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", onBeforeUnload);
    narrowMq.removeEventListener("change", onNarrowChange);
    document.documentElement.classList.remove("admin-savebar-open");
    if (active?.container === container) active = null;
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", onBeforeUnload);
  narrowMq.addEventListener("change", onNarrowChange);

  active = {
    id,
    lang: getLang(),
    container,
    side,
    alive: () => !disposed,
    dispose,
    reattach: () => {
      showSubNav(state.cls === null ? null : navSpec);
      const tab = readTab() ?? "members";
      if (tab !== state.tab && !selectTab(tab, true)) history.replaceState(history.state, "", manageHash(id, state.tab));
      syncTabs();
    },
  };

  void start();

  async function start(): Promise<void> {
    setChildren(container, h("p", { class: "muted" }, TC().loading));
    try {
      const account = await loadAccount();
      if (account === null || isGuest(account)) {
        showSubNav(null);
        setChildren(
          container,
          h(
            "section",
            { class: "class-note", "aria-labelledby": "class-manage-note" },
            h("h1", { id: "class-manage-note", class: "class-note-title", tabindex: "-1" }, account === null ? TC().signedOutTitle : TC().guestTitle),
            h("div", { class: "class-note-actions" }, h("a", { class: "btn btn-primary", href: "#/login" }, TC().signIn)),
          ),
        );
        return;
      }
      state.cls = await fetchClass(id);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) return showGone();
      setChildren(container, h("p", { class: "class-note", role: "alert" }, TC().loadFailed, " ", errText(err)));
      return;
    }
    if (disposed) return;
    if (!isClassAdmin(caller()) || state.cls.admin === undefined) {
      showSubNav(null);
      setChildren(
        container,
        h(
          "section",
          { class: "class-note", "aria-labelledby": "class-manage-note" },
          h("h1", { id: "class-manage-note", class: "class-note-title", tabindex: "-1" }, TC().notAdmin),
          h("div", { class: "class-note-actions" }, h("a", { class: "btn", href: `#/class/${encodeURIComponent(id)}` }, TC().backToClass)),
        ),
      );
      return;
    }
    buildDashboard();
    history.replaceState(history.state, "", manageHash(id, state.tab));
    renderTab();
    void loadTab();
    tickId = window.setInterval(() => {
      if (!container.isConnected) return;
      if (state.tab === "event") eventForm.renderStatus();
    }, 1000);
  }
}
