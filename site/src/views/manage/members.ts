// The members panel: KPI tiles, the sign-ups waiting for approval (manage/pending.ts) and the members table
// with search, status filter, sort, column picker, per-case detail rows, CSV export and a per-row actions menu
// (approve or revoke, author role, password reset, delete). Phone and tablet widths get cards.
// Scoped by its options: the account list comes in through a Slot and every write goes through `api`, so the
// admin dashboard mounts it with /api/admin/* and a class dashboard can mount it with class-scoped calls.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { TRASH_RETENTION_DAYS, type AccountRecordRole, type AccountStatus, type AccountView, type UserStats } from "../../../shared/contract";
import { dataTable, type Column } from "../../components/dataTable";
import { statGrid } from "../../components/statGrid";
import type { SortState } from "../../components/table-core";
import { copyButton, h, setChildren } from "../../lib/dom";
import { openDialog, type MenuItem } from "../../lib/overlay";
import { errMessage, fmtInt, formatDateTime, formatPct, ms, relativeAgo } from "./format";
import { NARROW_QUERY, setTilesSummary, syncSortSelect, type ManageHost, type Slot } from "./host";
import { acctExtras, caseStatsList, caseStatsTable, rolePill, statusPill } from "./memberDetails";
import { createPendingPanel, type PendingApi } from "./pending";
import { headWithHint, tile, tipped } from "./ui";

const ACCT_COLS_STORAGE = "il.adminAcctCols";

type AcctSortKey = "rank" | "newest" | "seen" | "name";
type AcctFilter = "all" | AccountStatus;

export type MembersApi = PendingApi & {
  setStatus(accountId: string, action: "approve" | "reject"): Promise<AccountView>;
  setRole(accountId: string, role: AccountRecordRole): Promise<AccountView>;
  /** Resolves to a one-time temporary password, shown once in a dialog. */
  resetPassword(accountId: string): Promise<string>;
  deleteAccount(accountId: string): Promise<void>;
  /** The full per-account export as a CSV file. */
  exportCsv(): Promise<{ blob: Blob; filename: string }>;
};

export type MembersOptions = {
  host: ManageHost;
  /** The members (null before the first load). The dashboard's poll fills it; actions update it in place. */
  accounts: Slot<readonly UserStats[] | null>;
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
};

function sortAccounts(list: readonly UserStats[], key: AcctSortKey): UserStats[] {
  const byName = (a: UserStats, b: UserStats): number => a.username.localeCompare(b.username);
  const desc = (a: string | null, b: string | null): number => (ms(b) ?? 0) - (ms(a) ?? 0);
  const out = [...list];
  switch (key) {
    case "rank":
      return out.sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || b.totalScore - a.totalScore || byName(a, b),
      );
    case "newest":
      return out.sort((a, b) => desc(a.createdAt, b.createdAt) || byName(a, b));
    case "seen":
      return out.sort((a, b) => desc(a.lastSeenAt, b.lastSeenAt) || byName(a, b));
    case "name":
      return out.sort(byName);
  }
}

export function createMembersPanel(opts: MembersOptions): MembersPanel {
  const { host } = opts;
  const rerender = (): void => (opts.rerender ?? render)();
  let acctSort: AcctSortKey = "rank";
  let acctFilter: AcctFilter = "all";
  let acctSearch = "";
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
    dir: "auto",
    placeholder: T().admSearchPlaceholder,
    "aria-label": T().admSearchLabel,
  });
  acctSearchInput.addEventListener("input", () => {
    acctSearch = acctSearchInput.value;
    renderAccountsTable();
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
    if (v === "all" || v === "pending" || v === "approved" || v === "rejected") {
      acctFilter = v;
      renderAccountsTable();
    }
  });
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
    if (v === "rank" || v === "newest" || v === "seen" || v === "name") {
      acctSort = v;
      acctTable.setSort(ACCT_SORTS[v]);
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
    { id: "status", header: T().admColStatus, cell: (a) => [statusPill(a.status), rolePill(a)], sortValue: (a) => a.status, csv: (a) => a.status },
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
      cell: (a) => h("span", { title: T().admBadgesTip(a.achievements.map((x) => T().admAchievement(x.id)).join(", ")) }, fmtInt(a.achievements.length)),
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
    initialSort: ACCT_SORTS[acctSort],
    columnPicker: {
      label: T().admColumns,
      legend: T().admColumnsLegend,
      resetLabel: T().admColumnsReset,
      storageKey: ACCT_COLS_STORAGE,
      countLabel: T().admColumnsCount,
    },
    virtualize: { rowHeight: 56 },
    cards: { query: NARROW_QUERY, build: (a) => buildAcctCard(a, acctNow), className: "acct-cards", labelledBy: "admin-accounts-title" },
    onSortChange: (s) => syncSortSelect(acctSortSelect, ACCT_SORTS, s),
  });

  // Waiting for approval (manage/pending.ts): shares the busy set and the status action with the table.
  const pending = createPendingPanel({
    host,
    accounts: opts.accounts,
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

  // ---- one-time temporary password (a dialog from lib/overlay.ts) ----
  async function showTempPassword(username: string, password: string): Promise<void> {
    let copied = false;
    // The password exists only in this dialog: Done or Escape without copying asks first, and "Back" reopens it.
    for (;;) {
      const copy = copyButton(() => password, T().admCopyPassword);
      copy.addEventListener("click", () => (copied = true));
      await openDialog({
        size: "sm",
        title: T().admTempPwTitle(username),
        className: "admin-pw-dialog",
        body: [h("p", { class: "muted" }, T().admTempPwHelp), h("div", { class: "admin-share admin-pw" }, h("code", { class: "admin-share-url admin-pw-value" }, password), copy)],
        actions: [{ value: "done", label: T().admDone, tone: "primary", autofocus: true }],
      });
      if (copied) break;
      const close = await host.askConfirm({
        title: T().admPwUncopiedTitle,
        body: T().admPwUncopiedBody,
        confirmLabel: T().admPwCloseAnyway,
        cancelLabel: T().admPwBack,
        tone: "danger",
      });
      if (close || host.disposed()) break;
    }
  }

  async function changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void> {
    const busyKey = `status:${account.accountId}`;
    busy.add(busyKey);
    rerender();
    try {
      const updated = await opts.api.setStatus(account.accountId, action);
      const list = opts.accounts.get();
      if (list) opts.accounts.set(list.map((a) => (a.accountId === updated.id ? { ...a, status: updated.status } : a)));
      host.setBanner(null);
      host.refresh();
    } catch (err: unknown) {
      host.showActionError(err);
    } finally {
      busy.delete(busyKey);
      if (opts.accounts.get()) rerender();
    }
  }

  async function changeRole(account: UserStats, role: AccountRecordRole): Promise<void> {
    const busyKey = `status:${account.accountId}`;
    busy.add(busyKey);
    rerender();
    try {
      const updated = await opts.api.setRole(account.accountId, role);
      const list = opts.accounts.get();
      if (list) opts.accounts.set(list.map((a) => (a.accountId === updated.id && updated.role !== "admin" ? { ...a, role: updated.role } : a)));
    } catch (err: unknown) {
      host.showActionError(err);
    } finally {
      busy.delete(busyKey);
      if (opts.accounts.get()) rerender();
    }
  }

  /** Menu items for one account: status changes first, then the password reset, Delete last (danger). */
  function acctMenuItems(a: UserStats): MenuItem[] {
    const key = `acct:${a.accountId}`;
    const items: MenuItem[] = [];
    if (a.status !== "approved") items.push({ label: T().admApprove, run: () => void changeStatus(a, "approve") });
    // Revoke signs the player out at once, so it asks first: approving again later can't bring the session back.
    if (a.status === "approved") {
      items.push({
        label: T().admRevoke,
        run: () =>
          void host.askConfirm({
            title: T().admRevokeTitle(a.username),
            body: T().admRevokeBody,
            confirmLabel: T().admRevokeConfirm,
            tone: "danger",
            returnFocus: () => host.menuTriggerEl(key),
          }).then((ok) => {
            if (ok) void changeStatus(a, "reject");
          }),
      });
    } else if (a.status === "pending") items.push({ label: T().admReject, run: () => void changeStatus(a, "reject") });
    items.push(a.role === "author" ? { label: T().admRemoveAuthor, run: () => void changeRole(a, "player") } : { label: T().admMakeAuthor, run: () => void changeRole(a, "author") });
    items.push({
      label: T().admResetPwItem,
      run: () =>
        void host.askConfirm({
          title: T().admResetPwTitle(a.username),
          body: T().admResetPwBody,
          confirmLabel: T().admResetPwLabel(a.username),
          busyLabel: T().admResettingPw,
          tone: "primary",
          run: async () => {
            const password = await opts.api.resetPassword(a.accountId);
            void showTempPassword(a.username, password);
          },
          returnFocus: () => host.menuTriggerEl(key),
        }),
    });
    items.push({
      label: T().admDeleteItem,
      tone: "danger",
      run: () =>
        void host.askConfirm({
          title: T().admDeleteTitle(a.username),
          body: T().admDeleteBody(TRASH_RETENTION_DAYS),
          confirmLabel: T().admDeleteLabel(a.username),
          cancelLabel: T().admKeepAccount,
          busyLabel: T().admDeleting,
          tone: "danger",
          typedName: a.username,
          run: async () => {
            await opts.api.deleteAccount(a.accountId);
            expandedIds.delete(a.accountId);
            const list = opts.accounts.get();
            if (list) opts.accounts.set(list.filter((x) => x.accountId !== a.accountId));
            rerender();
            host.refresh();
          },
          returnFocus: () => host.menuTriggerEl(key) ?? acctSearchInput,
        }).then(async (ok) => {
          if (!ok) return;
          await opts.onDeleted?.(a);
        }),
    });
    return items;
  }

  function acctMenu(a: UserStats): HTMLButtonElement {
    return host.menuButton(T().admActionsFor(a.username), `acct:${a.accountId}`, () => acctMenuItems(a));
  }

  function acctSignature(a: UserStats, now: number): string {
    const id = a.accountId;
    return JSON.stringify([
      getLang(),
      a.username,
      a.status,
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
        h("p", { class: "ac-facts" }, statusPill(a.status), rolePill(a), " ", facts.join(" · ")),
        tipped(h("p", { class: "muted small ac-seen" }, T().admSeenLine(relativeAgo(a.lastSeenAt, now))), formatDateTime(a.lastSeenAt)),
        expanded ? h("div", { class: "ac-detail", id: detailId }, caseStatsList(a.cases), h("p", { class: "muted small" }, acctExtras(a))) : null,
      );
  }

  function renderAccountsTable(): void {
    const all = opts.accounts.get() ?? [];
    acctCountEl.textContent = `(${fmtInt(all.length)})`;
    if (all.length === 0) {
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
    const q = acctSearch.trim().toLowerCase();
    const filtered = all.filter(
      (a) => (acctFilter === "all" || a.status === acctFilter) && (!q || a.username.toLowerCase().includes(q)),
    );
    if (filtered.length !== all.length) acctCountEl.textContent = `(${T().admShownOf(fmtInt(filtered.length), fmtInt(all.length))})`;
    if (filtered.length === 0) {
      setChildren(acctTableEl, h("p", { class: "muted admin-empty-small" }, T().admNoMatch));
      return;
    }
    acctNow = Date.now();
    // Name order first: the table's sort is stable, so ties (same rank, same score) read alphabetically.
    acctTable.update(sortAccounts(filtered, "name"));
    if (acctTable.element.parentNode !== acctTableEl) setChildren(acctTableEl, acctTable.element);
  }

  function render(): void {
    const all = opts.accounts.get() ?? [];
    const count = (s: AccountStatus): number => all.filter((a) => a.status === s).length;
    const active = all.filter((a) => {
      const t = ms(a.lastSeenAt);
      return t !== null && Date.now() - t < 24 * 3600 * 1000;
    }).length;
    setChildren(
      acctTilesEl,
      tile(T().admTileAccounts, fmtInt(all.length), T().admActive24h(active)),
      tile(T().admAcctStatus("pending"), fmtInt(count("pending")), T().admAwaitingApproval),
      tile(T().admAcctStatus("approved"), fmtInt(count("approved"))),
      tile(T().admAcctStatus("rejected"), fmtInt(count("rejected"))),
    );
    setTilesSummary(acctTiles, T().admAcctSummary(fmtInt(all.length), fmtInt(count("pending")), fmtInt(active)));
    pending.render(all);
    // Drop UI state for accounts that disappeared.
    const ids = new Set(all.map((a) => a.accountId));
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
          h("div", { class: "admin-controls" }, acctFilterSelect, acctSortSelect, acctTable.pickerButton, exportBtn),
        ),
        // Search stays in view while the list scrolls (sticky under the tab bar).
        h("div", { class: "acct-searchbar" }, acctSearchInput),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admAccountsHint),
        acctTableEl,
      ),
    ];
  }

  return { sections, render, renderPending: () => pending.render(opts.accounts.get() ?? []) };
}
