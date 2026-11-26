// Sign in / sign up, the "waiting for approval" screen and the forced password change.
// `withApprovedAccount` is the single gate every playable view goes through.
import { formField, type FormField } from "../components/formLayout";
import { PasswordSchema, UsernameSchema, type AccountView } from "../../shared/contract";
import { ApiError, changePassword, login, register } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import "../player.css";
import { getLang, isRelabel } from "../i18n/i18n";
import { isAdmin, loadAccount, setAccount, signOut } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";

const PENDING_POLL_MS = 8_000;
/** How long "Password changed" stays on screen before the gate moves on. */
const CONFIRM_MS = 1_500;
let pendingTimer: number | null = null;
let pendingVisibility: (() => void) | null = null;
let rateTimer: number | null = null;
let doneTimer: number | null = null;

/**
 * The temporary password the player just signed in with, kept in memory only (never stored), so the
 * forced "set a new password" screen doesn't ask for it again (WCAG 3.3.7). Cleared once used or on sign-out.
 */
let carriedTempPassword: string | null = null;

export function stopAuthTimers(): void {
  if (pendingTimer !== null) window.clearInterval(pendingTimer);
  pendingTimer = null;
  if (pendingVisibility !== null) document.removeEventListener("visibilitychange", pendingVisibility);
  pendingVisibility = null;
  if (rateTimer !== null) window.clearInterval(rateTimer);
  rateTimer = null;
  if (doneTimer !== null) window.clearTimeout(doneTimer);
  doneTimer = null;
}

type Mode = "sign-in" | "sign-up";

/**
 * What the player had typed into a gate form, captured when the language switch re-renders the route, so
 * EN/עב re-labels the form instead of wiping it. Kept in memory for that one re-render only.
 */
type Draft = { values: ReadonlyMap<string, string>; focusId: string | null; mode: Mode | null };
let draft: Draft | null = null;

function captureDraft(root: HTMLElement): Draft | null {
  const form = root.querySelector("form");
  if (form === null) return null;
  const values = new Map<string, string>();
  for (const input of form.querySelectorAll("input")) if (input.id !== "" && input.value !== "") values.set(input.id, input.value);
  const active = document.activeElement;
  const mode = form.dataset.mode;
  return {
    values,
    focusId: active instanceof HTMLInputElement && form.contains(active) ? active.id : null,
    mode: mode === "sign-in" || mode === "sign-up" ? mode : null,
  };
}

/**
 * Put a captured draft back into a freshly rendered form (once). Returns true when it restored one, so the
 * caller keeps focus where it was (on the language toggle, or the field being typed in) instead of moving it.
 */
function restoreDraft(form: HTMLElement): boolean {
  const saved = draft;
  draft = null;
  if (saved === null) return false;
  for (const input of form.querySelectorAll("input")) {
    const value = saved.values.get(input.id);
    if (value !== undefined) input.value = value;
  }
  if (saved.focusId !== null) form.querySelector<HTMLInputElement>(`#${CSS.escape(saved.focusId)}`)?.focus();
  return true;
}

export type GateOptions = {
  /** What the instructor's session sees (default: the "sign in as a player" card). */
  onAdmin?: () => void;
  /** The form shown when signed out (default: sign in). */
  signedOutMode?: Mode;
  /** Class code from a `?code=` link: prefills the sign-up form's class-code field. */
  inviteCode?: string;
  /** Set `document.title` for the auth screens (the #/login and #/signup routes). */
  titled?: boolean;
  /** Heading of the sign-in form when this gate guards a specific page (e.g. "Sign in to see your stats"). */
  signInTitle?: string;
};

const pageTitle = (title: string): string => `${title} · IncidentLab`;

/** Send the instructor's session to the admin panel (re-renders when already there). */
export function goToAdmin(): void {
  if (window.location.hash === "#/admin") window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = "#/admin";
}

const timeFmt = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(getLang() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Resolves the signed-in account and calls `onReady` once it is an approved player with a usable password.
 * Otherwise renders the sign-in form, the pending screen (polls until approved), the rejected screen, the
 * "set a new password" form, or (for the instructor's session) the "sign in as a player" card into `root`.
 */
export function withApprovedAccount(
  root: HTMLElement,
  context: string,
  onReady: (account: AccountView) => void,
  options: GateOptions = {},
): void {
  stopAuthTimers();
  const again = (): void => withApprovedAccount(root, context, onReady, options);
  // A language switch re-renders this route: keep what was typed (the loading card below would wipe it).
  draft = isRelabel() ? captureDraft(root) : null;
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, T().loading)));
  loadAccount()
    .then((account) => {
      if (account === null) {
        carriedTempPassword = null;
        renderAuthForm(root, {
          context,
          mode: draft?.mode ?? options.signedOutMode ?? "sign-in",
          onSignedIn: again,
          inviteCode: options.inviteCode,
          titled: options.titled,
          signInTitle: options.signInTitle,
        });
      } else if (isAdmin(account)) (options.onAdmin ?? (() => renderAdminCard(root, again)))();
      else if (account.status === "pending") renderPending(root, account, again);
      else if (account.status === "rejected") renderRejected(root, account.username, again);
      else if (account.mustChangePassword) renderForcedPasswordChange(root, context, again);
      else {
        draft = null;
        onReady(account);
      }
    })
    .catch((err: unknown) => {
      setChildren(
        root,
        h(
          "section",
          { class: "center-card", role: "alert" },
          h("h1", {}, T().cantLoadProgress),
          h("p", { class: "muted" }, errorText(err)),
          h("button", { type: "button", class: "btn btn-primary", onclick: again }, T().tryAgain),
        ),
      );
    });
}

/** User-facing text for any API failure (translated; the network error never shows the English fallback). */
function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  if (err.status === 0) return TO().offline;
  if (err.code === "username-taken") return TA().usernameTaken;
  if (err.code === "reserved") return TG().reservedName;
  if (err.code === "bad-invite-code") return TG().badInvite;
  if (err.code === "bad-credentials") return TA().badCredentials;
  if (err.code === "rejected") return TA().rejectedLogin;
  return err.message;
}

/* ================= fields, inline errors and the error summary ================= */

type Field = FormField;

/** One labelled field: label, hint, inline error, input (shared component; see components/formLayout.ts). */
function makeField(opts: { input: HTMLInputElement; label: string; help?: string; toggle?: HTMLElement }): Field {
  return formField({ input: opts.input, label: opts.label, help: opts.help, extra: opts.toggle });
}

/** A password input with a Show/Hide toggle whose name says which field it reveals ("Show new password"). */
function passwordField(opts: { id: string; name: string; label: string; autocomplete: string; help?: string }): Field {
  const input = h("input", {
    id: opts.id,
    name: opts.name,
    class: "input input-lg",
    type: "password",
    autocomplete: opts.autocomplete,
    maxlength: "128",
    required: true,
    dir: "ltr",
    enterkeyhint: "go",
  });
  // Visible text "Show"/"Hide"; the accessible name adds the field ("Show password") and still starts with
  // the visible word (WCAG 2.5.3). No aria-pressed: the changing name already carries the state.
  const toggle = h("button", { type: "button", class: "link-btn small pw-toggle", "aria-controls": opts.id, "aria-label": TO().showField(opts.label) }, TA().showPassword);
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? TA().hidePassword : TA().showPassword;
    toggle.setAttribute("aria-label", show ? TO().hideField(opts.label) : TO().showField(opts.label));
  });
  return makeField({ input, label: opts.label, help: opts.help, toggle });
}

type Problem = { field: Field | null; message: string };

/**
 * The form's error summary (GOV.UK pattern): heading + one link per problem, focused after a failed submit
 * with 2+ problems or after a server error that has no single field. One problem on one field → focus the
 * field instead. The page title gets an "Error: " prefix while errors show.
 */
function errorSummary(baseTitle: () => string): {
  el: HTMLElement;
  show: (problems: readonly Problem[]) => HTMLElement;
  clear: () => void;
} {
  const list = h("ul", { class: "error-summary-list" });
  const el = h("div", { class: "error-summary", tabindex: "-1", "aria-labelledby": "error-summary-title", hidden: true }, h("h2", { id: "error-summary-title" }, TO().errorSummaryTitle), list);
  const setTitle = (error: boolean): void => {
    document.title = error ? `${TO().errorTitlePrefix}${baseTitle()}` : baseTitle();
  };
  return {
    el,
    show: (problems) => {
      setChildren(
        list,
        problems.map((p, i) => {
          const item = h("li", { id: `error-summary-item-${i}` });
          if (p.field === null) {
            item.append(h("span", { class: "error-summary-msg" }, p.message));
          } else {
            const target = p.field.input;
            item.append(
              h(
                "a",
                {
                  href: `#${target.id}`,
                  onclick: (ev: Event) => {
                    ev.preventDefault(); // the hash is the router: never navigate
                    target.focus();
                  },
                },
                p.message,
              ),
            );
          }
          return item;
        }),
      );
      el.hidden = false;
      setTitle(true);
      return el;
    },
    clear: () => {
      el.hidden = true;
      setChildren(list);
      setTitle(false);
    },
  };
}

/** Run each field's check, in field order. */
function collectProblems(fields: readonly Field[], check: (f: Field) => string | null): Problem[] {
  const problems: Problem[] = [];
  for (const field of fields) {
    const message = check(field);
    if (message !== null) problems.push({ field, message });
  }
  return problems;
}

/**
 * Apply client-side problems: every field shows its own message; with two or more, the summary lists them
 * and takes focus; with one, focus goes to that field. Returns true when there were problems.
 */
function reportProblems(problems: readonly Problem[], fields: readonly Field[], summary: ReturnType<typeof errorSummary>): boolean {
  for (const f of fields) f.setError(problems.find((p) => p.field === f)?.message ?? null);
  if (problems.length === 0) {
    summary.clear();
    return false;
  }
  if (problems.length >= 2) summary.show(problems).focus();
  else {
    summary.clear();
    if (!document.title.startsWith(TO().errorTitlePrefix)) document.title = `${TO().errorTitlePrefix}${document.title}`;
    (problems[0]?.field?.input ?? summary.el).focus();
  }
  return true;
}

/** Busy / blocked state on the submit button: `aria-disabled` keeps focus on it (a disabled button drops focus to <body>). */
function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  if (busy) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
  button.textContent = label;
}

/* ================= sign in / sign up ================= */

export function renderAuthForm(
  root: HTMLElement,
  opts: { context: string; mode: Mode; onSignedIn: () => void; inviteCode?: string; titled?: boolean; signInTitle?: string },
): void {
  stopAuthTimers();
  const isSignUp = opts.mode === "sign-up";
  const titleText = (): string => pageTitle(isSignUp ? TA().signUpBtn : TA().signIn);
  if (opts.titled) document.title = titleText();
  const baseTitle = (): string => (opts.titled ? titleText() : document.title.replace(TO().errorTitlePrefix, ""));
  const user = makeField({
    label: TA().username,
    help: isSignUp ? TA().usernameHelp : undefined,
    input: h("input", {
      id: "auth-username",
      class: "input input-lg",
      type: "text",
      name: "username",
      autocomplete: "username",
      autocapitalize: "none",
      spellcheck: "false",
      maxlength: "24",
      required: true,
      dir: "auto",
      enterkeyhint: "next",
    }),
  });
  const pw = passwordField({
    id: "auth-password",
    name: "password",
    label: TA().password,
    autocomplete: isSignUp ? "new-password" : "current-password",
    help: isSignUp ? TA().passwordHelp : undefined,
  });
  const invite = isSignUp
    ? makeField({
        label: TG().inviteLabel,
        help: TG().inviteHelp,
        input: h("input", {
          id: "auth-invite",
          class: "input",
          type: "text",
          name: "inviteCode",
          autocomplete: "off",
          autocapitalize: "none",
          spellcheck: "false",
          maxlength: "40",
          dir: "ltr",
        }),
      })
    : null;
  const prefilled = invite !== null && opts.inviteCode !== undefined && opts.inviteCode.length > 0;
  if (invite !== null && prefilled) invite.input.value = opts.inviteCode ?? "";
  const fields: Field[] = [user, pw, ...(invite ? [invite] : [])];
  const summary = errorSummary(baseTitle);
  const submitLabel = isSignUp ? TA().signUpBtn : TA().signInBtn;
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg btn-block" }, submitLabel);
  const switchMode = h(
    "button",
    {
      type: "button",
      class: "link-btn",
      onclick: () => renderAuthForm(root, { ...opts, mode: isSignUp ? "sign-in" : "sign-up", inviteCode: invite?.input.value.trim() || opts.inviteCode }),
    },
    isSignUp ? TA().toSignIn : TA().toSignUp,
  );

  const form = h(
    "form",
    { class: "center-card gate", novalidate: true, "data-mode": opts.mode },
    summary.el,
    h("p", { class: "eyebrow" }, opts.context),
    h("h1", {}, isSignUp ? TA().authTitleSignUp : (opts.signInTitle ?? TA().authTitleSignIn)),
    h("p", { class: "muted" }, isSignUp ? TA().authHelpSignUp : TA().authHelpSignIn),
    // A class link (`?code=`) leads with the prefilled code: it is why this student skips the approval wait.
    prefilled && invite ? invite.nodes : null,
    user.nodes,
    pw.nodes,
    invite && !prefilled ? invite.nodes : null,
    submit,
    switchMode,
    isSignUp ? null : h("p", { class: "muted small auth-forgot" }, TG().forgotPassword),
  );

  /** Client checks for one field: sign-up checks the format, sign-in only that it isn't empty. */
  const check = (f: Field): string | null => {
    const value = f === user ? f.input.value.trim() : f.input.value;
    if (f === user) {
      if (value.length === 0) return TO().enterUsername;
      return isSignUp && !UsernameSchema.safeParse(value).success ? TA().usernameInvalid : null;
    }
    if (f === pw) {
      if (value.length === 0) return TO().enterPassword;
      return isSignUp && !PasswordSchema.safeParse(value).success ? TA().passwordInvalid : null;
    }
    return null;
  };
  // Never add an error while typing; clear it as soon as the value is fixed.
  for (const f of fields) {
    f.input.addEventListener("input", () => {
      // A field marked only by a form-level error (wrong credentials) is cleared as soon as it is edited.
      const markedOnly = !f.hasError() && f.input.getAttribute("aria-invalid") === "true";
      if (markedOnly || (f.hasError() && check(f) === null)) f.setError(null);
    });
  }

  let busy = false;
  let blockedUntil = 0;
  const startRateLimit = (seconds: number): void => {
    blockedUntil = Date.now() + seconds * 1000;
    setBusy(submit, true, submitLabel);
    summary.show([{ field: null, message: TO().rateLimited(seconds) }]).focus();
    const msg = summary.el.querySelector(".error-summary-msg") ?? h("span", {});
    // The countdown text updates silently (the summary is not a live region): it was read once on focus.
    rateTimer = window.setInterval(() => {
      const left = Math.ceil((blockedUntil - Date.now()) / 1000);
      if (!form.isConnected) {
        stopAuthTimers();
        return;
      }
      if (left > 0) {
        msg.textContent = TO().rateLimited(left);
        return;
      }
      msg.textContent = TO().rateLimitOver;
      setBusy(submit, false, submitLabel);
      if (rateTimer !== null) window.clearInterval(rateTimer);
      rateTimer = null;
    }, 1000);
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy || Date.now() < blockedUntil) return;
    const problems = collectProblems([user, pw], check);
    if (reportProblems(problems, fields, summary)) return;
    const credentials = { username: user.input.value.trim(), password: pw.input.value };
    busy = true;
    setBusy(submit, true, isSignUp ? TA().signingUp : TA().signingIn);
    const inviteCode = invite?.input.value.trim() ?? "";
    (isSignUp ? register(inviteCode.length > 0 ? { ...credentials, inviteCode } : credentials) : login(credentials))
      .then((account) => {
        carriedTempPassword = !isSignUp && account.mustChangePassword ? credentials.password : null;
        summary.clear();
        setAccount(account);
        if (isAdmin(account)) goToAdmin();
        else opts.onSignedIn();
      })
      .catch((err: unknown) => {
        busy = false;
        setBusy(submit, false, submitLabel);
        const code = err instanceof ApiError ? err.code : null;
        if (code === "rejected") {
          // Not an input error: say what happened and what to do next, on its own screen.
          renderRejected(root, credentials.username, () => renderAuthForm(root, opts));
          return;
        }
        if (err instanceof ApiError && err.isRateLimited) {
          startRateLimit(err.retryAfterSeconds ?? 60);
          return;
        }
        const field = code === "username-taken" || code === "reserved" ? user : code === "bad-invite-code" ? invite : null;
        if (field !== null) {
          reportProblems([{ field, message: errorText(err) }], fields, summary);
          return;
        }
        // No single field to blame: say it in the summary, and for wrong credentials mark both fields and
        // clear the password (keep the username).
        for (const f of fields) f.setError(null);
        if (code === "bad-credentials") {
          pw.input.value = "";
          summary.show([{ field: user, message: TA().badCredentials }]).focus();
          for (const f of [user, pw]) {
            f.input.setAttribute("aria-invalid", "true");
            f.input.setAttribute("aria-describedby", "error-summary-item-0");
          }
          return;
        }
        summary.show([{ field: null, message: errorText(err) }]).focus();
      });
  });

  setChildren(root, form);
  if (!restoreDraft(form)) user.input.focus();
}

/* ================= password change ================= */

/**
 * New-password form posting to /api/me/password, with a Show toggle instead of a "confirm" field.
 * `forced` = after an instructor reset: when the temporary password from this sign-in is still in memory it
 * is sent for the player, so the form asks only for the new password. Calls `onChanged` with the account.
 */
export function passwordChangeForm(opts: { forced: boolean; onChanged: (account: AccountView) => void; idPrefix?: string }): HTMLFormElement {
  const p = opts.idPrefix ?? "pw";
  const carried = opts.forced ? carriedTempPassword : null;
  const current =
    carried === null
      ? passwordField({ id: `${p}-current`, name: "current-password", label: opts.forced ? TG().currentPwForced : TG().currentPw, autocomplete: "current-password" })
      : null;
  const next = passwordField({ id: `${p}-new`, name: "new-password", label: TG().newPw, autocomplete: "new-password", help: TG().pwHelp });
  const fields: Field[] = current ? [current, next] : [next];
  const formError = h("p", { class: "form-error", role: "alert" });
  const okEl = h("p", { class: "form-ok", role: "status" });
  const submit = h("button", { type: "submit", class: `btn btn-primary${opts.forced ? " btn-lg btn-block" : ""}` }, TG().pwSave);
  const summary = errorSummary(() => document.title.replace(TO().errorTitlePrefix, ""));
  const form = h("form", { class: "pw-form", novalidate: true }, summary.el, fields.map((f) => f.nodes), formError, okEl, h("div", {}, submit));

  const check = (f: Field): string | null => {
    const value = f.input.value;
    if (f === current) return value.length === 0 ? (opts.forced ? TO().enterTempPassword : TO().enterCurrentPassword) : null;
    if (!PasswordSchema.safeParse(value).success) return TA().passwordInvalid;
    const currentValue = current?.input.value ?? carried ?? "";
    return value === currentValue ? TG().pwSame : null;
  };
  for (const f of fields) {
    f.input.addEventListener("input", () => {
      if (f.hasError() && check(f) === null) f.setError(null);
    });
  }

  let busy = false;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy) return;
    formError.textContent = "";
    okEl.textContent = "";
    const problems = collectProblems(fields, check);
    if (reportProblems(problems, fields, summary)) return;
    const currentPassword = current?.input.value ?? carried ?? "";
    busy = true;
    setBusy(submit, true, TG().pwSaving);
    changePassword({ currentPassword, newPassword: next.input.value })
      .then((account) => {
        busy = false;
        setBusy(submit, false, TG().pwSave);
        carriedTempPassword = null;
        form.reset();
        okEl.textContent = opts.forced ? TO().pwChangedContinue : TG().pwSaved;
        opts.onChanged(account);
      })
      .catch((err: unknown) => {
        busy = false;
        setBusy(submit, false, TG().pwSave);
        const wrongCurrent = err instanceof ApiError && err.code === "bad-credentials";
        if (wrongCurrent && current !== null) {
          reportProblems([{ field: current, message: TG().pwWrongCurrent }], fields, summary);
          return;
        }
        if (wrongCurrent) carriedTempPassword = null; // the carried password no longer works: ask for it next time
        formError.textContent = wrongCurrent ? TG().pwWrongCurrent : errorText(err);
        submit.focus();
      });
  });
  return form;
}

function renderForcedPasswordChange(root: HTMLElement, context: string, onDone: () => void): void {
  document.title = pageTitle(TG().pwTitleForced);
  const carried = carriedTempPassword !== null;
  const form = passwordChangeForm({
    forced: true,
    idPrefix: "forced-pw",
    onChanged: (account) => {
      // Keep "Password changed" on screen (and announced) for a moment before the gate moves on.
      setChildren(form, h("p", { class: "form-ok", role: "status" }, TO().pwChangedContinue));
      doneTimer = window.setTimeout(() => {
        doneTimer = null;
        setAccount(account);
        onDone();
      }, CONFIRM_MS);
    },
  });
  setChildren(
    root,
    h(
      "section",
      { class: "center-card gate" },
      h("p", { class: "eyebrow" }, context),
      h("h1", {}, TG().pwTitleForced),
      h("p", { class: "muted" }, carried ? TO().pwHelpForcedCarried : TG().pwHelpForced),
      form,
      h(
        "button",
        {
          type: "button",
          class: "link-btn",
          onclick: () => {
            carriedTempPassword = null;
            void signOut().finally(onDone);
          },
        },
        TA().signOut,
      ),
    ),
  );
  if (!restoreDraft(form)) form.querySelector("input")?.focus();
}

/* ================= other gate screens ================= */

function renderAdminCard(root: HTMLElement, onSignedOut: () => void): void {
  setChildren(
    root,
    h(
      "section",
      { class: "center-card" },
      h("p", { class: "eyebrow" }, "admin"),
      h("h1", {}, TG().adminTitle),
      h("p", { class: "muted" }, TG().adminBody),
      h(
        "div",
        { class: "row-center" },
        h("a", { class: "btn btn-primary", href: "#/admin" }, TG().openAdmin),
        h("button", { type: "button", class: "btn", onclick: () => void signOut().finally(onSignedOut) }, TA().signOut),
      ),
    ),
  );
}

/**
 * Waiting for the instructor. Polls quietly (paused while the tab is hidden) and shows a muted
 * "Last checked" time that is NOT a live region; the polite status region speaks only when the state
 * changes (approved, or not approved).
 */
function renderPending(root: HTMLElement, account: AccountView, onApproved: () => void): void {
  stopAuthTimers();
  document.title = pageTitle(TA().pendingTitle);
  const status = h("p", { class: "pending-status", role: "status" });
  const lastChecked = h("p", { class: "muted small pending-checked" });
  let checking = false;
  const check = (): void => {
    if (checking) return;
    checking = true;
    loadAccount(true)
      .then((fresh) => {
        lastChecked.textContent = TO().pendingLastChecked(timeFmt().format(new Date()));
        if (fresh !== null && fresh.status === "pending") return;
        stopAuthTimers();
        if (fresh === null) {
          onApproved(); // the session ended: the gate shows the sign-in form
          return;
        }
        if (fresh.status === "rejected") {
          renderRejected(root, fresh.username, onApproved);
          return;
        }
        status.textContent = TO().pendingApproved;
        doneTimer = window.setTimeout(() => {
          doneTimer = null;
          onApproved();
        }, CONFIRM_MS);
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  };
  const start = (): void => {
    if (pendingTimer !== null) window.clearInterval(pendingTimer);
    pendingTimer = document.hidden ? null : window.setInterval(check, PENDING_POLL_MS);
  };
  pendingVisibility = (): void => {
    if (!root.isConnected) return;
    start();
    if (!document.hidden) check(); // back on the tab: look right away
  };
  setChildren(
    root,
    h(
      "section",
      { class: "center-card" },
      h("p", { class: "pending-icon", "aria-hidden": "true" }, "⏳"),
      h("h1", {}, TA().pendingTitle),
      h("p", {}, TO().pendingHi, h("bdi", {}, account.username), "!"),
      h("p", { class: "muted" }, TO().pendingBody),
      h(
        "div",
        { class: "row-center" },
        h("button", { type: "button", class: "btn", onclick: check }, TA().pendingCheckNow),
        h("button", { type: "button", class: "link-btn", onclick: () => void signOut().finally(onApproved) }, TA().signOut),
      ),
      lastChecked,
      status,
    ),
  );
  document.addEventListener("visibilitychange", pendingVisibility);
  start();
}

/**
 * The instructor rejected this account: reached from a session (`/api/me` says "rejected") or from a sign-in
 * attempt. Offers a new account (primary) and a way back. `onBack` re-runs the gate after signing out.
 */
function renderRejected(root: HTMLElement, username: string, onBack: () => void): void {
  stopAuthTimers();
  document.title = pageTitle(TA().rejectedTitle);
  const title = h("h1", { tabindex: "-1" }, TA().rejectedTitle);
  const leave = (then: () => void): void => void signOut().catch(() => undefined).finally(then);
  setChildren(
    root,
    h(
      "section",
      { class: "center-card" },
      title,
      h("p", { class: "muted" }, TO().rejectedLead, h("bdi", {}, username), TO().rejectedTail),
      h(
        "div",
        { class: "row-center" },
        h("button", { type: "button", class: "btn btn-primary", onclick: () => leave(() => (window.location.hash = "#/signup")) }, TO().createNewAccount),
        h("button", { type: "button", class: "btn", onclick: () => leave(onBack) }, TO().backToSignIn),
      ),
    ),
  );
  // A final state: move focus to the heading so it is read once (no role=alert on the whole card).
  title.focus();
}
