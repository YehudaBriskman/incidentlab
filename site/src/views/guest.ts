// Guest play (#176): the "Play as guest" choice beside sign-in, and the upgrade form that turns the guest into a
// full account with the same id (so its progress stays). The guest banner and account menu open the form.
import { PasswordSchema, UsernameSchema, type AccountView } from "../../shared/contract";
import { formActions, formField, type FormField } from "../components/formLayout";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TGu } from "../i18n/strings-guest";
import { TO } from "../i18n/strings-onboard";
import { ApiError, startGuest, upgradeGuest } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { showDialog, toast } from "../lib/overlay";
import { setAccount } from "../lib/session";
import { confirmCodeSaved, recoveryCodePanel } from "./auth";
import "../player.css";

/**
 * The quiet alternative to signing in on a gate: one button that starts a guest session and calls `onStarted`
 * with the account (the gate then continues into the case).
 */
export function guestChoice(onStarted: (account: AccountView) => void, options: { lead?: { context: string } } = {}): HTMLElement {
  // `lead` (#223): the case gate leads with play. The choice comes first with the page's h1 and the one primary
  // button; the sign-in form follows as the secondary path.
  const lead = options.lead;
  const label = lead ? TGu().playNow : TGu().playAsGuest;
  const error = h("p", { class: "form-error", role: "alert" });
  const button = h("button", { type: "button", class: lead ? "btn btn-primary btn-lg btn-block" : "btn btn-lg btn-block" }, label);
  let busy = false;
  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    error.textContent = "";
    button.setAttribute("aria-disabled", "true");
    button.textContent = TGu().starting;
    startGuest()
      .then((account) => {
        setAccount(account);
        onStarted(account);
      })
      .catch((err: unknown) => {
        busy = false;
        button.removeAttribute("aria-disabled");
        button.textContent = label;
        error.textContent = startErrorText(err);
        button.focus();
      });
  });
  if (lead) {
    return h(
      "section",
      { class: "center-card gate guest-choice is-lead", "aria-labelledby": "guest-choice-title" },
      h("p", { class: "eyebrow" }, lead.context),
      h("h1", { id: "guest-choice-title" }, TGu().gateTitle),
      h("p", { class: "muted" }, TGu().gateBody),
      button,
      error,
    );
  }
  return h(
    "section",
    { class: "center-card gate guest-choice", "aria-labelledby": "guest-choice-title" },
    h("h2", { id: "guest-choice-title" }, TGu().choiceTitle),
    h("p", { class: "muted" }, TGu().choiceBody),
    button,
    error,
  );
}

/** Starts a guest session from a one-button place (the toolbox note). False when it failed (a toast says why). */
export function playAsGuest(): Promise<boolean> {
  return startGuest().then(
    (account) => {
      setAccount(account);
      return true;
    },
    (err: unknown) => {
      toast({ tone: "error", text: startErrorText(err) });
      return false;
    },
  );
}

const startErrorText = (err: unknown): string =>
  err instanceof ApiError && err.isRateLimited ? TGu().rateLimited : err instanceof ApiError && err.status === 0 ? TO().offline : TGu().startFailed;

function passwordInput(id: string): { input: HTMLInputElement; toggle: HTMLButtonElement } {
  const input = h("input", { id, name: "password", class: "input", type: "password", autocomplete: "new-password", maxlength: "128", required: true, dir: "ltr" });
  const label = TA().password;
  const toggle = h("button", { type: "button", class: "link-btn small pw-toggle", "aria-controls": id, "aria-label": TO().showField(label) }, TA().showPassword);
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? TA().hidePassword : TA().showPassword;
    toggle.setAttribute("aria-label", show ? TO().hideField(label) : TO().showField(label));
  });
  return { input, toggle };
}

let open = false;

/** The upgrade form in a dialog. On success the account becomes a user (same id) and the guest banner goes. */
export function openUpgradeDialog(): void {
  if (open) return;
  const user: FormField = formField({
    label: TA().username,
    help: TA().usernameHelp,
    input: h("input", {
      id: "upgrade-username",
      name: "username",
      class: "input",
      type: "text",
      autocomplete: "username",
      autocapitalize: "none",
      spellcheck: "false",
      maxlength: "24",
      required: true,
      dir: "auto",
    }),
  });
  const pwParts = passwordInput("upgrade-password");
  const pw: FormField = formField({ label: TA().password, help: TA().passwordHelp, input: pwParts.input, extra: pwParts.toggle });
  const formError = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, TGu().upgradeSubmit);
  const cancel = h("button", { type: "button", class: "btn btn-ghost" }, TGu().cancel);
  const form = h(
    "form",
    { class: "upgrade-form", novalidate: true },
    h("p", { class: "muted" }, TGu().upgradeBody),
    user.nodes,
    pw.nodes,
    formError,
    formActions(submit, cancel),
  );
  // Once the one-time recovery code shows (#205), the dialog outlives the route refresh the upgrade causes (class
  // pages re-render on an account change), and Escape or × without Copy or Download asks first.
  const shownCode = { shown: false, saved: false };
  const handle = showDialog({
    title: TGu().upgradeTitle,
    body: form,
    size: "sm",
    closeButton: true,
    initialFocus: () => user.input,
    persistent: () => shownCode.shown,
    beforeDismiss: () => (shownCode.shown ? confirmCodeSaved(shownCode.saved) : true),
  });
  open = true;
  void handle.result.finally(() => {
    open = false;
    if (shownCode.shown) toast({ tone: "success", text: TGu().upgraded });
  });
  cancel.addEventListener("click", () => handle.close(null));

  const check = (f: FormField): string | null => {
    if (f === user) {
      const value = f.input.value.trim();
      if (value.length === 0) return TO().enterUsername;
      return UsernameSchema.safeParse(value).success ? null : TA().usernameInvalid;
    }
    if (f.input.value.length === 0) return TO().enterPassword;
    return PasswordSchema.safeParse(f.input.value).success ? null : TA().passwordInvalid;
  };
  for (const f of [user, pw]) {
    f.input.addEventListener("input", () => {
      if (f.hasError() && check(f) === null) f.setError(null);
    });
  }

  let busy = false;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy) return;
    formError.textContent = "";
    let firstBad: FormField | null = null;
    for (const f of [user, pw]) {
      const message = check(f);
      f.setError(message);
      if (message !== null && firstBad === null) firstBad = f;
    }
    if (firstBad !== null) {
      firstBad.input.focus();
      return;
    }
    busy = true;
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = TGu().upgrading;
    upgradeGuest({ username: user.input.value.trim(), password: pw.input.value })
      .then(({ account, recoveryCode }) => {
        if (recoveryCode === null) {
          setAccount(account);
          handle.close(null);
          toast({ tone: "success", text: TGu().upgraded });
          return;
        }
        // Show the new account's one-time recovery code (#174) before the dialog closes, as sign-up does. The
        // dialog is persistent from here, before setAccount can re-render the route under it.
        shownCode.shown = true;
        const lead = h("p", { class: "recovery-code-warning", tabindex: "-1" }, TA().codeLeadSignUp);
        const done = h("button", { type: "button", class: "btn btn-primary" }, TA().codeSaved);
        done.addEventListener("click", () => handle.close(null));
        const markSaved = (): void => {
          shownCode.saved = true;
        };
        setChildren(form, lead, recoveryCodePanel(recoveryCode, account.username, markSaved), formActions(done));
        setAccount(account);
        lead.focus();
      })
      .catch((err: unknown) => {
        busy = false;
        submit.removeAttribute("aria-disabled");
        submit.textContent = TGu().upgradeSubmit;
        const code = err instanceof ApiError ? err.code : null;
        if (code === "username-taken" || code === "reserved") {
          user.setError(code === "reserved" ? TG().reservedName : TA().usernameTaken);
          user.input.focus();
          return;
        }
        formError.textContent =
          err instanceof ApiError && err.isRateLimited
            ? TA().rateLimited(err.retryAfterSeconds ?? 60)
            : code === "not-guest"
              ? TGu().notGuest
              : err instanceof ApiError && err.status === 0
                ? TO().offline
                : err instanceof ApiError
                  ? err.message
                  : TGu().startFailed;
        submit.focus();
      });
  });
}
