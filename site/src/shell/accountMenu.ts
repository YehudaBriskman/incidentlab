// The one account menu in the top bar (#220). It replaces the EN | עב toggle, the ⚙ display panel and the old
// avatar panel. Signed in: an avatar button opens identity (name, role, class role, global-board status), Create
// account (guests, first), My stats, Settings, Language and Theme as inline radios, one "Display options…" row
// (#/settings/display) and Sign out, last and not red. Signed out: a "Language and display" button beside Sign in
// opens the same panel without identity and session.
//
// A disclosure, not role="menu": the panel mixes links, buttons and native radio fieldsets, so it is a non-modal
// role="dialog" from popover() (focus moves in, Tab walks it, Escape and light dismiss close it and focus returns
// to the button). On phones (≤640px) the same content opens as a bottom Sheet, which gets 44px rows and never clips.
// Display state has one home, shell/settings.ts; the radio groups come from shell/settingsMenu.ts, which the
// settings page draws too, so the two stay in step.
import type { AccountView, ClassSummary } from "../../shared/contract";
import { isRelabel } from "../i18n/i18n";
import { TA } from "../i18n/strings-account";
import { TB } from "../i18n/strings-board";
import { TGu } from "../i18n/strings-guest";
import { TSe } from "../i18n/strings-settings";
import { TS } from "../i18n/strings-shell";
import { fetchMyClasses } from "../lib/class-api";
import { classRoleKind } from "../lib/challenges";
import { h, html, setChildren } from "../lib/dom";
import { openSheet, popover, type DialogHandle } from "../lib/overlay";
import { cachedAccount, isAdmin, isGuest, onAccountChange, signOut } from "../lib/session";
import { settingsHref } from "../lib/settings-route";
import { confirmGuestSignOut, openGuestUpgrade } from "./frame";
import { ICONS, type IconName } from "./icons";
import { loadSettings, onSettingsChange } from "./settings";
import { languageGroup, renderSettingGroup, themeGroup } from "./settingsMenu";

/** Phones get the bottom Sheet instead of the anchored popover. */
const SHEET_MQ = "(max-width: 640px)";

/** Up to two initials from a username ("ada_lovelace" -> "AL", "dana" -> "DA"). */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter((w) => w.length > 0);
  const letters = words.length >= 2 ? [words[0], words[1]].map((w) => [...(w ?? "")][0] ?? "") : [...(words[0] ?? name)].slice(0, 2);
  return letters.join("").toUpperCase();
}

const icon = (name: IconName, cls = "account-item-icon"): HTMLElement => html("span", { class: cls, "aria-hidden": "true" }, ICONS[name]);

/* ---------- the class-role line (GET /api/classes once per account, on first open) ---------- */

type ClassLine = { forAccount: string; text: string | null };
let classLine: ClassLine | null = null;
let classLineLoading: string | null = null;

/** The strongest class role, counted: "Owner of 2 classes", else co-admin, else member. Null without classes. */
export function classRoleLine(classes: readonly ClassSummary[]): string | null {
  const active = classes.filter((c) => c.status === "active" && c.membership !== null);
  const count = (kind: string): number => active.filter((c) => classRoleKind(c) === kind).length;
  const owner = count("owner");
  if (owner > 0) return TS().classOwnerOf(owner);
  const admin = count("admin");
  if (admin > 0) return TS().classAdminOf(admin);
  const member = count("member");
  return member > 0 ? TS().classMemberOf(member) : null;
}

/** Only full, approved player accounts can be in classes (guests can't join; the owner has no memberships). */
const hasClasses = (a: AccountView): boolean => a.kind === "user" && a.status === "approved" && !isAdmin(a) && !a.mustChangePassword;

/** Loads the class line for `account` once; `done` redraws the open panel when it arrives. */
function ensureClassLine(account: AccountView, done: () => void): void {
  if (!hasClasses(account) || classLine?.forAccount === account.id || classLineLoading === account.id) return;
  classLineLoading = account.id;
  fetchMyClasses()
    .then((classes) => {
      classLine = { forAccount: account.id, text: classRoleLine(classes) };
    })
    .catch(() => {
      classLine = { forAccount: account.id, text: null }; // the line is a nicety: no error state in a menu
    })
    .finally(() => {
      classLineLoading = null;
      done();
    });
}

/* ---------- the panel content (shared by the popover and the sheet) ---------- */

interface MenuParts {
  /** Closes whichever surface is open (before a dialog opens, or after a link is followed). */
  close: () => void;
  /** Radio names are prefixed per surface, so the popover's and the sheet's groups never join. */
  prefix: string;
}

function identityHeader(account: AccountView): HTMLElement {
  const guest = isGuest(account);
  const name = guest ? TGu().guestName : account.username;
  const role = guest ? TGu().guestRole : isAdmin(account) ? TS().roleAdmin : account.role === "author" ? TS().roleAuthor : TS().rolePlayer;
  const board = account.kind === "user" && !isAdmin(account) && account.status === "approved" ? (account.showOnGlobalBoard ? TB().menuShown : TB().menuHidden) : null;
  const classes = classLine?.forAccount === account.id ? classLine.text : null;
  // The header is the link to the account settings (as in GitHub, Linear and Liba): name, role and status in one target.
  return h(
    "a",
    { class: "account-head", href: settingsHref("account") },
    h("span", { class: "avatar is-lg", "aria-hidden": "true" }, initials(name)),
    h(
      "span",
      { class: "account-who" },
      h("bdi", { class: "account-name" }, name),
      h("span", { class: "account-role" }, role),
      classes !== null ? h("span", { class: "account-role account-classes" }, classes) : null,
      board !== null ? h("span", { class: "account-role account-board" }, board) : null,
    ),
    icon("chevron", "account-head-chevron"),
  );
}

function linkRow(href: string, iconName: IconName, label: string): HTMLLIElement {
  return h("li", {}, h("a", { class: "account-item", href }, icon(iconName), h("span", {}, label)));
}

/** Language and theme as two inline segmented radio groups, then the link to the rest of the display settings. */
function prefsBlock(prefix: string): HTMLElement {
  const theme = themeGroup(loadSettings());
  return h(
    "div",
    { class: "account-prefs" },
    renderSettingGroup(languageGroup(TSe().language), prefix),
    theme === undefined ? null : renderSettingGroup(theme, prefix),
    h("ul", { class: "account-items" }, linkRow(settingsHref("display"), "type", TS().menuDisplayOptions)),
  );
}

function signOutRow(account: AccountView, parts: MenuParts): HTMLLIElement {
  const guest = isGuest(account);
  // finally, not then: offline sign-out still clears the local account, so leave the signed-in page too
  const leave = (): void => void signOut().catch(() => undefined).finally(() => (window.location.hash = "#/"));
  // Not red: signing out is ordinary and reversible (red is for what destroys data). A guest's is not reversible,
  // so the guest gets the "you can't come back" confirm (#176) instead.
  const out = h("button", { type: "button", class: "account-item account-signout" }, icon("signOut", "account-item-icon is-mirrored"), h("span", {}, TA().signOut));
  out.addEventListener("click", () => {
    parts.close();
    if (!guest) return leave();
    void confirmGuestSignOut().then((yes) => {
      if (yes) leave();
    });
  });
  return h("li", {}, out);
}

function footer(): HTMLElement {
  return h("a", { class: "account-foot", href: "/accessibility.html" }, TS().a11yStatement);
}

/** What the panel shows for `account` (null: signed out, the preferences only). */
export function menuContent(account: AccountView | null, parts: MenuParts): HTMLElement[] {
  if (account === null) return [prefsBlock(parts.prefix), footer()];
  const guest = isGuest(account);
  const showStats = !isAdmin(account) && account.status === "approved" && !account.mustChangePassword;
  const upgrade = h("button", { type: "button", class: "btn btn-primary btn-sm account-upgrade" }, TGu().createAccount);
  upgrade.addEventListener("click", () => {
    parts.close();
    openGuestUpgrade();
  });
  return [
    identityHeader(account),
    guest ? h("div", { class: "account-row" }, upgrade) : null,
    h(
      "ul",
      { class: "account-items account-group" },
      showStats ? linkRow("#/me", "stats", TA().myStats) : null,
      linkRow(settingsHref("account"), "gear", TSe().menuSettings),
    ),
    prefsBlock(parts.prefix),
    h("ul", { class: "account-items account-group" }, signOutRow(account, parts)),
    footer(),
  ].filter((el): el is HTMLElement => el !== null);
}

/* ---------- the top-bar control ---------- */

/** A selector that finds the same control again after a redraw: a radio group's checked option, a link, a button. */
function focusKey(el: HTMLElement): string | null {
  if (el instanceof HTMLInputElement) return `input[name="${CSS.escape(el.name)}"]:checked`;
  if (el instanceof HTMLAnchorElement) return `a[href="${CSS.escape(el.getAttribute("href") ?? "")}"]`;
  const cls = el.classList.item(el.classList.length - 1);
  return el instanceof HTMLButtonElement && cls !== null ? `button.${CSS.escape(cls)}` : null;
}

/** The account control: the avatar button (signed in) or the preferences button and Sign in (signed out). */
export function createAccountMenu(): HTMLElement {
  const wrap = h("div", { class: "account" });
  const button = h("button", { type: "button", class: "account-btn", "aria-haspopup": "dialog" });
  const panel = h("div", { class: "account-panel", role: "dialog" });
  const signInLink = h("a", { class: "btn btn-sm btn-primary account-signin", href: "#/login" });
  let sheet: DialogHandle<string> | null = null;

  const close = (): void => {
    if (sheet !== null) sheet.close(null);
    if (control.isOpen()) control.close();
  };
  const parts = (prefix: string): MenuParts => ({ close, prefix });

  /** Redraws the content of whichever surface is open; focus stays on the same control (or its radio group). */
  const fill = (container: HTMLElement, prefix: string): void => {
    const focused = document.activeElement;
    const key = focused instanceof HTMLElement && container.contains(focused) ? focusKey(focused) : null;
    setChildren(container, menuContent(cachedAccount(), parts(prefix)));
    if (key !== null) container.querySelector<HTMLElement>(key)?.focus();
  };
  const redrawOpen = (): void => {
    if (control.isOpen()) {
      fill(panel, "menu-set");
      control.place();
    }
    if (sheet !== null) {
      const title = sheet.el.querySelector(".ov-title");
      if (title !== null) title.textContent = panelLabel();
      fill(sheet.body, "sheet-set");
    }
  };
  const panelLabel = (): string => (cachedAccount() === null ? TS().prefsButton : TS().accountPanel);

  const control = popover(button, panel, {
    align: "end",
    onOpen: () => {
      fill(panel, "menu-set");
      control.place();
      panel.querySelector<HTMLElement>("a[href], button, input:checked")?.focus();
      const account = cachedAccount();
      if (account !== null) ensureClassLine(account, redrawOpen);
    },
  });

  // Phones: the same content in a bottom Sheet. A capture listener on the button runs before popover()'s own click
  // listener (capture before bubble, also at the target), so at phone widths it stops the popover from opening.
  button.addEventListener(
    "click",
    (ev) => {
      if (!window.matchMedia(SHEET_MQ).matches) return;
      ev.stopImmediatePropagation();
      if (sheet !== null) return;
      const body = h("div", { class: "account-sheet-body" });
      fill(body, "sheet-set");
      const handle = openSheet({ side: "bottom", title: panelLabel(), body, className: "account-sheet" });
      sheet = handle;
      button.setAttribute("aria-expanded", "true");
      const done = (): void => {
        if (sheet === handle) sheet = null;
        button.setAttribute("aria-expanded", "false");
      };
      handle.result.then(done, done);
      const account = cachedAccount();
      if (account !== null) ensureClassLine(account, redrawOpen);
    },
    true,
  );

  // Following a link inside closes the surface (popover light dismiss does not run for a click inside it).
  const closeOnLink = (ev: Event): void => {
    if (ev.target instanceof Element && ev.target.closest("a[href]") !== null) close();
  };
  panel.addEventListener("click", closeOnLink);
  document.addEventListener("click", (ev) => {
    if (sheet !== null && ev.target instanceof Node && sheet.body.contains(ev.target)) closeOnLink(ev);
  });

  const draw = (): void => {
    const account = cachedAccount();
    panel.setAttribute("aria-label", panelLabel());
    button.textContent = "";
    if (account === null) {
      // Signed out: the preferences button (an icon, named "Language and display") beside Sign in.
      button.className = "account-btn is-prefs";
      button.append(icon("sliders", "icon"));
      button.setAttribute("aria-label", TS().prefsButton);
      button.title = TS().prefsButton;
      signInLink.textContent = TA().signIn;
      place(signInLink);
    } else {
      const name = isGuest(account) ? TGu().guestName : account.username;
      button.className = "account-btn";
      button.append(h("span", { class: "avatar", "aria-hidden": "true" }, initials(name)));
      // Label in Name (WCAG 2.5.3): the visible initials start the name, so "click AL" works in speech control.
      button.setAttribute("aria-label", `${initials(name)}, ${TS().accountButton(name)}`);
      button.title = name;
      place(null);
    }
    redrawOpen();
  };
  /**
   * Puts the button, the panel and (signed out) Sign in in the wrapper, touching the DOM only when that changes:
   * moving a showing popover out of the document closes it, and a language switch redraws while it is open.
   */
  const place = (extra: HTMLElement | null): void => {
    if (button.parentElement !== wrap) wrap.append(button, panel);
    if (extra !== null && extra.parentElement !== wrap) wrap.append(extra);
    if (extra === null && signInLink.parentElement === wrap) signInLink.remove();
  };
  onAccountChange(() => {
    if (classLine !== null && classLine.forAccount !== cachedAccount()?.id) classLine = null;
    // A closed (or closing, after Sign out) panel must not keep the previous account's name: it is drawn afresh on
    // open, and a fading panel then shows nothing stale.
    if (!control.isOpen()) setChildren(panel);
    draw();
  });
  // Settings changed elsewhere (the settings page): resync the open radios unless the change came from them.
  onSettingsChange(() => {
    const active = document.activeElement;
    if (!(active instanceof Node && (panel.contains(active) || (sheet?.body.contains(active) ?? false)))) redrawOpen();
  });
  window.addEventListener("hashchange", () => {
    // A navigation closes the menu (it belongs to the page it was opened on); a language switch only re-labels it.
    if (!isRelabel()) close();
    draw();
  });
  draw();
  return wrap;
}
