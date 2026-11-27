// The owner console's password reset requests (#254), on the Users section: requests that an admin of one of the
// player's classes vouched for. Approve sets a temporary password (shown once in the persistent dialog of
// manage/tempPassword.ts) and signs the player out; Reject closes the request. The server lists only requests with
// a vouch that still holds and refuses an approval without one, so the UI has nothing to skip. Fetched on demand
// (opening the section, a refresh, after an action), never on the dashboard's timer. Names render as text only.
import { T } from "../../i18n/strings-tools";
import { h, setChildren } from "../../lib/dom";
import { toast } from "../../lib/overlay";
import type { AdminPasswordResetRequest } from "../../../shared/contract";
import "../../classes.css";
import { fmtInt, formatDateTime, relativeAgo } from "./format";
import type { ManageHost } from "./host";
import { showTemporaryPassword } from "./tempPassword";
import { headWithHint, tipped } from "./ui";

export type ResetRequestsApi = {
  list(): Promise<AdminPasswordResetRequest[]>;
  /** Resolves to the one-time temporary password. */
  approve(accountId: string): Promise<string>;
  reject(accountId: string): Promise<void>;
};

export type ResetRequestsPanel = {
  section(): HTMLElement;
  /** Fetches the list (on demand) and renders it. */
  load(): Promise<void>;
  render(): void;
};

export function createResetRequestsPanel(opts: { host: ManageHost; api: ResetRequestsApi }): ResetRequestsPanel {
  const { host } = opts;
  let requests: AdminPasswordResetRequest[] | null = null;
  let error: string | null = null;
  let now = Date.now();
  const busy = new Set<string>();

  const countEl = h("span", { class: "muted small" });
  const bodyEl = h("div", { class: "admin-table-wrap" });
  const titleEl = h("h2", { class: "admin-h2", id: "admin-resets-title", tabindex: "-1" }, T().admResetReqTitle, " ", countEl);
  const sectionEl = h(
    "section",
    { class: "panel admin-panel class-requests-panel reset-requests-panel", "aria-labelledby": "admin-resets-title" },
    headWithHint(titleEl, T().admResetReqHint),
    h("p", { class: "muted small admin-hint is-touch-only" }, T().admResetReqHint),
    bodyEl,
  );

  const drop = (accountId: string): void => {
    if (requests) requests = requests.filter((r) => r.accountId !== accountId);
  };

  function askApprove(r: AdminPasswordResetRequest): void {
    let password: string | null = null;
    void host
      .askConfirm({
        title: T().admResetApproveTitle(r.username),
        body: T().admResetApproveBody,
        confirmLabel: T().admResetApproveConfirm(r.username),
        busyLabel: T().admResetApproving,
        tone: "primary",
        run: async () => {
          busy.add(r.accountId);
          try {
            password = await opts.api.approve(r.accountId);
            drop(r.accountId);
          } finally {
            busy.delete(r.accountId);
          }
        },
        returnFocus: () => titleEl,
      })
      .then(async (ok) => {
        render();
        if (ok && password !== null) await showTemporaryPassword(host, { username: r.username, password, help: T().admResetTempHelp });
        password = null;
      });
  }

  function askReject(r: AdminPasswordResetRequest): void {
    void host
      .askConfirm({
        title: T().admResetRejectTitle(r.username),
        body: T().admResetRejectBody,
        confirmLabel: T().admResetRejectConfirm,
        busyLabel: T().admResetRejecting,
        tone: "danger",
        run: async () => {
          await opts.api.reject(r.accountId);
          drop(r.accountId);
        },
        returnFocus: () => titleEl,
      })
      .then((ok) => {
        render();
        if (ok) toast({ tone: "success", text: T().admResetRejected(r.username) });
      });
  }

  function row(r: AdminPasswordResetRequest): HTMLLIElement {
    const isBusy = busy.has(r.accountId);
    const approve = h("button", { type: "button", class: "btn btn-sm", "data-testid": "reset-approve", "aria-disabled": isBusy ? "true" : null }, T().admResetApprove);
    approve.addEventListener("click", () => {
      if (!busy.has(r.accountId)) askApprove(r);
    });
    const reject = h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-disabled": isBusy ? "true" : null }, T().admResetReject);
    reject.addEventListener("click", () => {
      if (!busy.has(r.accountId)) askReject(r);
    });
    return h(
      "li",
      { class: "class-request reset-request", "data-id": r.accountId },
      h(
        "span",
        {},
        h("span", { class: "player-name", dir: "auto" }, r.username),
        " ",
        tipped(h("span", { class: "muted small" }, T().admResetReqAsked(relativeAgo(r.createdAt, now))), formatDateTime(r.createdAt)),
        h(
          "ul",
          { class: "reset-vouches muted small" },
          r.vouches.map((v) => h("li", { dir: "auto" }, T().admResetVouch(v.byUsername, v.className, relativeAgo(v.memberSince, now)))),
        ),
      ),
      h("span", { class: "class-request-actions" }, approve, reject),
    );
  }

  function render(): void {
    now = Date.now();
    if (requests === null) {
      countEl.textContent = "";
      setChildren(bodyEl, h("p", { class: error ? "admin-error" : "muted admin-empty-small" }, error ?? T().admLoading));
      return;
    }
    countEl.textContent = `(${fmtInt(requests.length)})`;
    setChildren(
      bodyEl,
      requests.length === 0
        ? h("p", { class: "muted admin-empty-small" }, T().admResetReqEmpty)
        : h("ul", { class: "class-requests", "aria-labelledby": "admin-resets-title" }, requests.map(row)),
    );
  }

  async function load(): Promise<void> {
    try {
      requests = await opts.api.list();
      error = null;
    } catch (err: unknown) {
      if (host.handleAuthError(err)) return;
      error = T().admActionFailed(err instanceof Error ? err.message : String(err));
    }
    if (!host.disposed()) render();
  }

  return { section: () => sectionEl, load, render };
}
