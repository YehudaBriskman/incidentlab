// Home: a dashboard in the Cloudflare-console sense. Two fixed-height cards on top ("Continue" at the start edge,
// "Today's case" at the end edge; RTL mirrors them; only the Today card, full width, when Continue would just repeat
// today's case, #125), then the cases table, which scrolls inside its own panel so
// the page itself fits the viewport on desktop. Signed out, a compact intro above the cards carries the value
// statement and the sign-up and guest actions. Signed in, a challenge row sits between the cards and the table
// (views/homeChallenges.ts, #183): your classes (or a call to action, or the upgrade card for a guest) and your
// streak. Filters, search and sort live in the URL query (#/?difficulty=hard).
import "../home.css";
import type { AccountView, CaseStats, TodayResponse, UserStats } from "../../shared/contract";
import { caseSummaries, caseSummary, catalogFailed, catalogReady, reloadCatalog } from "../content/load";
import type { CaseSummary } from "../content/catalog-schema";
import { dataTable, type Column, type DataTable } from "../components/dataTable";
import type { SortState } from "../components/table-core";
import { fetchMyStats } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { cachedAccount, isAccountKnown, likelySignedIn, loadAccount, loadToday, onAccountChange } from "../lib/session";
import { cachedEvent, isEventActive, onEventChange } from "../lib/event";
import { tooltip } from "../lib/overlay";
import { filterButton, type FilterButtonHandle, type FilterValue } from "../components/filterPopover";
import { recentVisits, visitHref, type Visit } from "../lib/recent";
import {
  matchesFilters,
  parseFilters,
  serializeFilters,
  topTags,
  DIFFICULTIES,
  STATUSES,
  type CaseFilters,
  type CaseStatus,
  type Difficulty,
} from "../lib/caseFilters";
import { getLang } from "../i18n/i18n";
import { TA } from "../i18n/strings-account";
import { TC } from "../i18n/strings-challenges";
import { TG } from "../i18n/strings-game";
import { TGu } from "../i18n/strings-guest";
import { TH } from "../i18n/strings-home";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";
import { TS } from "../i18n/strings-shell";
import type { ViewResult } from "../shell/types";
import { eventDisplayPhase, eventWhen } from "./leaderboard";
import { classesCard, everySecond, guestCard, loadHomeClasses, streakCard, type ClassesState, type StreakState } from "./homeChallenges";

type HomeState = {
  /** true until /api/today and the player's stats have both answered */
  loading: boolean;
  today: TodayResponse | null;
  todayFailed: boolean;
  stats: ReadonlyMap<string, CaseStats>;
  statsFailed: boolean;
  /** an approved player whose stats we asked for: status and score columns apply */
  isPlayer: boolean;
  /** the player's full stats (streak and achievements for the challenge row); null until loaded or when failed */
  me: UserStats | null;
  /** the classes card (#183): loaded on its own, so slow class calls never hold back the table */
  classes: ClassesState;
};

type Row = { readonly c: CaseSummary; readonly stats: CaseStats | undefined; readonly isToday: boolean };

/** The shared filter button's value for the current case filters (the URL query is the source of truth). */
const filterValue = (f: CaseFilters): FilterValue => ({ difficulty: [...f.difficulty], tag: [...f.tags], status: [...f.status] });

/* ================= small helpers ================= */

/** Hebrew prefixes glued to a Latin word ("ה-commit") keep a non-breaking hyphen, so "ה-" is never orphaned. */
const keepPrefix = (text: string): string => text.replace(/([֐-׿])-(?=[A-Za-z0-9])/g, "$1‑");

/** A case title as bidi-isolated segments, so mixed-language titles keep each run in order. */
function titleNode(title: string): Child[] {
  const parts = keepPrefix(title).split(" – ");
  return parts.flatMap((part, i) => (i === 0 ? [h("bdi", {}, part)] : [" – ", h("bdi", {}, part)]));
}

const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return isoDate;
  return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function timeAgo(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  const s = Math.round((at - now) / 1000);
  if (Math.abs(s) < 60) return rtf.format(0, "minute");
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const hr = Math.round(m / 60);
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  return rtf.format(Math.round(hr / 24), "day");
}

const exactTime = (at: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

const DIFF_RANK: Readonly<Record<Difficulty, number>> = { easy: 1, medium: 2, hard: 3 };
const STATUS_RANK: Readonly<Record<CaseStatus, number>> = { "in-progress": 0, "not-started": 1, completed: 2 };

const done = (s: CaseStats | undefined): number => (s === undefined ? 0 : s.solved + s.revealed);
const statusOf = (s: CaseStats | undefined): CaseStatus => s?.status ?? "not-started";

/** A muted em dash read as "No data" (a missing value never shows as 0). */
const missing = (): HTMLElement => h("span", { class: "home-none" }, h("span", { "aria-hidden": "true" }, "—"), h("span", { class: "visually-hidden" }, TH().noData));

/** Three bars, filled up to the difficulty: a shape cue next to the word (never colour alone). */
function difficultyCell(d: Difficulty): HTMLElement {
  const rank = DIFF_RANK[d];
  return h(
    "span",
    { class: `home-diff is-${d}` },
    h("span", { class: "home-diff-bars", "aria-hidden": "true" }, [1, 2, 3].map((i) => h("span", { class: i <= rank ? "is-on" : "" }))),
    TO().difficulty(d),
  );
}

function statusLabel(st: CaseStatus): string {
  return st === "not-started" ? TS().statusNew : st === "in-progress" ? TS().statusProgress : TS().statusDone;
}

function statusChip(row: Row): HTMLElement {
  const st = statusOf(row.stats);
  if (st === "not-started") return h("span", { class: "home-status is-new" }, statusLabel(st));
  return h("span", { class: `chip home-status ${st === "completed" ? "pill-success" : ""}` }, st === "completed" ? h("span", { "aria-hidden": "true" }, "✓") : null, statusLabel(st));
}

/* ================= the "Continue" card ================= */

type Place = { readonly key: string; readonly href: string; readonly kind: string; readonly name: Child; readonly meta: Child; readonly title: string; readonly at?: number };

function inProgressPlaces(state: HomeState): Place[] {
  return [...state.stats.values()]
    .filter((s) => s.status === "in-progress")
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .flatMap((s): Place[] => {
      const c = caseSummary(s.caseId);
      if (c === undefined) return [];
      return [
        {
          key: `p:${c.id}`,
          href: `#/case/${c.id}`,
          kind: TH().inProgress,
          name: titleNode(c.title),
          meta: h("span", { class: "home-row-num" }, TH().stageCount(done(s), c.questionCount), h("span", { class: "home-row-sep" }, " · "), TG().scorePar(s.score, s.maxScore)),
          title: `${c.title} · ${TH().stagesDone(done(s), c.questionCount)} · ${TG().scorePar(s.score, s.maxScore)}`,
        },
      ];
    });
}

function visitPlace(v: Visit): Place | null {
  const c = caseSummary(v.caseId);
  if (c === undefined) return null;
  const kind = v.kind === "toolbox" ? TH().placeToolbox : v.kind === "explorer" ? TH().placeExplorer : TH().placeCase;
  const name: Child = v.kind === "explorer" && v.file !== null ? h("bdi", { class: "mono home-row-file", dir: "ltr" }, v.file) : titleNode(c.title);
  return { key: `v:${v.kind}:${v.caseId}`, href: visitHref(v), kind, name, meta: timeAgo(v.at), title: `${kind} · ${c.title}${v.file ? ` · ${v.file}` : ""} · ${exactTime(v.at)}`, at: v.at };
}

/** `el` with `text` as its tooltip (hover and keyboard focus; lib/overlay.ts). */
function withTip<E extends HTMLElement>(el: E, text: string): E {
  tooltip(el, text);
  return el;
}

function placeRow(p: Place): HTMLElement {
  return h(
    "li",
    {},
    withTip(h(
      "a",
      { class: "home-row", href: p.href },
      h("span", { class: "home-row-kind" }, p.kind),
      h("span", { class: "home-row-name" }, p.name),
      h("span", { class: "home-row-meta" }, p.meta),
      h("span", { class: "home-row-go", "aria-hidden": "true" }, "›"),
    ), p.title),
  );
}

function cardHead(id: string, title: string, aside: Child = null): HTMLElement {
  return h("header", { class: "home-card-head" }, h("h2", { id, class: "home-card-title" }, title), aside);
}

function skeletonRows(n: number): HTMLElement {
  return h("ul", { class: "home-rows", "aria-hidden": "true" }, Array.from({ length: n }, () => h("li", {}, h("span", { class: "home-row is-skeleton" }, h("span", { class: "dt-skeleton" })))));
}

/** Today's case id, once the today answer is in and the catalog knows the case. */
function todayCaseId(state: HomeState): string | null {
  const id = state.today?.caseId ?? null;
  return id !== null && caseSummary(id) !== undefined ? id : null;
}

type ContinuePlaces = {
  readonly progress: readonly Place[];
  readonly visits: readonly Place[];
  /** today's case was in the list and was left out: the Today card already resumes it (#125) */
  readonly droppedToday: boolean;
};

/**
 * The Continue card's rows: cases in progress, then recent places. Today's case (in progress, or a plain case
 * visit) is left out, because the Today card next to it resumes the same case; its Toolbox and Explorer visits stay.
 */
function continuePlaces(state: HomeState): ContinuePlaces {
  const today = todayCaseId(state);
  const all = inProgressPlaces(state);
  const progress = all.filter((p) => p.key !== `p:${today}`).slice(0, 3);
  const listed = new Set(progress.map((p) => p.key.slice(2)));
  const recent = recentVisits();
  const isTodayVisit = (v: Visit): boolean => v.kind === "case" && v.caseId === today;
  const visits = recent
    .filter((v) => !(v.kind === "case" && listed.has(v.caseId)) && !isTodayVisit(v))
    .map(visitPlace)
    .filter((p): p is Place => p !== null)
    .slice(0, Math.max(3, 6 - progress.length));
  const droppedToday = today !== null && (all.some((p) => p.key === `p:${today}`) || recent.some(isTodayVisit));
  return { progress, visits, droppedToday };
}

/**
 * One card instead of two (#125): signed in, loaded, and the only thing Continue would list is today's case.
 * The Today card then takes the whole row (at the start edge, where Continue was).
 */
function isSingleCard(state: HomeState, signedIn: boolean): boolean {
  if (!signedIn || state.loading || state.statsFailed || state.todayFailed) return false;
  const places = continuePlaces(state);
  return places.droppedToday && places.progress.length === 0 && places.visits.length === 0;
}

function continueCard(state: HomeState, signedIn: boolean): HTMLElement {
  const body = ((): Child => {
    if (signedIn && state.loading) return skeletonRows(3);
    if (!signedIn) {
      const steps = [
        [T().step1Title, T().step1Body],
        [T().step2Title, T().step2Body],
        [T().step3Title, T().step3Body],
      ] as const;
      return h(
        "ol",
        { class: "home-steps" },
        steps.map(([title, text], i) => h("li", {}, h("span", { class: "home-step-n", "aria-hidden": "true" }, String(i + 1)), h("span", {}, h("strong", {}, title), " ", h("span", { class: "muted" }, text)))),
      );
    }
    const { progress, visits } = continuePlaces(state);
    return [
      state.statsFailed ? h("p", { class: "home-card-note", role: "alert" }, TH().statsError) : null,
      progress.length > 0 ? h("ul", { class: "home-rows", "aria-label": TH().inProgress }, progress.map(placeRow)) : null,
      visits.length > 0
        ? [h("h3", { class: "home-rows-h", id: "home-recent-h" }, TH().recent), h("ul", { class: "home-rows", "aria-labelledby": "home-recent-h" }, visits.map(placeRow))]
        : progress.length === 0
          ? h("p", { class: "home-card-empty" }, TH().recentNone)
          : null,
    ];
  })();
  return h(
    "section",
    { class: "home-card home-continue", "aria-labelledby": "home-continue-h", "aria-busy": state.loading ? "true" : null },
    cardHead("home-continue-h", signedIn ? TH().continueTitle : TH().howTitle),
    h("div", { class: "home-card-body" }, body),
  );
}

/* ================= the "Today's case" card ================= */

/** "Live event · ends in 36:20", ticking every second; removes its own timer once detached. */
function eventLine(): HTMLElement {
  const text = h("span", { class: "home-event-when" });
  const name = h("bdi", { class: "home-event-name" });
  const el = h("p", { class: "home-event" }, h("span", { class: "dot", "aria-hidden": "true" }), name, text);
  const draw = (): void => {
    const event = cachedEvent();
    if (!isEventActive(event)) {
      el.hidden = true;
      return;
    }
    const phase = eventDisplayPhase();
    el.hidden = false;
    el.className = `home-event is-${phase}`;
    name.textContent = event.name.length > 0 ? event.name : phase === "before" ? TG().eventKickerBefore : phase === "over" ? TG().eventKickerOver : TG().eventKicker;
    text.textContent = phase === "over" ? "" : eventWhen();
  };
  const unsubscribe = onEventChange(draw);
  everySecond(el, draw, unsubscribe);
  return el;
}

function todayAction(c: CaseSummary, state: HomeState, signedIn: boolean): HTMLElement {
  // Signed out: the case page's gate offers sign-in and guest play (nothing is locked to an account or a time).
  if (!signedIn) return h("a", { class: "btn btn-sm", href: `#/case/${c.id}` }, TC().play);
  const st = statusOf(state.stats.get(c.id));
  const label = st === "completed" ? TO().reviewDebrief : st === "in-progress" ? TH().resume : TH().start;
  return h("a", { class: "btn btn-primary btn-sm", href: `#/case/${c.id}` }, label);
}

function todayCard(state: HomeState, signedIn: boolean, retry: () => void): HTMLElement {
  const today = state.today;
  const c = today?.caseId ? caseSummary(today.caseId) : undefined;
  const body = ((): Child => {
    if (state.loading) return [h("span", { class: "dt-skeleton home-skel-title" }), h("span", { class: "dt-skeleton" }), h("span", { class: "dt-skeleton home-skel-btn" })];
    if (state.todayFailed) return h("div", { class: "home-card-note", role: "alert" }, h("p", {}, TH().todayError), h("button", { type: "button", class: "btn btn-sm", onclick: retry }, TH().retry));
    if (c === undefined) return h("p", { class: "home-card-empty" }, TH().todayNone);
    const stats = state.stats.get(c.id);
    const st = statusOf(stats);
    return [
      h("a", { class: "home-today-title", href: `#/case/${c.id}` }, titleNode(c.title)),
      h("p", { class: "home-today-sub" }, keepPrefix(c.subtitle)),
      h(
        "p",
        { class: "home-today-meta" },
        difficultyCell(c.difficulty),
        h("span", { class: "home-row-sep" }, "·"),
        h("bdi", {}, TO().minutes(c.estMinutes)),
        h("span", { class: "home-row-sep" }, "·"),
        TO().stages(c.questionCount),
      ),
      h(
        "div",
        { class: "home-today-foot" },
        todayAction(c, state, signedIn),
        state.isPlayer && st !== "not-started"
          ? h("span", { class: "home-today-progress" }, statusChip({ c, stats, isToday: true }), h("span", { class: "home-row-num" }, TH().stageCount(done(stats), c.questionCount)))
          : null,
        eventLine(),
      ),
    ];
  })();
  return h(
    "section",
    { class: "home-card home-today", "aria-labelledby": "home-today-h", "aria-busy": state.loading ? "true" : null },
    cardHead("home-today-h", TH().todayTitle, today ? h("span", { class: "home-card-aside" }, formatDay(today.date)) : null),
    h("div", { class: "home-card-body" }, body),
  );
}



/* ================= the cases table ================= */

const SORT_OF: Readonly<Record<string, SortState | null>> = {
  "": null,
  title: { id: "case", dir: "asc" },
  easy: { id: "difficulty", dir: "asc" },
  hard: { id: "difficulty", dir: "desc" },
  short: { id: "minutes", dir: "asc" },
  score: { id: "score", dir: "desc" },
};

const sortFromParam = (param: string): SortState | null => {
  if (param in SORT_OF) return SORT_OF[param] ?? null;
  const [id, dir] = param.split(":");
  return id !== undefined && (dir === "asc" || dir === "desc") ? { id, dir } : null;
};

const sortToParam = (sort: SortState | null): string => {
  if (sort === null) return "";
  const preset = Object.entries(SORT_OF).find(([, s]) => s !== null && s.id === sort.id && s.dir === sort.dir);
  return preset ? preset[0] : `${sort.id}:${sort.dir}`;
};

function columns(isPlayer: boolean): Column<Row>[] {
  const cols: Column<Row>[] = [
    {
      id: "case",
      header: TH().colCase,
      rowHeader: true,
      className: "home-col-case",
      cell: (r) =>
        h(
          "span",
          { class: "home-case" },
          withTip(h("a", { class: "home-case-link", href: `#/case/${r.c.id}` }, titleNode(r.c.title)), r.c.subtitle),
          r.isToday ? h("span", { class: "chip pill-info home-today-chip" }, TO().todayTag) : null,
        ),
      sortValue: (r) => r.c.title.toLocaleLowerCase(),
    },
    { id: "difficulty", header: TH().colDifficulty, className: "home-col-nowrap", cell: (r) => difficultyCell(r.c.difficulty), sortValue: (r) => DIFF_RANK[r.c.difficulty] },
    { id: "minutes", header: TH().colMinutes, numeric: true, cell: (r) => h("bdi", {}, TO().minutes(r.c.estMinutes)), sortValue: (r) => r.c.estMinutes },
    {
      id: "stages",
      header: TH().colStages,
      numeric: true,
      cell: (r) => (isPlayer ? TH().stageCount(done(r.stats), r.c.questionCount) : String(r.c.questionCount)),
      sortValue: (r) => (isPlayer ? done(r.stats) / r.c.questionCount : r.c.questionCount),
      sortFirst: "desc",
    },
  ];
  if (isPlayer) {
    cols.push(
      { id: "status", header: TH().colStatus, className: "home-col-nowrap", cell: statusChip, sortValue: (r) => STATUS_RANK[statusOf(r.stats)] },
      {
        id: "score",
        header: TH().colScore,
        numeric: true,
        className: "home-col-nowrap",
        cell: (r) => (r.stats === undefined || r.stats.status === "not-started" ? missing() : h("bdi", {}, TG().scorePar(r.stats.score, r.stats.maxScore))),
        sortValue: (r) => (r.stats === undefined || r.stats.status === "not-started" ? null : r.stats.score),
        sortFirst: "desc",
      },
    );
  }
  cols.push({
    id: "tags",
    header: TH().colTags,
    optional: true,
    className: "home-col-tags",
    cell: (r) => h("span", { class: "home-tags" }, r.c.tags.slice(0, 4).map((t, i) => [i > 0 ? ", " : "", h("bdi", {}, t)])),
  });
  return cols;
}

/** Recommended order: today's case, then cases in progress (latest first), then new ones, then finished ones. */
function recommended(rows: readonly Row[]): Row[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.isToday !== b.r.isToday) return a.r.isToday ? -1 : 1;
      const sa = STATUS_RANK[statusOf(a.r.stats)];
      const sb = STATUS_RANK[statusOf(b.r.stats)];
      if (sa !== sb) return sa - sb;
      if (sa === 0) return (b.r.stats?.startedAt ?? "").localeCompare(a.r.stats?.startedAt ?? "");
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/* ================= the page ================= */

const queryOfHash = (): URLSearchParams => new URLSearchParams(window.location.hash.split("?")[1] ?? "");

/** Home as a shell view: no sidebar (the filters sit in the table's toolbar). */
export function homeView(): ViewResult {
  const main = h("div", { class: "view" });
  return { main, start: () => renderHome(main) };
}

export function renderHome(root: HTMLElement): void {
  document.title = T().homeTitle;
  const token = Symbol("home");
  activeRender = token;
  let filters: CaseFilters = parseFilters(queryOfHash());
  let state: HomeState = { loading: true, today: null, todayFailed: false, stats: new Map(), statsFailed: false, isPlayer: false, me: null, classes: { kind: "loading" } };
  /** the account the current answers were loaded for (`id:kind`): a change to another account reloads */
  let loadedFor: string | null = null;

  const intro = h("div", { class: "home-intro-slot" });
  const top = h("div", { class: "home-top" });
  const chal = h("div", { class: "home-chal" });
  const search = h("input", { type: "search", class: "input home-search", "aria-label": TH().search, placeholder: TH().searchPlaceholder, autocomplete: "off", enterkeyhint: "search", value: filters.q });
  const shown = h("p", { class: "home-shown", role: "status" });
  const sortSelect = h("select", { class: "input home-sort", "aria-label": TH().sort });
  const toolbar = h("div", { class: "home-toolbar" });
  const tableSlot = h("div", { class: "home-table-slot" });
  const cases = h(
    "section",
    { class: "home-cases", "aria-labelledby": "home-cases-h" },
    h("header", { class: "home-cases-head" }, h("h2", { id: "home-cases-h", class: "home-card-title" }, TH().casesTitle), toolbar),
    tableSlot,
  );
  const dash = h("div", { class: "home-dash" }, h("h1", { class: "visually-hidden" }, TH().pageHeading), intro, top, chal, cases);
  setChildren(root, dash);

  let table: DataTable<Row> | null = null;
  let tableFor: boolean | null = null;
  /** how many cases the toolbar and empty text were built for: they are rebuilt once the catalog arrives */
  let tableCases = -1;
  let filter: FilterButtonHandle | null = null;

  /** Still the page on screen? (A late answer must not redraw, or rewrite the URL of, the next route.) */
  const onHome = (): boolean => activeRender === token && dash.isConnected && window.location.hash.replace(/^#\/?/, "").split("?")[0] === "";

  const writeUrl = (): void => {
    if (!onHome()) return;
    const qs = serializeFilters(filters);
    const next = `#/${qs ? `?${qs}` : ""}`;
    if (window.location.hash !== next && window.location.hash !== (qs ? next : "")) history.replaceState(null, "", next);
  };

  const allRows = (): Row[] => {
    const released = state.today?.releasedCaseIds;
    return caseSummaries()
      .filter((c) => released === undefined || released.includes(c.id))
      .map((c) => {
        const stats = state.stats.get(c.id);
        const isToday = state.today?.caseId === c.id;
        return { c, stats, isToday };
      });
  };

  const syncSortSelect = (): void => {
    const param = sortToParam(table?.getSort() ?? null);
    const custom = sortSelect.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (param in SORT_OF && (param !== "score" || state.isPlayer)) {
      custom?.remove();
      sortSelect.value = param;
      return;
    }
    const sort = table?.getSort() ?? null;
    const col = columns(state.isPlayer).find((c) => c.id === sort?.id);
    const label = `${col?.header ?? ""} ${sort?.dir === "asc" ? "↑" : "↓"}`;
    if (custom) custom.textContent = label;
    else sortSelect.append(h("option", { value: "custom" }, label));
    sortSelect.value = "custom";
  };

  const applyRows = (): void => {
    if (table === null) return;
    const rows = allRows();
    const visible = recommended(rows).filter((r) => matchesFilters(r.c, state.isPlayer ? statusOf(r.stats) : null, filters));
    table.update(visible);
    shown.textContent = rows.length === 0 ? "" : TH().shown(visible.length, rows.length);
    filter?.set(filterValue(filters));
    writeUrl();
    fit();
  };

  const buildToolbar = (): void => {
    const present = new Set(caseSummaries().map((c) => c.difficulty));
    filter = filterButton({
      groups: [
        { id: "difficulty", legend: TS().filterDifficulty, type: "checkbox", options: DIFFICULTIES.filter((d) => present.has(d)).map((d) => ({ value: d, label: TO().difficulty(d) })) },
        { id: "tag", legend: TS().filterTags, type: "checkbox", options: topTags(caseSummaries()).map((t) => ({ value: t, label: t })) },
        ...(state.isPlayer ? [{ id: "status", legend: TS().filterStatus, type: "checkbox" as const, options: STATUSES.map((s) => ({ value: s, label: statusLabel(s) })) }] : []),
      ],
      value: filterValue(filters),
      onChange: (value) => {
        filters = {
          ...filters,
          difficulty: new Set((value["difficulty"] ?? []).filter((v): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v))),
          tags: new Set(value["tag"] ?? []),
          status: new Set((value["status"] ?? []).filter((v): v is CaseStatus => (STATUSES as readonly string[]).includes(v))),
        };
        applyRows();
      },
    });
    const presets: [string, string][] = [
      ["", TH().sortDefault],
      ["title", TH().sortTitle],
      ["easy", TH().sortEasy],
      ["hard", TH().sortHard],
      ["short", TH().sortShort],
      ...(state.isPlayer ? ([["score", TH().sortScore]] as [string, string][]) : []),
    ];
    setChildren(sortSelect, presets.map(([value, label]) => h("option", { value }, label)));
    setChildren(
      toolbar,
      h("span", { class: "home-search-wrap" }, search),
      filter.el,
      h("label", { class: "home-sort-wrap" }, h("span", { class: "home-sort-label" }, TH().sort), sortSelect),
      shown,
    );
  };

  const buildTable = (): DataTable<Row> => {
    if (tableFor === state.isPlayer && tableCases === caseSummaries().length && table !== null) return table;
    table?.destroy();
    tableFor = state.isPlayer;
    tableCases = caseSummaries().length;
    if (!state.isPlayer && filters.sort === "score") filters = { ...filters, sort: "" };
    if (!state.isPlayer && filters.status.size > 0) filters = { ...filters, status: new Set() };
    buildToolbar();
    table = dataTable<Row>({
      columns: columns(state.isPlayer),
      rows: [],
      caption: TA().allCases,
      labelledBy: "home-cases-h",
      regionLabel: TH().casesTitle,
      wrapClass: "home-table",
      className: "home-cases-table",
      stackOnPhone: true,
      rowKey: (r) => r.c.id,
      rowSig: (r) => JSON.stringify([r.stats, r.isToday, getLang()]),
      rowAttrs: (r) => ({ "data-case": r.c.id, class: `home-case-row${r.isToday ? " is-today" : ""}` }),
      initialSort: sortFromParam(filters.sort) ?? undefined,
      empty: h("p", {}, caseSummaries().length === 0 ? T().noCases : TS().filterNoCases),
      onSortChange: (sort) => {
        filters = { ...filters, sort: sortToParam(sort) };
        syncSortSelect();
        writeUrl();
      },
    });
    setChildren(tableSlot, table.element);
    syncSortSelect();
    return table;
  };

  sortSelect.addEventListener("change", () => {
    if (sortSelect.value === "custom") return;
    filters = { ...filters, sort: sortSelect.value };
    table?.setSort(sortFromParam(sortSelect.value));
    syncSortSelect();
    writeUrl();
  });
  search.addEventListener("input", () => {
    filters = { ...filters, q: search.value };
    applyRows();
  });

  // Row click opens the case (the title link is the keyboard path: Tab to it, Enter).
  tableSlot.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element) || t.closest("a, button, input, label") !== null) return;
    const row = t.closest<HTMLElement>("[data-case]");
    if (row?.dataset.case) window.location.hash = `#/case/${row.dataset.case}`;
  });

  const draw = (): void => {
    if (!onHome()) return;
    // Before /api/me answers, lay out for the likely state (lib/session.ts hint) so nothing shifts when it does.
    const signedIn = likelySignedIn();
    setChildren(intro, signedIn ? null : introStrip());
    const single = isSingleCard(state, signedIn);
    top.classList.toggle("is-single", single);
    if (single) setChildren(top, todayCard(state, signedIn, reload));
    else setChildren(top, continueCard(state, signedIn), todayCard(state, signedIn, reload));
    drawChallenges();
    if (state.loading) {
      // Keep rows already shown (a retry): only the first load draws skeleton rows.
      if (table === null) buildTable().setState({ kind: "loading", label: TH().loadingCases, rows: Math.min(6, Math.max(3, caseSummaries().length)) });
    } else if (catalogFailed()) {
      // The case list comes only from the content API (GET /api/cases): say so, and offer a retry.
      buildTable().setState({ kind: "error", message: T().pageFailed, retry: { label: TH().retry, run: reload } });
    } else {
      buildTable().setState({ kind: "ready" });
      applyRows();
    }
    fit();
  };

  /** The challenge row: who it is for comes from the account (a guess until /api/session answers). */
  function drawChallenges(): void {
    if (!onHome()) return;
    const mode = challengeMode(likelySignedIn(), isAccountKnown() ? cachedAccount() : undefined);
    chal.hidden = mode === "none";
    if (mode === "none") {
      setChildren(chal);
      return;
    }
    const streak: StreakState = state.loading ? { kind: "loading" } : state.me === null ? { kind: "failed" } : { kind: "ready", stats: state.me, today: state.today };
    setChildren(chal, mode === "guest" ? guestCard() : classesCard(state.classes, reloadClasses), streakCard(streak));
    fit();
  }
  function reloadClasses(): void {
    state = { ...state, classes: { kind: "loading" } };
    drawChallenges();
    loadClasses(Promise.resolve(cachedAccount()));
  }
  /** One GET /api/classes, then one detail per class shown: only for a full account (guests can't join). */
  function loadClasses(account: Promise<AccountView | null>): void {
    void account
      .then((acc) => (acc !== null && isClassPlayer(acc) ? loadHomeClasses() : null), () => null)
      .then((classes) => {
        if (!onHome() || classes === null) return;
        state = { ...state, classes };
        drawChallenges();
      });
  }

  // Fit the dashboard to the viewport on desktop: the table panel scrolls inside, the page doesn't.
  const fit = (): void => {
    if (activeRender !== token || !dash.isConnected) return;
    dash.style.maxBlockSize = "";
    if (window.matchMedia("(max-width: 640px)").matches) return;
    // Measure against the content area that scrolls (main.app-content): the room from the dashboard's top, unscrolled,
    // to the viewport's bottom, less the area's bottom padding. (The document itself only scrolls once that overflows.)
    const scroller = dash.closest<HTMLElement>("main");
    const pad = scroller === null ? 0 : Number.parseFloat(getComputedStyle(scroller).paddingBlockEnd) || 0;
    const rect = dash.getBoundingClientRect();
    const top = rect.top + (scroller?.scrollTop ?? 0) + window.scrollY;
    const avail = window.innerHeight - top - pad;
    if (rect.height <= avail) return;
    dash.style.maxBlockSize = `${Math.max(MIN_DASH_PX, Math.floor(avail))}px`;
  };
  let fitFrame = 0;
  const queueFit = (): void => {
    if (fitFrame !== 0) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = 0;
      fit();
    });
  };
  window.addEventListener("resize", queueFit);
  const navbar = document.querySelector("header.navbar");
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(queueFit) : null;
  if (navbar !== null) ro?.observe(navbar);
  const announce = document.querySelector(".announce");
  if (announce !== null) ro?.observe(announce);
  const stopWatch = window.setInterval(() => {
    if (activeRender === token && dash.isConnected) return;
    window.clearInterval(stopWatch);
    window.removeEventListener("resize", queueFit);
    ro?.disconnect();
    table?.destroy();
  }, 2000);

  function load(): void {
    const today = loadToday(true).then(
      (value): { value: TodayResponse | null; failed: boolean } => ({ value, failed: false }),
      () => ({ value: null, failed: true }),
    );
    const account = loadAccount();
    if (!isAccountKnown()) void account.then(draw, () => undefined);
    void account.then(
      (acc) => {
        loadedFor = accountKey(acc);
      },
      () => undefined,
    );
    type Loaded = { me: UserStats | null; failed: boolean; player: boolean };
    const stats = account.then(
      (acc): Promise<Loaded> | Loaded =>
        acc?.status === "approved" && acc.role !== "admin"
          ? fetchMyStats().then(
              (s): Loaded => ({ me: s, failed: false, player: true }),
              (): Loaded => ({ me: null, failed: true, player: true }),
            )
          : { me: null, failed: false, player: false },
      (): Loaded => ({ me: null, failed: false, player: false }),
    );
    loadClasses(account);
    // The case list (GET /api/cases) arrives with the other two; a failed fetch is retried by reload().
    const catalog = catalogFailed() ? reloadCatalog() : catalogReady;
    void Promise.all([today, stats, catalog]).then(([t, s]) => {
      if (!onHome()) return; // navigated away
      state = {
        loading: false,
        today: t.value,
        todayFailed: t.failed,
        stats: new Map((s.me?.cases ?? []).map((c) => [c.caseId, c])),
        statsFailed: s.failed,
        isPlayer: s.player,
        me: s.me,
        classes: state.classes,
      };
      draw();
    });
  }
  function reload(): void {
    state = { ...state, loading: true, classes: { kind: "loading" } };
    draw();
    load();
  }
  // Starting a guest session, upgrading it or signing out elsewhere changes who home is for: load again for them.
  accountChanged = (): void => {
    if (!onHome() || state.loading) return;
    if (accountKey(cachedAccount()) !== loadedFor) reload();
  };

  draw();
  load();
}

/** Below this the dashboard stops shrinking and the page scrolls instead (short laptop windows). */
const MIN_DASH_PX = 420;

/** Signed out: what this is, for whom, and one primary action. Compact, not a marketing hero. */
function introStrip(): HTMLElement {
  return h(
    "section",
    { class: "home-intro", "aria-label": TH().introLabel },
    h("div", { class: "home-intro-text" }, h("p", { class: "home-intro-title" }, TO().heroTitle), h("p", { class: "home-intro-sub" }, TO().heroSub)),
    h(
      "div",
      { class: "home-intro-actions" },
      h("a", { class: "btn btn-primary btn-sm", href: "#/signup" }, TO().ctaCreate),
      guestButton(),
      h("a", { class: "btn btn-ghost btn-sm", href: "#/login" }, TO().ctaSignIn),
    ),
  );
}

/** "Play as guest" (#176): starts a guest session; the account change then reloads home for the guest. */
function guestButton(): HTMLElement {
  const button = h("button", { type: "button", class: "btn btn-sm" }, TGu().playAsGuest);
  let busy = false;
  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    button.setAttribute("aria-disabled", "true");
    void import("./guest")
      .then((m) => m.playAsGuest())
      .finally(() => {
        busy = false;
        button.removeAttribute("aria-disabled");
      });
  });
  return button;
}

type ChallengeMode = "none" | "guest" | "player";

/** Full accounts that may be in classes (guests can't join; the site admin has no memberships). */
const isClassPlayer = (acc: AccountView): boolean => acc.kind === "user" && acc.status === "approved" && acc.role !== "admin";

/** Who the challenge row is for. `account` is undefined while /api/session hasn't answered (then: the hint). */
function challengeMode(likely: boolean, account: AccountView | null | undefined): ChallengeMode {
  if (account === undefined) return likely ? "player" : "none";
  if (account === null || account.role === "admin" || account.status !== "approved") return "none";
  return account.kind === "guest" ? "guest" : "player";
}

const accountKey = (acc: AccountView | null): string => (acc === null ? "" : `${acc.id}:${acc.kind}`);

let activeRender: symbol | null = null;
let accountChanged: (() => void) | null = null;
onAccountChange(() => accountChanged?.());
