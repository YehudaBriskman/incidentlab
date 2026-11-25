// Sign in / sign up, the "waiting for approval" screen and the forced password change.
// `withApprovedAccount` is the single gate every playable view goes through.
import { CredentialsSchema, PasswordSchema, type AccountView } from "../../shared/contract";
import { ApiError, changePassword, login, register } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { isAdmin, loadAccount, setAccount, signOut } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";

const PENDING_POLL_MS = 8_000;
let pendingTimer: number | null = null;

export function stopAuthTimers(): void {
  if (pendingTimer !== null) window.clearInterval(pendingTimer);
  pendingTimer = null;
}

type Mode = "sign-in" | "sign-up";

/** Send the instructor's session to the admin panel (re-renders when already there). */
export function goToAdmin(): void {
  if (window.location.hash === "#/admin") window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = "#/admin";
}

/**
 * Resolves the signed-in account and calls `onReady` once it is an approved player with a usable password.
 * Otherwise renders the sign-in form, the pending screen (polls until approved), the rejected screen, the
 * "set a new password" form, or (for the instructor's session) the "sign in as a player" card into `root`.
 */
export function withApprovedAccount(
  root: HTMLElement,
  context: string,
  onReady: (account: AccountView) => void,
  options: { onAdmin?: () => void } = {},
): void {
  stopAuthTimers();
  const again = (): void => withApprovedAccount(root, context, onReady, options);
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loading)));
  loadAccount()
    .then((account) => {
      if (account === null) renderAuthForm(root, { context, mode: "sign-in", onSignedIn: again });
      else if (isAdmin(account)) (options.onAdmin ?? (() => renderAdminCard(root, again)))();
      else if (account.status === "pending") renderPending(root, account, again);
      else if (account.status === "rejected") renderRejected(root);
      else if (account.mustChangePassword) renderForcedPasswordChange(root, context, again);
      else onReady(account);
    })
    .catch((err: unknown) => {
      setChildren(
        root,
        h(
          "section",
          { class: "center-card", role: "alert" },
          h("h1", {}, T().cantLoadProgress),
          h("p", { class: "muted" }, err instanceof ApiError ? err.message : T().genericError),
          h("button", { type: "button", class: "btn btn-primary", onclick: again }, T().tryAgain),
        ),
      );
    });
}

function authErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  if (err.code === "username-taken") return TA().usernameTaken;
  if (err.code === "reserved") return TG().reservedName;
  if (err.code === "bad-invite-code") return TG().badInvite;
  if (err.code === "bad-credentials") return TA().badCredentials;
  if (err.code === "rejected") return TA().rejectedLogin;
  if (err.isRateLimited) return TA().rateLimited(err.retryAfterSeconds ?? 60);
  return err.message;
}

/** A password input with a Show/Hide toggle. */
function passwordField(opts: { id: string; label: string; autocomplete: string; help?: string }): { row: Child[]; input: HTMLInputElement } {
  const helpId = `${opts.id}-help`;
  const input = h("input", {
    id: opts.id,
    class: "input input-lg",
    type: "password",
    autocomplete: opts.autocomplete,
    maxlength: "128",
    required: true,
    dir: "ltr",
    "aria-describedby": opts.help ? helpId : null,
  });
  const toggle = h("button", { type: "button", class: "link-btn small", "aria-controls": opts.id, "aria-pressed": "false" }, TA().showPassword);
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? TA().hidePassword : TA().showPassword;
    toggle.setAttribute("aria-pressed", String(show));
  });
  return {
    input,
    row: [
      h("div", { class: "field-label-row" }, h("label", { class: "field-label", for: opts.id }, opts.label), toggle),
      input,
      opts.help ? h("p", { id: helpId, class: "muted small" }, opts.help) : null,
    ],
  };
}

export function renderAuthForm(root: HTMLElement, opts: { context: string; mode: Mode; onSignedIn: () => void }): void {
  stopAuthTimers();
  const isSignUp = opts.mode === "sign-up";
  const username = h("input", {
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
    "aria-describedby": isSignUp ? "auth-username-help" : null,
  });
  const pw = passwordField({
    id: "auth-password",
    label: TA().password,
    autocomplete: isSignUp ? "new-password" : "current-password",
    help: isSignUp ? TA().passwordHelp : undefined,
  });
  const password = pw.input;
  const invite = isSignUp
    ? h("input", {
        id: "auth-invite",
        class: "input",
        type: "text",
        name: "inviteCode",
        autocomplete: "off",
        autocapitalize: "none",
        spellcheck: "false",
        maxlength: "40",
        dir: "ltr",
        "aria-describedby": "auth-invite-help",
      })
    : null;
  const errorEl = h("p", { id: "auth-error", class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg btn-block" }, isSignUp ? TA().signUpBtn : TA().signInBtn);
  const switchMode = h(
    "button",
    { type: "button", class: "link-btn", onclick: () => renderAuthForm(root, { ...opts, mode: isSignUp ? "sign-in" : "sign-up" }) },
    isSignUp ? TA().toSignIn : TA().toSignUp,
  );

  const form = h(
    "form",
    { class: "center-card gate", novalidate: true },
    h("p", { class: "eyebrow mono" }, opts.context),
    h("h1", {}, isSignUp ? TA().authTitleSignUp : TA().authTitleSignIn),
    h("p", { class: "muted" }, isSignUp ? TA().authHelpSignUp : TA().authHelpSignIn),
    h("label", { class: "field-label", for: "auth-username" }, TA().username),
    username,
    isSignUp ? h("p", { id: "auth-username-help", class: "muted small" }, TA().usernameHelp) : null,
    pw.row,
    invite
      ? [
          h("label", { class: "field-label", for: "auth-invite" }, TG().inviteLabel),
          invite,
          h("p", { id: "auth-invite-help", class: "muted small" }, TG().inviteHelp),
        ]
      : null,
    errorEl,
    submit,
    switchMode,
    isSignUp ? null : h("p", { class: "muted small" }, TG().forgotPassword),
  );

  const fail = (message: string, field: HTMLInputElement | null): void => {
    errorEl.textContent = message;
    for (const el of [username, password, invite]) el?.removeAttribute("aria-invalid");
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const credentials = { username: username.value.trim(), password: password.value };
    if (isSignUp) {
      const parsed = CredentialsSchema.safeParse(credentials);
      if (!parsed.success) {
        const badUser = parsed.error.issues.some((i) => i.path[0] === "username");
        fail(badUser ? TA().usernameInvalid : TA().passwordInvalid, badUser ? username : password);
        return;
      }
    } else if (credentials.username.length === 0 || credentials.password.length === 0) {
      fail(TA().badCredentials, credentials.username.length === 0 ? username : password);
      return;
    }
    errorEl.textContent = "";
    submit.disabled = true;
    submit.textContent = isSignUp ? TA().signingUp : TA().signingIn;
    const inviteCode = invite?.value.trim() ?? "";
    (isSignUp ? register(inviteCode.length > 0 ? { ...credentials, inviteCode } : credentials) : login(credentials))
      .then((account) => {
        setAccount(account);
        if (isAdmin(account)) goToAdmin();
        else opts.onSignedIn();
      })
      .catch((err: unknown) => {
        submit.disabled = false;
        submit.textContent = isSignUp ? TA().signUpBtn : TA().signInBtn;
        const code = err instanceof ApiError ? err.code : null;
        const field = code === "username-taken" || code === "reserved" ? username : code === "bad-invite-code" ? invite : null;
        fail(authErrorText(err), field);
      });
  });

  setChildren(root, form);
  username.focus();
}

/* ================= password change ================= */

/**
 * "Current / new / confirm" password form posting to /api/me/password. `forced` = after an instructor
 * reset (the current password is the temporary one). Calls `onChanged` with the updated account.
 */
export function passwordChangeForm(opts: { forced: boolean; onChanged: (account: AccountView) => void; idPrefix?: string }): HTMLFormElement {
  const p = opts.idPrefix ?? "pw";
  const current = passwordField({ id: `${p}-current`, label: opts.forced ? TG().currentPwForced : TG().currentPw, autocomplete: "current-password" });
  const next = passwordField({ id: `${p}-new`, label: TG().newPw, autocomplete: "new-password", help: TG().pwHelp });
  const confirm = passwordField({ id: `${p}-confirm`, label: TG().confirmPw, autocomplete: "new-password" });
  const errorEl = h("p", { class: "form-error", role: "alert" });
  const okEl = h("p", { class: "form-ok", role: "status" });
  const submit = h("button", { type: "submit", class: `btn btn-primary${opts.forced ? " btn-lg btn-block" : ""}` }, TG().pwSave);
  const form = h("form", { class: "pw-form", novalidate: true }, current.row, next.row, confirm.row, errorEl, okEl, h("div", {}, submit));

  const fail = (message: string, field: HTMLInputElement | null): void => {
    errorEl.textContent = message;
    okEl.textContent = "";
    for (const el of [current.input, next.input, confirm.input]) el.removeAttribute("aria-invalid");
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const currentPassword = current.input.value;
    const newPassword = next.input.value;
    if (currentPassword.length === 0) return fail(TG().pwWrongCurrent, current.input);
    if (!PasswordSchema.safeParse(newPassword).success) return fail(TA().passwordInvalid, next.input);
    if (newPassword !== confirm.input.value) return fail(TG().pwMismatch, confirm.input);
    if (newPassword === currentPassword) return fail(TG().pwSame, next.input);
    errorEl.textContent = "";
    submit.disabled = true;
    submit.textContent = TG().pwSaving;
    changePassword({ currentPassword, newPassword })
      .then((account) => {
        submit.disabled = false;
        submit.textContent = TG().pwSave;
        form.reset();
        okEl.textContent = TG().pwSaved;
        opts.onChanged(account);
      })
      .catch((err: unknown) => {
        submit.disabled = false;
        submit.textContent = TG().pwSave;
        const wrongCurrent = err instanceof ApiError && err.code === "bad-credentials";
        fail(wrongCurrent ? TG().pwWrongCurrent : authErrorText(err), wrongCurrent ? current.input : null);
      });
  });
  return form;
}

function renderForcedPasswordChange(root: HTMLElement, context: string, onDone: () => void): void {
  const form = passwordChangeForm({
    forced: true,
    idPrefix: "forced-pw",
    onChanged: (account) => {
      setAccount(account);
      onDone();
    },
  });
  setChildren(
    root,
    h(
      "section",
      { class: "center-card gate" },
      h("p", { class: "eyebrow mono" }, context),
      h("h1", {}, TG().pwTitleForced),
      h("p", { class: "muted" }, TG().pwHelpForced),
      form,
      h("button", { type: "button", class: "link-btn", onclick: () => void signOut().finally(onDone) }, TA().signOut),
    ),
  );
  form.querySelector("input")?.focus();
}

/* ================= other gate screens ================= */

function renderAdminCard(root: HTMLElement, onSignedOut: () => void): void {
  setChildren(
    root,
    h(
      "section",
      { class: "center-card" },
      h("p", { class: "eyebrow mono" }, "admin"),
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

function renderPending(root: HTMLElement, account: AccountView, onApproved: () => void): void {
  stopAuthTimers();
  const status = h("p", { class: "muted small", "aria-live": "polite" });
  const check = (): void => {
    status.textContent = TA().pendingChecking;
    loadAccount(true)
      .then((fresh) => {
        status.textContent = "";
        if (fresh === null || fresh.status !== "pending") {
          stopAuthTimers();
          onApproved();
        }
      })
      .catch(() => {
        status.textContent = "";
      });
  };
  setChildren(
    root,
    h(
      "section",
      { class: "center-card" },
      h("p", { class: "eyebrow mono" }, "⏳"),
      h("h1", {}, TA().pendingTitle),
      h("p", { class: "muted" }, TA().pendingBody(account.username)),
      h(
        "div",
        { class: "row-center" },
        h("button", { type: "button", class: "btn", onclick: check }, TA().pendingCheckNow),
        h("button", { type: "button", class: "link-btn", onclick: () => void signOut().finally(onApproved) }, TA().signOut),
      ),
      status,
    ),
  );
  pendingTimer = window.setInterval(check, PENDING_POLL_MS);
}

function renderRejected(root: HTMLElement): void {
  setChildren(
    root,
    h(
      "section",
      { class: "center-card", role: "alert" },
      h("h1", {}, TA().rejectedTitle),
      h("p", { class: "muted" }, TA().rejectedBody),
      h("button", { type: "button", class: "btn", onclick: () => void signOut().finally(() => (window.location.hash = "#/login")) }, TA().signOut),
    ),
  );
}
