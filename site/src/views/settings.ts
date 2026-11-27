// The settings page (#219): #/settings/{account,security,privacy,display}. One h1 ("Settings"), the section list in
// the page panel (an inline segmented list up to 1024px, where the panel would be a Sheet), and one section on
// screen. Password, recovery code and the global-board switch moved here from My stats; Display draws the same
// radio groups as the ⚙ panel (shell/settingsMenu.ts) over the same stored settings (shell/settings.ts), so the
// two stay in step. Display works signed out; the other sections run the account gate.
import type { AccountView, ClassSummary } from "../../shared/contract";
import { getLang, locale } from "../i18n/i18n";
import { TA } from "../i18n/strings-account";
import { TB } from "../i18n/strings-board";
import { TC } from "../i18n/strings-challenges";
import { TG } from "../i18n/strings-game";
import { TGu } from "../i18n/strings-guest";
import { T } from "../i18n/strings-player";
import { TSe, settingsSectionLabel } from "../i18n/strings-settings";
import { TS } from "../i18n/strings-shell";
import { ApiError, setBoardVisibility } from "../lib/api";
import { fetchMyClasses } from "../lib/class-api";
import { classRoleKind, type ClassRoleKind } from "../lib/challenges";
import { h, setChildren, type Child } from "../lib/dom";
import { toast } from "../lib/overlay";
import { cachedAccount, isAdmin, isGuest, loadAccount, setAccount, signOut } from "../lib/session";
import { SETTINGS_SECTIONS, settingsHref, type SettingsSection } from "../lib/settings-route";
import { confirmGuestSignOut } from "../shell/frame";
import { switchLang } from "../shell/lang";
import { loadSettings, onSettingsChange } from "../shell/settings";
import { displayGroups, renderSettingGroup, type SettingGroup } from "../shell/settingsMenu";
import type { ViewResult } from "../shell/types";
import { passwordChangeForm, recoveryCodeSection, withApprovedAccount } from "./auth";
import { openUpgradeDialog } from "./guest";
import "../player.css";
import "../settings.css";

/** The radios on this page are named `page-set-*`, apart from the ⚙ panel's `set-*` (both can be in the DOM). */
const NAME_PREFIX = "page-set";

const sectionLabel = settingsSectionLabel;

/** The short label for the phone list, where four items share one row. */
function shortLabel(section: SettingsSection): string {
  return section === "display" ? TSe().displayShort : sectionLabel(section);
}

/** Which sections an account has: guests have no password, and the instructor's session only an account and a display. */
function sectionsFor(account: AccountView | null): readonly SettingsSection[] {
  if (account === null || isAdmin(account)) return ["account", "display"];
  if (isGuest(account)) return ["account", "privacy", "display"];
  return SETTINGS_SECTIONS;
}

function sectionLinks(current: SettingsSection, account: AccountView | null, short: boolean): HTMLElement[] {
  return sectionsFor(account).map((s) =>
    h(
      "li",
      {},
      h("a", { class: "settings-nav-link", href: settingsHref(s), "aria-current": s === current ? "page" : null }, short ? shortLabel(s) : sectionLabel(s)),
    ),
  );
}

/* ---------- shared parts ---------- */

/** The guest's "Create account" card: the same upgrade dialog as the guest banner (views/guest.ts). */
function createAccountCard(): HTMLElement {
  return h(
    "section",
    { class: "settings-card settings-upgrade", "aria-labelledby": "settings-upgrade-h" },
    h("div", { class: "settings-upgrade-text" }, h("h3", { id: "settings-upgrade-h", class: "settings-card-title" }, TC().guestTitle), h("p", { class: "muted small" }, TC().upgradeNote)),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => openUpgradeDialog() }, TGu().createAccount),
  );
}

function card(id: string, title: string, ...body: Child[]): HTMLElement {
  return h("section", { class: "settings-card", "aria-labelledby": id }, h("h3", { id, class: "settings-card-title" }, title), ...body);
}

/* ---------- Account ---------- */

const roleText = (kind: ClassRoleKind): string =>
  kind === "owner" ? TC().roleOwner : kind === "admin" ? TC().roleAdmin : kind === "member" ? TC().roleMember : TC().rolePending;

function accountRole(account: AccountView): string {
  if (isGuest(account)) return TSe().kindGuest;
  if (isAdmin(account)) return TS().roleAdmin;
  return account.role === "author" ? TS().roleAuthor : TS().rolePlayer;
}

/** Your classes with your role in each (GET /api/classes). Loading, empty and failed states keep their place. */
function classesCard(): HTMLElement {
  const body = h("div", { class: "settings-classes-body" });
  const load = (): void => {
    setChildren(body, h("p", { class: "muted small", role: "status" }, TSe().classesLoading));
    fetchMyClasses()
      .then((all) => {
        const classes = all.filter((c: ClassSummary) => c.status === "active" && c.membership !== null);
        if (classes.length === 0) {
          setChildren(body, h("p", { class: "muted small" }, TC().statsClassesEmpty), h("a", { class: "small", href: "#/classes" }, TC().allClasses));
          return;
        }
        setChildren(
          body,
          h(
            "ul",
            { class: "settings-classes" },
            classes.map((c) =>
              h(
                "li",
                { class: "settings-class" },
                h("a", { href: `#/class/${encodeURIComponent(c.id)}` }, h("bdi", {}, c.name)),
                h("span", { class: "muted small" }, roleText(classRoleKind(c))),
              ),
            ),
          ),
          h("a", { class: "small", href: "#/classes" }, TC().allClasses),
        );
      })
      .catch(() => {
        setChildren(body, h("div", { role: "alert" }, h("p", { class: "small" }, TC().classesFailed), h("button", { type: "button", class: "btn btn-sm", onclick: load }, T().tryAgain)));
      });
  };
  load();
  return card("settings-classes-h", TSe().classesTitle, body);
}

function signOutCard(account: AccountView): HTMLElement {
  const guest = isGuest(account);
  // finally, not then: offline sign-out still clears the local account, so leave the signed-in page too
  const leave = (): void => void signOut().catch(() => undefined).finally(() => (window.location.hash = "#/"));
  const button = h("button", { type: "button", class: "btn" }, TA().signOut);
  button.addEventListener("click", () => {
    if (!guest) return leave();
    // A guest who signs out can never get back in (#176): the same confirm as the account menu.
    void confirmGuestSignOut().then((yes) => {
      if (yes) leave();
    });
  });
  return card("settings-session-h", TSe().sessionTitle, h("p", { class: "muted small" }, guest ? TSe().guestSignOutNote : TSe().signOutNote), h("div", {}, button));
}

function accountSection(account: AccountView): Child[] {
  const since = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(account.createdAt));
  const name = isGuest(account) ? TGu().guestName : account.username;
  const pair = (label: string, value: Child): HTMLElement => h("div", { class: "settings-pair" }, h("dt", {}, label), h("dd", {}, value));
  const admin = isAdmin(account);
  return [
    isGuest(account) ? createAccountCard() : null,
    h(
      "section",
      { class: "settings-card", "aria-labelledby": "settings-who-h" },
      h("h3", { id: "settings-who-h", class: "visually-hidden" }, TSe().account),
      h(
        "dl",
        { class: "settings-details" },
        pair(TSe().username, [h("bdi", { class: "settings-username" }, name), isGuest(account) ? null : h("span", { class: "muted small settings-note" }, TSe().usernameNote)]),
        pair(TSe().role, accountRole(account)),
        admin ? null : pair(TSe().kind, isGuest(account) ? TSe().kindGuest : TSe().kindUser),
        admin ? null : pair(TSe().memberSince, since),
      ),
      admin ? h("p", { class: "muted small" }, TSe().adminNote) : null,
    ),
    admin ? null : isGuest(account) ? card("settings-classes-h", TSe().classesTitle, h("p", { class: "muted small" }, TC().statsClassesGuest)) : classesCard(),
    signOutCard(account),
  ];
}

/* ---------- Security ---------- */

function securitySection(account: AccountView): Child[] {
  if (isAdmin(account)) return [h("p", { class: "muted" }, TSe().adminNote)];
  // Password and recovery code are for accounts only (#207): a guest has neither, and gets the upgrade card.
  if (account.kind !== "user") return [createAccountCard(), h("p", { class: "muted small" }, TSe().guestSecurity)];
  return [
    card("settings-pw-h", TG().pwTitle, passwordChangeForm({ forced: false, idPrefix: "settings-pw", onChanged: (changed) => setAccount(changed) })),
    h("div", { class: "settings-card" }, recoveryCodeSection(account.username)),
  ];
}

/* ---------- Privacy ---------- */

/**
 * The opt-in switch for the public global leaderboard (#175), off by default, with what turning it on makes
 * public. A native checkbox with role="switch", so it keeps the keyboard, label and form behaviour.
 */
function boardCard(account: AccountView): HTMLElement {
  const input = h("input", { id: "settings-board", type: "checkbox", role: "switch", class: "switch", "aria-describedby": "settings-board-note" });
  input.checked = account.showOnGlobalBoard;
  let busy = false;
  input.addEventListener("change", () => {
    const show = input.checked;
    if (busy) {
      input.checked = !show; // one change at a time
      return;
    }
    busy = true;
    input.setAttribute("aria-busy", "true");
    setBoardVisibility(show)
      .then((updated) => {
        toast({ tone: "success", text: show ? TB().shownToast : TB().hiddenToast });
        setAccount(updated);
      })
      .catch((err: unknown) => {
        input.checked = !show;
        toast({ tone: "error", text: err instanceof ApiError ? err.message : TB().saveFailed });
      })
      .finally(() => {
        busy = false;
        input.removeAttribute("aria-busy");
      });
  });
  return card(
    "settings-board-h",
    TB().sectionTitle,
    h("label", { class: "check settings-switch", for: "settings-board" }, input, h("span", {}, TB().switchLabel)),
    h("p", { id: "settings-board-note", class: "muted small settings-note" }, TB().privacyNote),
    h("a", { class: "small", href: "#/leaderboard" }, TC().openLeaderboard),
  );
}

function privacySection(account: AccountView): Child[] {
  if (isAdmin(account)) return [h("p", { class: "muted" }, TSe().adminNote)];
  if (account.kind !== "user") return [card("settings-board-h", TB().sectionTitle, h("p", { class: "muted small" }, TB().guestNote))];
  return [
    boardCard(account),
    card("settings-classboards-h", TSe().classBoardsTitle, h("p", { class: "muted small settings-note" }, TSe().classBoardsNote), h("a", { class: "small", href: "#/classes" }, TSe().openClasses)),
  ];
}

/* ---------- Display ---------- */

/** Set when the language radio switched the language: the re-rendered page puts focus back on it. */
let refocusLang = false;
/** Redraws the Display section on screen when the ⚙ panel changes a setting (one listener for the page's lifetime). */
let redrawDisplay: (() => void) | null = null;
onSettingsChange(() => redrawDisplay?.());

function languageGroup(): SettingGroup {
  return {
    name: "lang",
    legend: TSe().language,
    options: [
      { value: "en", label: "English", lang: "en" },
      { value: "he", label: "עברית", lang: "he" },
    ],
    current: getLang(),
    apply: (v) => {
      if (v !== "en" && v !== "he") return;
      refocusLang = true;
      switchLang(v, null);
    },
  };
}

function displaySection(): HTMLElement {
  const groups = h("div", { class: "settings-groups" });
  const draw = (): void => {
    const focused = document.activeElement;
    const focusName = focused instanceof HTMLInputElement && groups.contains(focused) ? focused.name : null;
    setChildren(groups, [languageGroup(), ...displayGroups(loadSettings())].map((g) => renderSettingGroup(g, NAME_PREFIX)));
    if (focusName !== null) groups.querySelector<HTMLInputElement>(`input[name="${CSS.escape(focusName)}"]:checked`)?.focus();
  };
  draw();
  redrawDisplay = (): void => {
    if (!groups.isConnected) {
      redrawDisplay = null;
      return;
    }
    // the radios already show a change made here; only resync when the ⚙ panel made it
    if (!groups.contains(document.activeElement)) draw();
  };
  if (refocusLang) {
    refocusLang = false;
    queueMicrotask(() => groups.querySelector<HTMLInputElement>(`input[name="${NAME_PREFIX}-lang"]:checked`)?.focus());
  }
  return h(
    "div",
    { class: "settings-card" },
    groups,
    h("a", { class: "small", href: "/accessibility.html" }, TS().a11yStatement),
  );
}

/* ---------- the view ---------- */

function intro(section: SettingsSection): string {
  const t = TSe();
  return section === "account" ? t.accountIntro : section === "security" ? t.securityIntro : section === "privacy" ? t.privacyIntro : t.displayIntro;
}

export function settingsView(section: SettingsSection): ViewResult {
  const main = h("div", { class: "view" });
  const asideList = h("ul", { class: "settings-nav" });
  const aside = h("div", { class: "settings-aside" }, asideList);
  const inlineList = h("ul", { class: "settings-tabs-list" });
  document.title = TSe().pageTitle(sectionLabel(section));

  const drawLists = (account: AccountView | null): void => {
    setChildren(asideList, sectionLinks(section, account, false));
    setChildren(inlineList, sectionLinks(section, account, true));
  };
  drawLists(cachedAccount());

  const drawPage = (body: Child[], account: AccountView | null): void => {
    drawLists(account);
    setChildren(
      main,
      h(
        "div",
        { class: "settings-page" },
        h("h1", {}, TSe().title),
        // Up to 1024px the page panel folds away: the sections show as one segmented row instead of behind a button.
        h("nav", { class: "settings-tabs", "aria-label": TSe().sectionsLabel }, inlineList),
        h(
          "section",
          { class: "settings-section", "aria-labelledby": "settings-section-h" },
          h("h2", { id: "settings-section-h" }, sectionLabel(section)),
          h("p", { class: "muted settings-intro" }, intro(section)),
          body,
        ),
      ),
    );
  };

  const start = (): void => {
    if (section === "display") {
      drawPage([displaySection()], cachedAccount());
      loadAccount()
        .then((account) => drawLists(account))
        .catch(() => undefined); // the list keeps the signed-out sections
      return;
    }
    const ready = (account: AccountView): void => {
      document.title = TSe().pageTitle(sectionLabel(section));
      const body = section === "account" ? accountSection(account) : section === "security" ? securitySection(account) : privacySection(account);
      drawPage(body, account);
    };
    withApprovedAccount(main, TSe().title, ready, {
      signInTitle: TSe().signInTitle,
      onAdmin: () => {
        const account = cachedAccount();
        if (account !== null) ready(account);
      },
    });
  };

  return { main, aside: { label: TSe().sectionsLabel, trigger: TSe().sectionsTrigger, content: aside }, start };
}
