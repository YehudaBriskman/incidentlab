// Sign in / sign up, and the "waiting for approval" screen. `withApprovedAccount` is the single gate
// every playable view goes through.
import { CredentialsSchema, type AccountView } from "../../shared/contract";
import { ApiError, login, register } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { loadAccount, setAccount, signOut } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { T } from "../i18n/strings-player";

const PENDING_POLL_MS = 8_000;
let pendingTimer: number | null = null;

export function stopAuthTimers(): void {
  if (pendingTimer !== null) window.clearInterval(pendingTimer);
  pendingTimer = null;
}

type Mode = "sign-in" | "sign-up";

/**
 * Resolves the signed-in account and calls `onReady` once it is approved. Otherwise renders the sign-in
 * form, the pending screen (polls until approved) or the rejected screen into `root`.
 */
export function withApprovedAccount(root: HTMLElement, context: string, onReady: (account: AccountView) => void): void {
  stopAuthTimers();
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loading)));
  loadAccount()
    .then((account) => {
      if (account === null) renderAuthForm(root, { context, mode: "sign-in", onSignedIn: () => withApprovedAccount(root, context, onReady) });
      else if (account.status === "pending") renderPending(root, account, () => withApprovedAccount(root, context, onReady));
      else if (account.status === "rejected") renderRejected(root);
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
          h("button", { type: "button", class: "btn btn-primary", onclick: () => withApprovedAccount(root, context, onReady) }, T().tryAgain),
        ),
      );
    });
}

function authErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  if (err.code === "username-taken") return TA().usernameTaken;
  if (err.code === "bad-credentials") return TA().badCredentials;
  if (err.code === "rejected") return TA().rejectedLogin;
  if (err.isRateLimited) return TA().rateLimited(err.retryAfterSeconds ?? 60);
  return err.message;
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
  const password = h("input", {
    id: "auth-password",
    class: "input input-lg",
    type: "password",
    name: "password",
    autocomplete: isSignUp ? "new-password" : "current-password",
    maxlength: "128",
    required: true,
    dir: "ltr",
    "aria-describedby": isSignUp ? "auth-password-help" : null,
  });
  const toggle = h("button", { type: "button", class: "link-btn small", "aria-controls": "auth-password", "aria-pressed": "false" }, TA().showPassword);
  toggle.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.textContent = show ? TA().hidePassword : TA().showPassword;
    toggle.setAttribute("aria-pressed", String(show));
  });
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
    h("div", { class: "field-label-row" }, h("label", { class: "field-label", for: "auth-password" }, TA().password), toggle),
    password,
    isSignUp ? h("p", { id: "auth-password-help", class: "muted small" }, TA().passwordHelp) : null,
    errorEl,
    submit,
    switchMode,
    isSignUp ? null : h("p", { class: "muted small" }, TA().forgotPassword),
  );

  const fail = (message: string, field: HTMLInputElement | null): void => {
    errorEl.textContent = message;
    username.removeAttribute("aria-invalid");
    password.removeAttribute("aria-invalid");
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
    (isSignUp ? register(credentials) : login(credentials))
      .then((account) => {
        setAccount(account);
        opts.onSignedIn();
      })
      .catch((err: unknown) => {
        submit.disabled = false;
        submit.textContent = isSignUp ? TA().signUpBtn : TA().signInBtn;
        const isNameProblem = err instanceof ApiError && err.code === "username-taken";
        fail(authErrorText(err), isNameProblem ? username : null);
      });
  });

  setChildren(root, form);
  username.focus();
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
