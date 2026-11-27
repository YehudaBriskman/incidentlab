// The owner console's Classes section (#185): every class on the site (name, owner, members and limit, status,
// the current event), a search over names and owners, and per-row actions: set the member limit, archive or
// restore, open the class's manage page. The list is fetched on demand (opening the section, a refresh, after
// an action), never on the dashboard's timer. Class names and usernames are rendered as text only.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { h, setChildren, type Child } from "../../lib/dom";
import { toast } from "../../lib/overlay";
import { dataTable } from "../../components/dataTable";
import { CLASS_DEFAULTS, type AdminClass } from "../../../shared/contract";
import { fmtInt, formatDateTime, ms, relativeIn } from "./format";
import type { ManageHost } from "./host";
import { limitDialog } from "./limitDialog";
import { headWithHint } from "./ui";

export type OwnerClassesApi = {
  list(): Promise<AdminClass[]>;
  setMemberLimit(classId: string, memberLimit: number): Promise<void>;
  setArchived(classId: string, archived: boolean): Promise<void>;
};

export type OwnerClassesOptions = { host: ManageHost; api: OwnerClassesApi };

export type OwnerClassesPanel = {
  mount(panel: HTMLElement): void;
  /** Fetches the list (on demand) and renders it. */
  load(): Promise<void>;
  render(): void;
};

type EventPhase = "none" | "open" | "upcoming" | "live" | "ended";

function eventPhase(c: AdminClass, now: number): EventPhase {
  const ev = c.event;
  if (ev === null || (ev.name === "" && ev.startsAt === null && ev.endsAt === null)) return "none";
  const start = ms(ev.startsAt);
  const end = ms(ev.endsAt);
  if (start === null && end === null) return "open";
  if (start !== null && now < start) return "upcoming";
  if (end !== null && now >= end) return "ended";
  return "live";
}

export function createOwnerClassesPanel(opts: OwnerClassesOptions): OwnerClassesPanel {
  const { host } = opts;
  let classes: AdminClass[] | null = null;
  let error: string | null = null;
  let search = "";
  let now = Date.now();
  const busy = new Set<string>();

  const countEl = h("span", { class: "muted small" });
  const bodyEl = h("div", { class: "admin-table-wrap" });
  const searchInput = h("input", {
    type: "search",
    class: "admin-input owner-class-search",
    enterkeyhint: "search",
    dir: "auto",
    placeholder: T().admClassesSearch,
    "aria-label": T().admClassesSearchLabel,
  });
  // The whole list is on screen (at most a few hundred rows): searching filters it locally.
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    render();
  });

  const ownerText = (c: AdminClass): string => (c.ownerId === "admin" ? T().admActorOwner : (c.ownerName ?? T().admActorGone));

  function eventCell(c: AdminClass): Child {
    const phase = eventPhase(c, now);
    const name = c.event?.name ?? "";
    const label =
      phase === "none" ? T().admEventNone
      : phase === "open" ? T().admEventOpen
      : phase === "live" ? T().admEventLiveNow
      : phase === "ended" ? T().admEventEnded
      : T().admEventStarts(relativeIn(c.event?.startsAt ?? null, now));
    return [
      name === "" ? null : h("span", { dir: "auto" }, name),
      name === "" ? null : " ",
      h("span", { class: `status-pill is-event-${phase}`, title: c.event?.startsAt ? formatDateTime(c.event.startsAt) : "" }, label),
    ];
  }

  async function editLimit(c: AdminClass): Promise<void> {
    const key = `class:${c.id}`;
    try {
      const saved = await limitDialog({
        title: T().admMemberLimitTitle(c.name),
        label: T().admMemberLimitLabel,
        help: T().admMemberLimitHelp,
        value: c.memberLimit,
        defaultValue: CLASS_DEFAULTS.MEMBER_LIMIT,
        min: 1,
        max: CLASS_DEFAULTS.MAX_MEMBER_LIMIT,
        allowDefault: false,
        save: async (value) => {
          if (value !== null) await opts.api.setMemberLimit(c.id, value);
        },
        returnFocus: () => host.menuTriggerEl(key),
      });
      if (saved === undefined || saved === null || host.disposed()) return;
      classes = (classes ?? []).map((x) => (x.id === c.id ? { ...x, memberLimit: saved } : x));
      render();
      toast({ tone: "success", text: T().admMemberLimitSaved(c.name, fmtInt(saved)) });
    } catch (err: unknown) {
      host.showActionError(err);
    }
  }

  async function setArchived(c: AdminClass, archived: boolean): Promise<void> {
    busy.add(c.id);
    render();
    try {
      await opts.api.setArchived(c.id, archived);
      if (host.disposed()) return;
      classes = (classes ?? []).map((x) => (x.id === c.id ? { ...x, status: archived ? "archived" : "active" } : x));
      toast({ tone: "success", text: archived ? T().admClassArchived(c.name) : T().admClassRestored(c.name) });
    } catch (err: unknown) {
      host.showActionError(err);
    } finally {
      busy.delete(c.id);
      render();
    }
  }

  function actionsMenu(c: AdminClass): HTMLButtonElement {
    const key = `class:${c.id}`;
    return host.menuButton(T().admClassActionsFor(c.name), key, () => [
      { label: T().admOpenClassManage, run: () => void (location.hash = `#/class/${encodeURIComponent(c.id)}/manage`) },
      { label: T().admSetMemberLimitItem, run: () => void editLimit(c) },
      c.status === "active"
        ? {
            label: T().admArchiveClass,
            tone: "danger",
            run: () =>
              void host
                .askConfirm({
                  title: T().admArchiveClassTitle(c.name),
                  body: T().admArchiveClassBody,
                  confirmLabel: T().admArchiveClassConfirm,
                  tone: "danger",
                  returnFocus: () => host.menuTriggerEl(key),
                })
                .then((ok) => {
                  if (ok) void setArchived(c, true);
                }),
          }
        : { label: T().admRestoreClass, run: () => void setArchived(c, false) },
    ]);
  }

  const table = dataTable<AdminClass>({
    columns: [
      {
        id: "name",
        header: T().admColClass,
        rowHeader: true,
        className: "col-name",
        cell: (c) => h("a", { href: `#/class/${encodeURIComponent(c.id)}/manage`, class: "owner-class-link", dir: "auto" }, c.name),
        sortValue: (c) => c.name,
        csv: (c) => c.name,
      },
      { id: "owner", header: T().admColOwner, cell: (c) => h("span", { class: c.ownerId === "admin" || c.ownerName === null ? "muted" : "player-name", dir: "auto" }, ownerText(c)), sortValue: ownerText, csv: ownerText },
      {
        id: "members",
        header: T().admColMembers,
        numeric: true,
        cell: (c) => h("span", { class: c.members >= c.memberLimit ? "is-full" : "" }, T().admOfLimit(fmtInt(c.members), fmtInt(c.memberLimit))),
        sortValue: (c) => c.members,
        sortFirst: "desc",
        csv: (c) => `${c.members}/${c.memberLimit}`,
      },
      {
        id: "status",
        header: T().admColStatus,
        cell: (c) => h("span", { class: `status-pill is-class-${c.status}` }, T().admClassStatus(c.status)),
        sortValue: (c) => c.status,
        csv: (c) => c.status,
      },
      { id: "event", header: T().admColEvent, cell: eventCell, sortValue: (c) => ms(c.event?.startsAt ?? null), csv: (c) => c.event?.name ?? "" },
      { id: "created", header: T().admColCreated, optional: true, className: "col-seen muted", cell: (c) => formatDateTime(c.createdAt), sortValue: (c) => ms(c.createdAt), sortFirst: "desc" },
      { id: "actions", header: T().admColActions, headerHidden: true, className: "col-actions", cell: (c) => actionsMenu(c) },
    ],
    rows: [],
    rowKey: (c) => c.id,
    rowSig: (c) => JSON.stringify([getLang(), c, busy.has(c.id), eventPhase(c, now), relativeIn(c.event?.startsAt ?? null, now)]),
    rowAttrs: (c) => ({ class: `owner-class-row is-${c.status}`, "data-id": c.id }),
    className: "admin-table owner-class-table",
    wrapClass: "admin-dt",
    labelledBy: "admin-classes-title",
    stackOnPhone: true,
  });

  function mount(panel: HTMLElement): void {
    setChildren(
      panel,
      h(
        "section",
        { class: "panel admin-panel owner-classes-panel", "aria-labelledby": "admin-classes-title" },
        h(
          "div",
          { class: "admin-table-head" },
          headWithHint(h("h2", { class: "admin-h2", id: "admin-classes-title" }, T().admClassesTitle, " ", countEl), T().admClassesHint),
          h("div", { class: "admin-controls" }, searchInput),
        ),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admClassesHint),
        bodyEl,
      ),
    );
    render();
  }

  function render(): void {
    now = Date.now();
    if (classes === null) {
      countEl.textContent = "";
      setChildren(bodyEl, h("p", { class: error ? "admin-error" : "muted admin-empty-small" }, error ?? T().admLoading));
      return;
    }
    const q = search.trim().toLowerCase();
    const shown = q === "" ? classes : classes.filter((c) => `${c.name} ${ownerText(c)}`.toLowerCase().includes(q));
    countEl.textContent = `(${shown.length === classes.length ? fmtInt(classes.length) : T().admShownOf(fmtInt(shown.length), fmtInt(classes.length))})`;
    if (classes.length === 0) {
      setChildren(bodyEl, h("p", { class: "muted admin-empty-small" }, T().admClassesEmpty));
      return;
    }
    if (shown.length === 0) {
      setChildren(bodyEl, h("p", { class: "muted admin-empty-small" }, T().admClassesNoMatch));
      return;
    }
    table.update(shown);
    if (table.element.parentNode !== bodyEl) setChildren(bodyEl, table.element);
  }

  async function load(): Promise<void> {
    try {
      classes = await opts.api.list();
      error = null;
    } catch (err: unknown) {
      if (host.handleAuthError(err)) return;
      error = T().admActionFailed(err instanceof Error ? err.message : String(err));
    }
    if (!host.disposed()) render();
  }

  return { mount, load, render };
}
