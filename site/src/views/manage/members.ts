// The members panel: KPI tiles, the sign-ups waiting for approval (manage/pending.ts) and the members table
// with search, kind, role and status filters, sort, paging, column picker, per-case detail rows, CSV export and a
// per-row actions menu (approve, ban or unban, author role, class limit, password reset, delete). Phone and tablet
// widths get cards.
// Server-driven since #185: search, filters, sort and the page are a query the dashboard sends to
// /api/admin/users (on demand, never on a timer), and the page comes back in through a Slot. Header clicks on
// other columns sort the rows of the page on screen. Every write goes through `api`.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import type { AccountKind, AccountRecordRole, AccountStatus, AdminUsersResponse, UserStats } from "../../../shared/contract";
import { ADMIN_USERS_PAGE, CLASS_DEFAULTS } from "../../../shared/contract";
import { dataTable, type Column } from "../../components/dataTable";
import { statGrid } from "../../components/statGrid";
import type { SortState } from "../../components/table-core";
import { copyButton, h, setChildren } from "../../lib/dom";
import { listText } from "../../lib/bidi";
import { errMessage, fmtInt, formatDateTime, formatPct, ms, relativeAgo } from "./format";
import { NARROW_QUERY, setTilesSummary, syncSortSelect, type ManageHost, type Slot } from "./host";
import { acctExtras, caseStatsList, caseStatsTable, kindPill, rolePill, statusPill } from "./memberDetails";
import { createMemberActions, type MemberActionsApi } from "./memberActions";
import { createPendingPanel, type PendingApi } from "./pending";
import { headWithHint, tile, tipped } from "./ui";

const ACCT_COLS_STORAGE = "il.adminAcctCols";

type AcctSortKey = "rank" | "newest" | "seen" | "name";
const isSortKey = (v: string): v is AcctSortKey => v === "rank" || v === "newest" || v === "seen" || v === "name";
/** How long a typed search waits before it asks the server (one request per pause, not per key). */
const SEARCH_DEBOUNCE_MS = 300;

/** What the users list shows: sent to the server as /api/admin/users query parameters. */
export type MembersQuery = {
  q: string;
  status: AccountStatus | null;
  kind: AccountKind | null;
  role: AccountRecordRole | null;
  sort: AcctSortKey;
  offset: number;
  limit: number;
};

export type MembersApi = PendingApi &
  MemberActionsApi & {
    /** The full per-account export as a CSV file. */
    exportCsv(): Promise<{ blob: Blob; filename: string }>;
  };

export type MembersOptions = {
  host: ManageHost;
  /** The page on screen (null before the first load). The dashboard fetches it; actions update it in place. */
  page: Slot<AdminUsersResponse | null>;
  /** Fetch this query now (a search, filter, sort or page change). */
  fetch(query: MembersQuery): void;
  api: MembersApi;
  /** After a confirmed delete: the admin dashboard offers Undo from its trash. */
  onDeleted?: (account: UserStats) => Promise<void>;
  /** The number of pending sign-ups changed (the admin sidebar badge). */
  onPendingCount?: (n: number) => void;
  /** Re-renders the dashboard section after an action (defaults to this panel's render). */
  rerender?: () => void;
};

export type MembersPanel = {
  /** The tiles, Waiting for approval and the members table, in page order (sections built on each call). */
  sections(): HTMLElement[];
  /** Tiles, pending list and table from the current account list. */
  render(): void;
  /** Only the pending list (and its badge): kept current while another section is on screen. */
  renderPending(): void;
  /** The query on screen (the dashboard's refresh fetches it again). */
  query(): MembersQuery;
};

export function createMembersPanel(opts: MembersOptions): MembersPanel {
  const { host } = opts;
  const rerender = (): void => (opts.rerender ?? render)();
  const query: MembersQuery = { q: "", status: null, kind: null, role: null, sort: "rank", offset: 0, limit: ADMIN_USERS_PAGE.DEFAULT_LIMIT };
  let searchTimer: number | null = null;
  /** A new query from the first page (a search, filter or sort change). */
  const requery = (): void => {
    query.offset = 0;
    opts.fetch({ ...query });
  };
  // The page's rows and the pending sign-ups as the slots the row actions and the pending list work on.
  const accountsSlot: Slot<readonly UserStats[] | null> = {
    get: () => opts.page.get()?.accounts ?? null,
    set: (list) => {
      const page = opts.page.get();
      if (page && list) opts.page.set({ ...page, accounts: [...list] });
    },
  };
  const pendingSlot: Slot<readonly UserStats[] | null> = {
    get: () => opts.page.get()?.pending ?? null,
    set: (list) => {
      const page = opts.page.get();
      if (page && list) opts.page.set({ ...page, pending: list.filter((a) => a.status === "pending") });
    },
  };
  /** members whose per-case detail row is open */
  const expandedIds = new Set<string>();
  /** in-flight row actions, keyed "status:<accountId>" (shared with the pending list) */
  const busy = new Set<string>();
  let exporting = false;

  const acctTilesEl = statGrid([], "admin-tiles");
  acctTilesEl.id = "admin-acct-tiles";
  const acctTiles = host.foldableTiles(acctTilesEl);

  const acctCountEl = h("span", { class: "muted small" });
  const acctTableEl = h("div", { class: "admin-table-wrap" });

  const acctSearchInput = h("input", {
    type: "search",
    class: "admin-input admin-search",
    enterkeyhint: "search",
    placeholder: T().admUserSearchPlaceholder,
    "aria-label": T().admUserSearchLabel,
    maxlength: 64,
  });
  acctSearchInput.addEventListener("input", () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      if (host.disposed() || acctSearchInput.value.trim() === query.q) return;
      query.q = acctSearchInput.value.trim();
      requery();
    }, SEARCH_DEBOUNCE_MS);
  });
  // Enter searches at once (no wait for the pause).
  acctSearchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = null;
    query.q = acctSearchInput.value.trim();
    requery();
  });
  const acctFilterSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admFilterStatusLabel },
    h("option", { value: "all" }, T().admFilterAll),
    h("option", { value: "pending" }, T().admAcctStatus("pending")),
    h("option", { value: "approved" }, T().admAcctStatus("approved")),
    h("option", { value: "rejected" }, T().admAcctStatus("rejected")),
  );
  acctFilterSelect.addEventListener("change", () => {
    const v = acctFilterSelect.value;
    query.status = v === "pending" || v === "approved" || v === "rejected" ? v : null;
    requery();
  });
  const kindSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admFilterKindLabel },
    h("option", { value: "all" }, T().admFilterKindAll),
    h("option", { value: "user" }, T().admKindOption("user")),
    h("option", { value: "guest" }, T().admKindOption("guest")),
  );
  kindSelect.addEventListener("change", () => {
    const v = kindSelect.value;
    query.kind = v === "user" || v === "guest" ? v : null;
    requery();
  });
  const roleSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admFilterRoleLabel },
    h("option", { value: "all" }, T().admFilterRoleAll),
    h("option", { value: "player" }, T().admRoleOption("player")),
    h("option", { value: "author" }, T().admRoleOption("author")),
  );
  roleSelect.addEventListener("change", () => {
    const v = roleSelect.value;
    query.role = v === "player" || v === "author" ? v : null;
    requery();
  });

  // Paging: the range on screen and Previous / Next (the server pages; the table virtualizes the page).
  const pageRangeEl = h("span", { class: "muted small acct-page-range", "aria-live": "polite" });
  const prevBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admPagePrev);
  const nextBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admPageNext);
  prevBtn.addEventListener("click", () => {
    query.offset = Math.max(0, query.offset - query.limit);
    opts.fetch({ ...query });
  });
  nextBtn.addEventListener("click", () => {
    query.offset += query.limit;
    opts.fetch({ ...query });
  });
  const pagerEl = h("nav", { class: "acct-pager", "aria-label": T().admPagerLabel }, pageRangeEl, h("span", { class: "acct-pager-buttons" }, prevBtn, nextBtn));
  const acctSortSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admSortLabel },
    h("option", { value: "rank" }, T().admSortRank),
    h("option", { value: "newest" }, T().admSortNewest),
    h("option", { value: "seen" }, T().admSortSeen),
    h("option", { value: "name" }, T().admSortName),
    h("option", { value: "custom", hidden: true, disabled: true }, T().admSortCustom),
  );
  acctSortSelect.addEventListener("change", () => {
    const v = acctSortSelect.value;
    if (isSortKey(v)) {
      acctTable.setSort(ACCT_SORTS[v]);
      if (v !== query.sort) {
        query.sort = v;
        requery();
      }
    }
  });

  // The accounts table (components/dataTable.ts): User and Status lead, the actions menu ends the row, and the
  // rest come from the column picker (remembered). Headers sort; the Sort select drives the same sort, and on
  // phones and tablets (cards, no headers) it is the only way to sort. Rows are keyed, so focus survives polling.
  let acctNow = Date.now();
  const acctColumns: Column<UserStats>[] = [
    {
      id: "name",
      header: T().admColUser,
      rowHeader: true,
      className: "col-name",
      cell: (a) => acctToggle(a, `acct-detail-${a.accountId}`),
      sortValue: (a) => a.username,
      csv: (a) => a.username,
    },
    { id: "status", header: T().admColStatus, cell: (a) => [statusPill(a.status), kindPill(a), rolePill(a)], sortValue: (a) => a.status, csv: (a) => `${a.status} ${a.kind}` },
    {
      id: "score",
      header: T().admColScore,
      numeric: true,
      hideable: true,
      className: "col-score",
      cell: (a) => fmtInt(a.totalScore),
      sortValue: (a) => a.totalScore,
      sortFirst: "desc",
      csv: (a) => a.totalScore,
    },
    { id: "rank", header: T().admColRank, numeric: true, hideable: true, cell: (a) => (a.rank === null ? "—" : fmtInt(a.rank)), sortValue: (a) => a.rank, csv: (a) => a.rank },
    {
      id: "completed",
      header: T().admColCompleted,
      numeric: true,
      hideable: true,
      cell: (a) => h("span", { title: T().admStartedCount(a.casesStarted) }, T().admOfN(fmtInt(a.casesCompleted), fmtInt(a.casesStarted))),
      sortValue: (a) => a.casesCompleted,
      sortFirst: "desc",
      csv: (a) => a.casesCompleted,
    },
    { id: "accuracy", header: T().admColAccuracy, numeric: true, hideable: true, cell: (a) => formatPct(a.accuracy), sortValue: (a) => a.accuracy, sortFirst: "desc", csv: (a) => a.accuracy },
    {
      id: "seen",
      header: T().admColSeen,
      hideable: true,
      className: "col-seen muted",
      cell: (a) => tipped(h("span", {}, relativeAgo(a.lastSeenAt, acctNow)), formatDateTime(a.lastSeenAt)),
      sortValue: (a) => ms(a.lastSeenAt),
      sortFirst: "desc",
      csv: (a) => a.lastSeenAt,
    },
    {
      id: "created",
      header: T().admColCreated,
      hideable: true,
      defaultHidden: true,
      className: "col-seen muted",
      cell: (a) => formatDateTime(a.createdAt),
      sortValue: (a) => ms(a.createdAt),
      sortFirst: "desc",
      csv: (a) => a.createdAt,
    },
    { id: "hints", header: T().admColHints, numeric: true, hideable: true, defaultHidden: true, cell: (a) => fmtInt(a.hintsUsed), sortValue: (a) => a.hintsUsed, sortFirst: "desc", csv: (a) => a.hintsUsed },
    { id: "wrong", header: T().admColWrong, numeric: true, hideable: true, defaultHidden: true, cell: (a) => fmtInt(a.wrongAttempts), sortValue: (a) => a.wrongAttempts, sortFirst: "desc", csv: (a) => a.wrongAttempts },
    {
      id: "commands",
      header: T().admColCommands,
      numeric: true,
      hideable: true,
      defaultHidden: true,
      cell: (a) => fmtInt(a.commandsRevealed),
      sortValue: (a) => a.commandsRevealed,
      sortFirst: "desc",
      csv: (a) => a.commandsRevealed,
    },
    {
      id: "badges",
      header: T().admColBadges,
      numeric: true,
      hideable: true,
      defaultHidden: true,
      cell: (a) => h("span", { title: T().admBadgesTip(listText(a.achievements.map((x) => T().admAchievement(x.id)))) }, fmtInt(a.achievements.length)),
      sortValue: (a) => a.achievements.length,
      sortFirst: "desc",
      csv: (a) => a.achievements.length,
    },
    {
      id: "streak",
      header: T().admColStreak,
      numeric: true,
      hideable: true,
      defaultHidden: true,
      cell: (a) => h("span", { title: T().admStreakTip(a.streak.current, a.streak.best) }, T().admOfN(fmtInt(a.streak.current), fmtInt(a.streak.best))),
      sortValue: (a) => a.streak.current,
      sortFirst: "desc",
      csv: (a) => a.streak.current,
    },
    {
      id: "classLimit",
      header: T().admColClassLimit,
      numeric: true,
      hideable: true,
      defaultHidden: true,
      cell: (a) => (a.kind === "guest" ? "—" : a.classLimit === null ? h("span", { class: "muted" }, T().admClassLimitDefault(fmtInt(CLASS_DEFAULTS.OWNED_LIMIT))) : fmtInt(a.classLimit)),
      sortValue: (a) => a.classLimit ?? CLASS_DEFAULTS.OWNED_LIMIT,
      csv: (a) => a.classLimit,
    },
    { id: "actions", header: T().admColActions, headerHidden: true, className: "col-actions", cell: (a) => acctMenu(a) },
  ];

  /** The Sort select's choices as table sorts (the select stays: cards have no headers to click). */
  const ACCT_SORTS: Record<AcctSortKey, SortState> = {
    rank: { id: "rank", dir: "asc" },
    newest: { id: "created", dir: "desc" },
    seen: { id: "seen", dir: "desc" },
    name: { id: "name", dir: "asc" },
  };
  const acctTable = dataTable<UserStats>({
    columns: acctColumns,
    rows: [],
    rowKey: (a) => a.accountId,
    rowSig: (a) => acctSignature(a, acctNow),
    rowAttrs: (a) => ({ class: `acct-row is-${a.status}${expandedIds.has(a.accountId) ? " is-expanded" : ""}`, "data-id": a.accountId }),
    detail: (a) =>
      expandedIds.has(a.accountId)
        ? {
            attrs: { class: "acct-detail", id: `acct-detail-${a.accountId}` },
            content: h(
              "div",
              { class: "acct-detail-inner" },
              h("p", { class: "admin-label" }, T().admPerCaseTitle(a.username)),
              caseStatsTable(a.cases),
              h("p", { class: "muted small acct-detail-meta" }, acctExtras(a)),
            ),
          }
        : null,
    labelledBy: "admin-accounts-title",
    className: "admin-table acct-table",
    wrapClass: "admin-dt",
    initialSort: ACCT_SORTS[query.sort],
    columnPicker: {
      label: T().admColumns,
      legend: T().admColumnsLegend,
      resetLabel: T().admColumnsReset,
      storageKey: ACCT_COLS_STORAGE,
      countLabel: T().admColumnsCount,
    },
    virtualize: { rowHeight: 56 },
    cards: { query: NARROW_QUERY, build: (a) => buildAcctCard(a, acctNow), className: "acct-cards", labelledBy: "admin-accounts-title" },
    onSortChange: (s) => {
      syncSortSelect(acctSortSelect, ACCT_SORTS, s);
      // A header that matches a server sort sorts the whole list, not just this page.
      const key = (Object.keys(ACCT_SORTS) as AcctSortKey[]).find((k) => s !== null && ACCT_SORTS[k].id === s.id && ACCT_SORTS[k].dir === s.dir);
      if (key !== undefined && key !== query.sort) {
        query.sort = key;
        requery();
      }
    },
  });

  // Waiting for approval (manage/pending.ts): shares the busy set and the status action with the table.
  const pending = createPendingPanel({
    host,
    accounts: pendingSlot,
    busy,
    changeStatus: (account, action) => changeStatus(account, action),
    api: { setStatuses: opts.api.setStatuses, approveAll: opts.api.approveAll },
    rerender: () => rerender(),
    onPendingCount: opts.onPendingCount,
  });

  // ---- CSV export ----
  const exportBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", title: T().admExportHint }, T().admExportCsv);
  exportBtn.addEventListener("click", () => void exportCsv());

  async function exportCsv(): Promise<void> {
    if (exporting) return;
    exporting = true;
    exportBtn.disabled = true;
    exportBtn.textContent = T().admExporting;
    try {
      const { blob, filename } = await opts.api.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: filename, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err: unknown) {
      if (!host.handleAuthError(err)) {
        host.setBanner(T().admExportFailed(errMessage(err)));
      }
    } finally {
      exporting = false;
      exportBtn.disabled = false;
      exportBtn.textContent = T().admExportCsv;
    }
  }

  // Row actions (manage/memberActions.ts): the status, role, password and delete flows.
  const actions = createMemberActions({
    host,
    accounts: accountsSlot,
    api: opts.api,
    busy,
    rerender: () => rerender(),
    onDeleting: (id) => expandedIds.delete(id),
    fallbackFocus: () => acctSearchInput,
    onDeleted: opts.onDeleted,
  });
  const changeStatus = actions.changeStatus;
  const acctMenu = actions.menu;

  function acctSignature(a: UserStats, now: number): string {
    const id = a.accountId;
    return JSON.stringify([
      getLang(),
      a.username,
      a.status,
      a.kind,
      a.role,
      a.classLimit,
      a.totalScore,
      a.rank,
      a.casesCompleted,
      a.casesStarted,
      a.accuracy,
      a.hintsUsed,
      a.wrongAttempts,
      a.commandsRevealed,
      a.achievements.map((x) => x.id),
      a.streak,
      relativeAgo(a.lastSeenAt, now),
      expandedIds.has(id),
      expandedIds.has(id) ? a.cases : null,
      busy.has(`status:${id}`),
    ]);
  }

  function acctToggle(a: UserStats, detailId: string): HTMLButtonElement {
    const expanded = expandedIds.has(a.accountId);
    return h(
      "button",
      {
        type: "button",
        class: "acct-toggle",
        "aria-expanded": String(expanded),
        "aria-controls": detailId,
        title: T().admShowCaseStats,
        onclick: () => {
          if (expandedIds.has(a.accountId)) expandedIds.delete(a.accountId);
          else expandedIds.add(a.accountId);
          renderAccountsTable();
          host.container.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(detailId)}"]`)?.focus();
        },
      },
      h("span", { class: "acct-caret", "aria-hidden": "true" }, "▸"),
      h("span", { class: "player-name", dir: "auto" }, a.username),
    );
  }

  /** Phone/tablet card: name, status, the key numbers in one line, last seen, and the actions menu. */
  function buildAcctCard(a: UserStats, now: number): HTMLLIElement {
    const expanded = expandedIds.has(a.accountId);
    const detailId = `acct-card-${a.accountId}`;
    const facts = [
      T().admPointsShort(fmtInt(a.totalScore)),
      a.rank === null ? null : T().admRankShort(fmtInt(a.rank)),
      T().admCasesShort(fmtInt(a.casesCompleted), fmtInt(a.casesStarted)),
      a.accuracy === null ? null : T().admAccuracyShort(formatPct(a.accuracy)),
    ].filter((x): x is string => x !== null);
    return h(
        "li",
        { class: `acct-card is-${a.status}${expanded ? " is-expanded" : ""}`, "data-id": a.accountId },
        h("div", { class: "pc-head" }, acctToggle(a, detailId), acctMenu(a)),
        h("p", { class: "ac-facts" }, statusPill(a.status), kindPill(a), rolePill(a), " ", facts.join(" · ")),
        tipped(h("p", { class: "muted small ac-seen" }, T().admSeenLine(relativeAgo(a.lastSeenAt, now))), formatDateTime(a.lastSeenAt)),
        expanded ? h("div", { class: "ac-detail", id: detailId }, caseStatsList(a.cases), h("p", { class: "muted small" }, acctExtras(a))) : null,
      );
  }

  function renderPager(page: AdminUsersResponse | null): void {
    const matched = page?.matched ?? 0;
    const shown = page?.accounts.length ?? 0;
    pagerEl.hidden = page === null || matched <= page.limit;
    if (page === null) return;
    pageRangeEl.textContent = shown === 0 ? "" : T().admPageRange(fmtInt(page.offset + 1), fmtInt(page.offset + shown), fmtInt(matched));
    prevBtn.disabled = page.offset === 0;
    nextBtn.disabled = page.offset + shown >= matched;
  }

  function renderAccountsTable(): void {
    const page = opts.page.get();
    const total = page?.total ?? 0;
    const matched = page?.matched ?? 0;
    acctCountEl.textContent = page === null ? "" : `(${matched === total ? fmtInt(total) : T().admShownOf(fmtInt(matched), fmtInt(total))})`;
    renderPager(page);
    if (page === null) {
      setChildren(acctTableEl, h("p", { class: "muted admin-empty-small" }, T().admLoading));
      return;
    }
    if (total === 0) {
      const url = location.origin;
      setChildren(
        acctTableEl,
        h(
          "div",
          { class: "admin-empty" },
          h("p", { class: "admin-empty-title" }, T().admNoAccounts),
          h("p", { class: "muted" }, T().admShareLink),
          h("div", { class: "admin-share" }, h("code", { class: "admin-share-url" }, url), copyButton(() => url, T().admCopyLink)),
        ),
      );
      return;
    }
    if (page.accounts.length === 0) {
      setChildren(acctTableEl, h("p", { class: "muted admin-empty-small" }, T().admNoMatch));
      return;
    }
    acctNow = Date.now();
    // The server's order (the query's sort); the table keeps any header sort the instructor chose on top of it.
    acctTable.update(page.accounts);
    if (acctTable.element.parentNode !== acctTableEl) setChildren(acctTableEl, acctTable.element);
  }

  function render(): void {
    const page = opts.page.get();
    const c = page?.counts ?? { users: 0, guests: 0, authors: 0, pending: 0, approved: 0, rejected: 0, active24h: 0 };
    const total = page?.total ?? 0;
    // Over every account (the server counts them), not just the page on screen.
    setChildren(
      acctTilesEl,
      tile(T().admTileAccounts, fmtInt(total), T().admActive24h(c.active24h)),
      tile(T().admTileGuests, fmtInt(c.guests)),
      tile(T().admTileAuthors, fmtInt(c.authors)),
      c.pending > 0 ? tile(T().admAcctStatus("pending"), fmtInt(c.pending), T().admAwaitingApproval) : null,
      tile(T().admTileBanned, fmtInt(c.rejected)),
    );
    setTilesSummary(acctTiles, T().admUsersSummary(fmtInt(total), fmtInt(c.guests), fmtInt(c.active24h)));
    pending.render(page?.pending ?? [], c.pending);
    // Drop UI state for accounts that disappeared.
    const ids = new Set((page?.accounts ?? []).map((a) => a.accountId));
    for (const id of expandedIds) if (!ids.has(id)) expandedIds.delete(id);
    renderAccountsTable();
  }

  function sections(): HTMLElement[] {
    return [
      acctTiles,
      pending.section(),
      h(
        "section",
        { class: "panel admin-panel acct-panel", "aria-labelledby": "admin-accounts-title" },
        h(
          "div",
          { class: "admin-table-head" },
          headWithHint(h("h2", { class: "admin-h2", id: "admin-accounts-title" }, T().admAccountsTitle, " ", acctCountEl), T().admAccountsHint),
          h("div", { class: "admin-controls" }, kindSelect, roleSelect, acctFilterSelect, acctSortSelect, acctTable.pickerButton, exportBtn),
        ),
        // Search stays in view while the list scrolls (sticky under the tab bar).
        h("div", { class: "acct-searchbar" }, acctSearchInput),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admAccountsHint),
        acctTableEl,
        pagerEl,
      ),
    ];
  }

  return {
    sections,
    render,
    renderPending: () => pending.render(opts.page.get()?.pending ?? [], opts.page.get()?.counts.pending ?? 0),
    query: () => ({ ...query }),
  };
}
