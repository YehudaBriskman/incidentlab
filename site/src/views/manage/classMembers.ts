// The class members panel (#182): KPI tiles, the requests to join (approve or decline), the password reset
// requests a class admin may vouch for (#254), and the members table with a per-row actions menu (promote, demote,
// remove). It is the class counterpart of manage/members.ts: class
// members carry a username and a membership only (never an account's stats), so it has its own columns, and its
// `api` has no password reset and no account delete: class admins never get either (docs/API.md, the
// permission matrix). Which actions a row offers comes from lib/class-permissions.ts; the server checks again.
// Built on the same host (views/manage/host.ts): confirms, row menus, the banner and the foldable tiles.
import { TC } from "../../i18n/strings-classes";
import { getLang } from "../../i18n/i18n";
import type { ClassMember, ClassResetRequest, ClassRole } from "../../../shared/contract";
import { dataTable, type Column } from "../../components/dataTable";
import { statGrid } from "../../components/statGrid";
import { h, setChildren } from "../../lib/dom";
import { toast, type MenuItem } from "../../lib/overlay";
import { memberActions, type ClassCaller } from "../../lib/class-permissions";
import { fmtInt, formatDateTime, ms, relativeAgo } from "./format";
import { NARROW_QUERY, setTilesSummary, type ManageHost, type Slot } from "./host";
import { headWithHint, tile, tipped } from "./ui";

export type ClassMembersApi = {
  approve(accountId: string): Promise<ClassMember>;
  /** Removes a member, or declines a request. */
  remove(accountId: string): Promise<void>;
  setRole(accountId: string, role: ClassRole): Promise<ClassMember>;
  /** "I know this student" for a password reset request (#254). Never sets or shows a password. */
  vouch(accountId: string): Promise<ClassResetRequest>;
};

export type ClassMembersOptions = {
  host: ManageHost;
  /** The members, pending requests included (null before the first load). */
  members: Slot<readonly ClassMember[] | null>;
  api: ClassMembersApi;
  /** Who is managing (decides which actions each row offers). */
  caller(): ClassCaller;
  /** The class's member limit (the tile's context line). */
  memberLimit(): number | null;
  /** How people join (a tile): with the code at once, or with approval. */
  joinMode(): "code" | "approval" | null;
  /** Open password reset requests of active members (#254); null before the first load or when it failed. */
  resetRequests: Slot<readonly ClassResetRequest[] | null>;
};

export type ClassMembersPanel = {
  /** The tiles, the requests and the members table, in page order. */
  sections(): HTMLElement[];
  render(): void;
};

export function roleChip(m: Pick<ClassMember, "role" | "isOwner">): HTMLElement {
  if (m.isOwner) return h("span", { class: "chip pill-info" }, TC().roleOwner);
  return m.role === "admin" ? h("span", { class: "chip pill-info" }, TC().roleAdmin) : h("span", { class: "chip" }, TC().roleMember);
}

export function createClassMembersPanel(opts: ClassMembersOptions): ClassMembersPanel {
  const { host } = opts;
  /** In-flight row actions by account id (their rows show as busy). */
  const busy = new Set<string>();
  let now = Date.now();

  const tilesEl = statGrid([], "admin-tiles");
  tilesEl.id = "class-member-tiles";
  const tiles = host.foldableTiles(tilesEl);
  const requestsEl = h("div", { class: "admin-table-wrap" });
  const tableEl = h("div", { class: "admin-table-wrap" });
  const countEl = h("span", { class: "muted small" });
  const requestCountEl = h("span", { class: "muted small" });
  const resetEl = h("div", { class: "admin-table-wrap" });
  const resetCountEl = h("span", { class: "muted small" });
  // Shown only while there is a request: most classes never have one.
  const resetPanel = h(
    "section",
    { class: "panel admin-panel class-requests-panel class-reset-panel", "aria-labelledby": "class-reset-title", hidden: true },
    h("h2", { class: "admin-h2", id: "class-reset-title", tabindex: "-1" }, TC().resetTitle, " ", resetCountEl),
    h("p", { class: "muted small" }, TC().resetHint),
    resetEl,
  );
  const vouching = new Set<string>();

  const nameCell = (m: ClassMember): HTMLElement => {
    const self = m.accountId === opts.caller().accountId;
    return h("span", { class: "player-name", dir: "auto" }, m.username, self ? h("span", { class: "muted small" }, ` (${TC().you})`) : null);
  };
  const joinedCell = (m: ClassMember): HTMLElement => tipped(h("span", {}, relativeAgo(m.joinedAt, now)), formatDateTime(m.joinedAt));

  /** Replaces one member in the list (after approve or a role change), or drops it (after remove). */
  function patch(accountId: string, next: ClassMember | null): void {
    const list = opts.members.get();
    if (!list) return;
    opts.members.set(next === null ? list.filter((m) => m.accountId !== accountId) : list.map((m) => (m.accountId === accountId ? next : m)));
  }

  async function run(m: ClassMember, action: () => Promise<ClassMember | null>): Promise<void> {
    busy.add(m.accountId);
    render();
    try {
      patch(m.accountId, await action());
      host.setBanner(null);
    } catch (err: unknown) {
      host.showActionError(err);
      host.refresh();
    } finally {
      busy.delete(m.accountId);
      render();
    }
  }

  const approve = (m: ClassMember): Promise<void> => run(m, () => opts.api.approve(m.accountId));
  const setRole = (m: ClassMember, role: ClassRole): Promise<void> => run(m, () => opts.api.setRole(m.accountId, role));

  /** Remove (or decline) asks first; the confirm stays busy until the call settles. */
  function askRemove(m: ClassMember, returnKey: string): void {
    const pending = m.status === "pending";
    void host
      .askConfirm({
        title: pending ? TC().declineTitle(m.username) : TC().removeTitle(m.username),
        body: pending ? TC().declineBody : TC().removeBody,
        confirmLabel: pending ? TC().declineConfirm(m.username) : TC().removeConfirm(m.username),
        cancelLabel: TC().cancel,
        busyLabel: TC().removing,
        tone: "danger",
        run: async () => {
          await opts.api.remove(m.accountId);
          patch(m.accountId, null);
        },
        returnFocus: () => host.menuTriggerEl(returnKey) ?? host.container.querySelector<HTMLElement>("#class-members-title"),
      })
      .then(() => render());
  }

  function menuItems(m: ClassMember): MenuItem[] {
    const key = `cm:${m.accountId}`;
    const items: MenuItem[] = [];
    for (const action of memberActions(opts.caller(), m)) {
      if (action === "promote") items.push({ label: TC().makeAdmin, run: () => void setRole(m, "admin") });
      if (action === "demote") items.push({ label: TC().makeMember, run: () => void setRole(m, "member") });
      if (action === "remove") items.push({ label: TC().remove, tone: "danger", run: () => askRemove(m, key) });
    }
    return items;
  }

  function actionsCell(m: ClassMember): HTMLElement | null {
    if (menuItems(m).length === 0) return null;
    const btn = host.menuButton(TC().actionsFor(m.username), `cm:${m.accountId}`, () => menuItems(m));
    if (busy.has(m.accountId)) btn.setAttribute("aria-disabled", "true");
    return btn;
  }

  const columns: Column<ClassMember>[] = [
    { id: "name", header: TC().colMember, rowHeader: true, className: "col-name", cell: nameCell, sortValue: (m) => m.username.toLowerCase() },
    { id: "role", header: TC().colRole, cell: roleChip, sortValue: (m) => (m.isOwner ? 0 : m.role === "admin" ? 1 : 2) },
    { id: "joined", header: TC().colJoined, className: "col-seen muted", cell: joinedCell, sortValue: (m) => ms(m.joinedAt), sortFirst: "desc" },
    { id: "actions", header: TC().colActions, headerHidden: true, className: "col-actions", cell: actionsCell },
  ];
  const sig = (m: ClassMember): string => JSON.stringify([getLang(), m, busy.has(m.accountId), relativeAgo(m.joinedAt, now), memberActions(opts.caller(), m)]);
  const card = (m: ClassMember): HTMLLIElement =>
    h(
      "li",
      { class: "acct-card class-member-card", "data-id": m.accountId },
      h("div", { class: "pc-head" }, nameCell(m), actionsCell(m)),
      h("p", { class: "ac-facts" }, roleChip(m), " ", h("span", { class: "muted small" }, relativeAgo(m.joinedAt, now))),
    );
  const table = dataTable<ClassMember>({
    columns,
    rows: [],
    rowKey: (m) => m.accountId,
    rowSig: sig,
    labelledBy: "class-members-title",
    className: "admin-table class-members-table",
    wrapClass: "admin-dt",
    initialSort: { id: "role", dir: "asc" },
    cards: { query: NARROW_QUERY, build: card, className: "acct-cards", labelledBy: "class-members-title" },
  });

  function requestRow(m: ClassMember): HTMLLIElement {
    const isBusy = busy.has(m.accountId);
    const can = memberActions(opts.caller(), m);
    const approveBtn = h("button", { type: "button", class: "btn btn-sm", "aria-disabled": isBusy ? "true" : null }, TC().approve);
    approveBtn.addEventListener("click", () => {
      if (!busy.has(m.accountId)) void approve(m);
    });
    const declineBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-menu": `cm:${m.accountId}`, "aria-disabled": isBusy ? "true" : null }, TC().decline);
    declineBtn.addEventListener("click", () => {
      if (!busy.has(m.accountId)) askRemove(m, `cm:${m.accountId}`);
    });
    return h(
      "li",
      { class: "class-request", "data-id": m.accountId },
      h("span", { class: "player-name", dir: "auto" }, m.username),
      joinedCell(m),
      can.includes("approve") ? h("span", { class: "class-request-actions" }, approveBtn, declineBtn) : null,
    );
  }

  /** Vouch asks first, saying to vouch only for a student known in person; the confirm stays busy until it settles. */
  function askVouch(r: ClassResetRequest): void {
    void host
      .askConfirm({
        title: TC().vouchTitle(r.username),
        body: TC().vouchBody,
        confirmLabel: TC().vouchConfirm(r.username),
        cancelLabel: TC().cancel,
        busyLabel: TC().vouching,
        tone: "primary",
        run: async () => {
          vouching.add(r.accountId);
          try {
            const updated = await opts.api.vouch(r.accountId);
            const list = opts.resetRequests.get();
            if (list) opts.resetRequests.set(list.map((x) => (x.accountId === updated.accountId ? updated : x)));
          } finally {
            vouching.delete(r.accountId);
          }
        },
        returnFocus: () => host.container.querySelector<HTMLElement>("#class-reset-title"),
      })
      .then((ok) => {
        render();
        if (ok) toast({ tone: "success", text: TC().vouchDone(r.username) });
      });
  }

  function resetRow(r: ClassResetRequest): HTMLLIElement {
    let action: HTMLElement;
    if (r.vouchedByMe) action = h("span", { class: "chip pill-info" }, TC().vouched);
    else {
      const btn = h("button", { type: "button", class: "btn btn-sm", "data-testid": "vouch", "aria-disabled": vouching.has(r.accountId) ? "true" : null }, TC().vouch);
      btn.addEventListener("click", () => {
        if (!vouching.has(r.accountId)) askVouch(r);
      });
      action = btn;
    }
    return h(
      "li",
      { class: "class-request", "data-id": r.accountId },
      h("span", { class: "player-name", dir: "auto" }, r.username),
      tipped(h("span", {}, TC().resetRequested(relativeAgo(r.createdAt, now))), formatDateTime(r.createdAt)),
      h("span", { class: "class-request-actions" }, action),
    );
  }

  function renderResets(): void {
    const list = opts.resetRequests.get() ?? [];
    resetPanel.hidden = list.length === 0;
    resetCountEl.textContent = `(${fmtInt(list.length)})`;
    setChildren(resetEl, list.length === 0 ? null : h("ul", { class: "class-requests", "aria-labelledby": "class-reset-title" }, list.map(resetRow)));
  }

  function render(): void {
    now = Date.now();
    renderResets();
    const all = opts.members.get();
    if (all === null) {
      setChildren(tableEl, h("p", { class: "muted admin-empty-small" }, TC().loading));
      return;
    }
    const active = all.filter((m) => m.status === "active");
    const pending = all.filter((m) => m.status === "pending");
    const admins = active.filter((m) => m.role === "admin").length;
    const limit = opts.memberLimit();
    setChildren(
      tilesEl,
      tile(TC().tileMembers, fmtInt(active.length), limit === null ? undefined : TC().tileMembersSub(limit)),
      tile(TC().tileAdmins, fmtInt(admins)),
      tile(TC().tileRequests, fmtInt(pending.length)),
      tile(TC().tileJoin, opts.joinMode() === "approval" ? TC().joinByApproval : TC().joinByCode),
    );
    setTilesSummary(tiles, TC().membersSummary(active.length, pending.length));
    requestCountEl.textContent = `(${fmtInt(pending.length)})`;
    setChildren(
      requestsEl,
      pending.length === 0 ? h("p", { class: "muted admin-empty-small" }, TC().noRequests) : h("ul", { class: "class-requests", "aria-labelledby": "class-requests-title" }, pending.map(requestRow)),
    );
    countEl.textContent = `(${fmtInt(active.length)})`;
    table.update(active);
    if (table.element.parentNode !== tableEl) setChildren(tableEl, table.element);
  }

  function sections(): HTMLElement[] {
    return [
      tiles,
      h(
        "section",
        { class: "panel admin-panel class-requests-panel", "aria-labelledby": "class-requests-title" },
        headWithHint(h("h2", { class: "admin-h2", id: "class-requests-title" }, TC().requestsTitle, " ", requestCountEl), TC().requestsHint),
        h("p", { class: "muted small admin-hint is-touch-only" }, TC().requestsHint),
        requestsEl,
      ),
      resetPanel,
      h(
        "section",
        { class: "panel admin-panel acct-panel", "aria-labelledby": "class-members-title" },
        headWithHint(h("h2", { class: "admin-h2", id: "class-members-title", tabindex: "-1" }, TC().membersTitle, " ", countEl), TC().membersHint),
        h("p", { class: "muted small admin-hint is-touch-only" }, TC().membersHint),
        tableEl,
      ),
    ];
  }

  return { sections, render };
}
