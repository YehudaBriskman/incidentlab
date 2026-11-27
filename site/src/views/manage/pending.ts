// "Waiting for approval": the sign-ups to approve or reject, one by one, ticked in bulk, or all at once.
// A data table with a checkbox per sign-up and a select-all box (components/dataTable.ts); cards on phones and
// tablets. Part of the members panel (manage/members.ts), which owns the account list and the row actions.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { h, setChildren } from "../../lib/dom";
import { dataTable } from "../../components/dataTable";
import { AdminApiError } from "../../lib/admin-api";
import type { AccountView, UserStats } from "../../../shared/contract";
import { fmtInt, formatDateTime, ms, relativeAgo } from "./format";
import { NARROW_QUERY, type ManageHost, type Slot } from "./host";
import { tipped } from "./ui";

export type PendingApi = {
  /** Approve or reject several accounts (per-account calls; partial failures come back in `errors`). */
  setStatuses(ids: readonly string[], action: "approve" | "reject"): Promise<{ ok: AccountView[]; errors: unknown[] }>;
  /** Approve every pending sign-up; resolves to how many were approved. */
  approveAll(): Promise<number>;
};

export type PendingOptions = {
  host: ManageHost;
  /** The account list (pending ones are listed here); null before the first load. */
  accounts: Slot<readonly UserStats[] | null>;
  /** In-flight row actions shared with the members table, keyed "status:<accountId>". */
  busy: Set<string>;
  /** Approve or reject one account (the members panel's action, so both lists stay in step). */
  changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void>;
  api: PendingApi;
  /** Re-renders the whole tab after a bulk action. */
  rerender(): void;
  /** The number of pending sign-ups changed (a badge elsewhere on the page). */
  onPendingCount?: (n: number) => void;
};

export type PendingPanel = {
  /** The "Waiting for approval" section (built on each call; its content elements are kept). */
  section(): HTMLElement;
  render(list: readonly UserStats[]): void;
};

export function createPendingPanel(opts: PendingOptions): PendingPanel {
  const { host, busy } = opts;
  const pendingBulkEl = h("div", { class: "pending-bulk" });
  const pendingEl = h("div", { class: "pending-wrap" });
  const approveAllEl = h("div", { class: "pending-approve-all" });
  const pendingStatusEl = h("p", { class: "muted small pending-status", role: "status" });
  const pendingCountEl = h("span", { class: "count-badge" });
  let pendingSig = "";
  /** pending sign-ups ticked for a bulk approve/reject */
  const pendingSelected = new Set<string>();
  let approvedMsg: string | null = null;

  /** Bulk approve/reject of the ticked pending sign-ups (per-account calls; partial failures are reported). */
  async function bulkStatus(action: "approve" | "reject"): Promise<void> {
    const ids = [...pendingSelected];
    if (ids.length === 0) return;
    for (const id of ids) busy.add(`status:${id}`);
    opts.rerender();
    const res = await opts.api.setStatuses(ids, action);
    if (host.disposed()) return;
    for (const id of ids) busy.delete(`status:${id}`);
    const authFailure = res.errors.find((err) => err instanceof AdminApiError && (err.status === 401 || err.status === 503));
    if (authFailure && host.handleAuthError(authFailure)) return;
    pendingTable.clearSelection();
    approvedMsg =
      action === "approve" ? T().admBulkApproved(res.ok.length, res.errors.length) : T().admBulkRejected(res.ok.length, res.errors.length);
    const list = opts.accounts.get();
    if (list) {
      const done = new Map(res.ok.map((v) => [v.id, v.status] as const));
      opts.accounts.set(
        list.map((a) => {
          const st = done.get(a.accountId);
          return st ? { ...a, status: st } : a;
        }),
      );
    }
    opts.rerender();
    pendingStatusEl.focus();
    host.refresh();
  }

  let pendingNow = Date.now();
  const pendingBusy = (a: UserStats): boolean => busy.has(`status:${a.accountId}`);
  function pendingButtons(a: UserStats): HTMLElement[] {
    const isBusy = pendingBusy(a);
    return [
      h(
        "button",
        { type: "button", class: "btn btn-sm", disabled: isBusy, "aria-label": T().admApproveLabel(a.username), onclick: () => void opts.changeStatus(a, "approve") },
        T().admApprove,
      ),
      h(
        "button",
        { type: "button", class: "btn btn-ghost btn-sm", disabled: isBusy, "aria-label": T().admRejectLabel(a.username), onclick: () => void opts.changeStatus(a, "reject") },
        T().admReject,
      ),
    ];
  }
  const signedUp = (a: UserStats): HTMLElement => tipped(h("span", {}, T().admSignedUp(relativeAgo(a.createdAt, pendingNow))), formatDateTime(a.createdAt));
  const pendingTable = dataTable<UserStats>({
    columns: [
      { id: "name", header: T().admColUser, rowHeader: true, className: "col-name", cell: (a) => h("span", { class: "player-name", dir: "auto" }, a.username), sortValue: (a) => a.username },
      { id: "signed", header: T().admColSignedUp, className: "col-seen muted", cell: signedUp, sortValue: (a) => ms(a.createdAt) },
      { id: "actions", header: T().admColActions, headerHidden: true, className: "col-actions", cell: (a) => h("span", { class: "pending-actions" }, pendingButtons(a)) },
    ],
    rows: [],
    rowKey: (a) => a.accountId,
    rowSig: (a) => JSON.stringify([getLang(), a.username, pendingBusy(a), relativeAgo(a.createdAt, pendingNow)]),
    rowAttrs: () => ({ class: "pending-row" }),
    initialSort: { id: "signed", dir: "asc" },
    labelledBy: "admin-pending-title",
    className: "admin-table pending-table",
    wrapClass: "admin-dt",
    selection: {
      rowLabel: (a) => T().admSelectLabel(a.username),
      allLabel: T().admSelectAll,
      disabled: pendingBusy,
      onChange: (keys) => {
        pendingSelected.clear();
        for (const k of keys) pendingSelected.add(k);
        approvedMsg = null;
        pendingStatusEl.hidden = true;
        renderPendingBulk();
      },
    },
    cards: {
      query: NARROW_QUERY,
      className: "pending-list",
      labelledBy: "admin-pending-title",
      build: (a) =>
        h(
          "li",
          { class: "pending-item" },
          h("span", { class: "pending-name", dir: "auto" }, a.username),
          h("span", { class: "pending-meta muted small" }, signedUp(a)),
          h("span", { class: "pending-actions" }, pendingButtons(a)),
        ),
    },
  });

  let pendingBulkSig = "";
  /** "n selected" with Approve / Reject selected, only while something is ticked. */
  function renderPendingBulk(): void {
    const sel = pendingSelected.size;
    const pending = (opts.accounts.get() ?? []).filter((a) => a.status === "pending");
    const anyBusy = pending.some(pendingBusy);
    const sig = JSON.stringify([getLang(), sel, anyBusy]);
    if (sig === pendingBulkSig) return;
    pendingBulkSig = sig;
    if (sel === 0) {
      pendingBulkEl.replaceChildren();
      return;
    }
    setChildren(
      pendingBulkEl,
      h("span", { class: "muted small", role: "status" }, T().admSelectedN(sel)),
      h(
        "button",
        { type: "button", class: "btn btn-sm", id: "pending-bulk-approve", disabled: anyBusy, onclick: () => void bulkStatus("approve") },
        T().admApproveSelected(sel),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          id: "pending-bulk-reject",
          disabled: anyBusy,
          onclick: () =>
            void host.askConfirm({
              title: T().admRejectSelectedTitle(sel),
              body: T().admRejectSelectedBody,
              confirmLabel: T().admRejectSelected(sel),
              tone: "danger",
              run: () => bulkStatus("reject"),
              returnFocus: () => pendingStatusEl,
            }),
        },
        T().admRejectSelected(sel),
      ),
    );
  }

  function render(list: readonly UserStats[]): void {
    const pending = list.filter((a) => a.status === "pending");
    pendingCountEl.textContent = fmtInt(pending.length);
    pendingCountEl.classList.toggle("is-zero", pending.length === 0);
    opts.onPendingCount?.(pending.length);
    pendingStatusEl.textContent = approvedMsg ?? "";
    pendingStatusEl.hidden = approvedMsg === null;
    pendingStatusEl.tabIndex = -1;
    const n = pending.length;
    const sig = JSON.stringify([getLang(), n]);
    if (sig !== pendingSig) {
      pendingSig = sig;
      // Approving is the intended, safe action: a primary confirm, never a red one.
      setChildren(
        approveAllEl,
        n === 0
          ? null
          : h(
              "button",
              {
                type: "button",
                class: "btn btn-primary btn-sm",
                id: "admin-approve-all",
                "aria-label": T().admApproveAllLabel(n),
                onclick: () =>
                  void host.askConfirm({
                    title: T().admApproveAllTitle(n),
                    body: T().admApproveAllBody,
                    confirmLabel: T().admApproveAll(n),
                    busyLabel: T().admApproving,
                    tone: "primary",
                    run: async () => {
                      const approved = await opts.api.approveAll();
                      pendingTable.clearSelection();
                      approvedMsg = T().admApprovedN(approved);
                      host.refresh();
                    },
                    returnFocus: () => document.getElementById("admin-approve-all") ?? pendingStatusEl,
                  }),
              },
              T().admApproveAll(n),
            ),
      );
    }
    if (n === 0) {
      setChildren(pendingEl, h("p", { class: "muted admin-empty-small" }, T().admNoPending));
    } else {
      pendingNow = Date.now();
      pendingTable.update(pending);
      if (pendingTable.element.parentNode !== pendingEl) setChildren(pendingEl, pendingTable.element);
    }
    renderPendingBulk();
  }

  function section(): HTMLElement {
    return h(
      "section",
      { class: "panel admin-panel pending-panel", "aria-labelledby": "admin-pending-title" },
      h("div", { class: "admin-table-head" }, h("h2", { class: "admin-h2", id: "admin-pending-title" }, T().admPendingTitle, " ", pendingCountEl), approveAllEl),
      pendingStatusEl,
      pendingBulkEl,
      pendingEl,
    );
  }

  return { section, render };
}
