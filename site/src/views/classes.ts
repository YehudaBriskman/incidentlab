// My classes (#/classes) and the shareable join link (#/join/<code>), #182.
// - Signed out: sign-in and sign-up links (the join link signs in on the spot, then joins).
// - Guests: classes need an account, so they get the guest upgrade dialog (views/guest.ts).
// - Accounts: the classes table (role and status chips, a pending state), "Create class" in a dialog (lib/overlay)
//   and "Join with a code". Pending, rejected and forced-password accounts go through the account gate first.
// Class names are admin-authored: they are rendered as text only. Nothing here polls.
import "../classes.css";
import { ClassNameSchema, normalizeClassCode, type AccountView, type ClassSummary } from "../../shared/contract";
import { dataTable, type Column } from "../components/dataTable";
import { formActions, formField, type FormField } from "../components/formLayout";
import { pageHeader } from "../components/pagePanel";
import { TC } from "../i18n/strings-classes";
import { ApiError } from "../lib/api";
import { createClass, fetchMyClasses, joinClass } from "../lib/class-api";
import { h, setChildren, type Child } from "../lib/dom";
import { showDialog, toast } from "../lib/overlay";
import { isAdmin, isGuest, loadAccount, onAccountChange } from "../lib/session";
import { openGuestUpgrade } from "../shell/frame";
import { routeParts } from "../shell/nav";
import type { ViewResult } from "../shell/types";
import { withApprovedAccount } from "./auth";

/** Class pages re-render when the account changes under them (a guest upgrades, a sign-out elsewhere). */
let watching = false;
function watchAccount(): void {
  if (watching) return;
  watching = true;
  let last: string | null | undefined;
  onAccountChange((account) => {
    const key = account === null ? null : `${account.id}:${account.kind}:${account.status}`;
    if (key === last) return;
    last = key;
    const section = routeParts()[0];
    if (section === "classes" || section === "join") window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

/** The status chips of one class in a list: pending request, archived, or the role. */
export function classChips(c: ClassSummary): HTMLElement[] {
  const m = c.membership;
  const out: HTMLElement[] = [];
  if (m === null) out.push(h("span", { class: "chip pill-info" }, TC().roleSiteAdmin));
  else if (m.status === "pending") out.push(h("span", { class: "chip pill-warning" }, TC().statusPending));
  else out.push(h("span", { class: m.role === "admin" ? "chip pill-info" : "chip" }, m.isOwner ? TC().roleOwner : m.role === "admin" ? TC().roleAdmin : TC().roleMember));
  if (c.status === "archived") out.push(h("span", { class: "chip chip-muted" }, TC().statusArchived));
  return out;
}

const canManage = (c: ClassSummary): boolean => c.membership === null || (c.membership.role === "admin" && c.membership.status === "active");
const classHref = (id: string, sub = ""): string => `#/class/${encodeURIComponent(id)}${sub}`;

/** A centred message card: signed out, guest, a join result. */
function noteCard(opts: { title: string; body: Child; actions?: Child; tone?: "warning" | "danger"; titleId?: string }): HTMLElement {
  const id = opts.titleId ?? "class-note-title";
  return h(
    "section",
    { class: `class-note${opts.tone ? ` is-${opts.tone}` : ""}`, "aria-labelledby": id },
    h("h2", { id, class: "class-note-title", tabindex: "-1" }, opts.title),
    h("div", { class: "class-note-body" }, opts.body),
    opts.actions ? h("div", { class: "class-note-actions" }, opts.actions) : null,
  );
}

function signedOutCard(): HTMLElement {
  return noteCard({
    title: TC().signedOutTitle,
    body: h("p", {}, TC().signedOutBody),
    actions: [h("a", { class: "btn btn-primary", href: "#/login" }, TC().signIn), h("a", { class: "btn", href: "#/signup" }, TC().signUp)],
  });
}

function guestCard(): HTMLElement {
  const btn = h("button", { type: "button", class: "btn btn-primary" }, TC().signUp);
  btn.addEventListener("click", openGuestUpgrade);
  return noteCard({ title: TC().guestTitle, body: h("p", {}, TC().guestBody), actions: btn });
}

// ---- #/classes -------------------------------------------------------------------------------------------

export function classesView(): ViewResult {
  const main = h("div", { class: "view classes-page" });
  // A dashboard: the page fills the content area and the class list scrolls inside its card.
  return { main, layout: "fit", start: () => renderClasses(main) };
}

/** "How classes work": three short steps beside the join form. */
function aboutCard(): HTMLElement {
  return h(
    "section",
    { class: "class-card classes-about", "aria-labelledby": "classes-about-title" },
    h("header", { class: "class-card-head" }, h("h2", { id: "classes-about-title", class: "class-card-title" }, TC().aboutTitle)),
    h("ol", { class: "class-steps" }, [TC().aboutStep1, TC().aboutStep2, TC().aboutStep3].map((step) => h("li", {}, step))),
  );
}

function renderClasses(root: HTMLElement): void {
  watchAccount();
  document.title = `${TC().classesTitle} · IncidentLab`;
  const createBtn = h("button", { type: "button", class: "btn btn-primary", hidden: true }, TC().createClass);
  const header = pageHeader({ title: TC().classesTitle, meta: TC().classesIntro, actions: createBtn, id: "classes-title" });
  const body = h("div", { class: "classes-body" }, h("p", { class: "muted" }, TC().loading));
  setChildren(root, header, body);

  void loadAccount().then(
    (account) => {
      if (account === null) return setChildren(body, signedOutCard());
      if (isGuest(account)) return setChildren(body, guestCard());
      // Pending, rejected and forced-password accounts see the gate's screens; the site admin may manage classes.
      withApprovedAccount(body, TC().classesTitle, (a) => showList(a), { onAdmin: () => showList(account) });
    },
    () => setChildren(body, h("p", { class: "muted", role: "alert" }, TC().loadFailed)),
  );

  function showList(account: AccountView): void {
    createBtn.hidden = false;
    createBtn.onclick = () => openCreateDialog();
    const listBody = h("div", { class: "classes-list-body", "aria-live": "polite" });
    const countEl = h("span", { class: "muted small" });
    const listPanel = h(
      "section",
      { class: "class-card classes-list", "aria-labelledby": "classes-list-title" },
      h("header", { class: "class-card-head" }, h("h2", { id: "classes-list-title", class: "class-card-title" }, TC().myClasses, " ", countEl)),
      isAdmin(account) ? h("p", { class: "muted small class-card-note" }, TC().adminNote) : null,
      listBody,
    );
    setChildren(body, h("div", { class: "classes-grid" }, listPanel, h("div", { class: "classes-side" }, joinCard(isAdmin(account)), aboutCard())));
    void load();

    async function load(): Promise<void> {
      setChildren(listBody, h("p", { class: "muted class-card-note" }, TC().loading));
      try {
        const classes = await fetchMyClasses();
        countEl.textContent = `(${classes.length})`;
        drawList(classes);
      } catch (err: unknown) {
        const retry = h("button", { type: "button", class: "btn btn-sm" }, TC().retry);
        retry.addEventListener("click", () => void load());
        setChildren(listBody, h("div", { class: "class-card-note", role: "alert" }, h("p", {}, TC().loadFailed, " ", errText(err)), retry));
      }
    }

    function drawList(classes: readonly ClassSummary[]): void {
      if (classes.length === 0) {
        setChildren(listBody, h("p", { class: "muted class-card-note class-empty" }, TC().noClasses));
        return;
      }
      const columns: Column<ClassSummary>[] = [
        {
          id: "name",
          header: TC().colClass,
          rowHeader: true,
          cell: (c) => h("a", { href: classHref(c.id), class: "class-link", dir: "auto" }, c.name),
          sortValue: (c) => c.name.toLowerCase(),
        },
        { id: "role", header: TC().colStatus, cell: (c) => classChips(c), sortValue: (c) => (c.membership?.status === "pending" ? 1 : 0) },
        {
          id: "actions",
          header: TC().manage,
          headerHidden: true,
          className: "col-actions",
          cell: (c) => (canManage(c) ? h("a", { class: "btn btn-sm btn-ghost", href: classHref(c.id, "/manage"), "aria-label": TC().manageClass(c.name) }, TC().manage) : null),
        },
      ];
      setChildren(listBody, dataTable({ columns, rows: classes, labelledBy: "classes-list-title", className: "classes-table", stackOnPhone: true, initialSort: { id: "name", dir: "asc" } }).element);
    }

    function openCreateDialog(): void {
      const name: FormField = formField({
        label: TC().nameLabel,
        help: TC().nameHelp,
        input: h("input", { id: "class-name", name: "class-name", class: "input", type: "text", maxlength: "60", required: true, autocomplete: "off", dir: "auto" }),
      });
      const formError = h("p", { class: "form-error", role: "alert" });
      const submit = h("button", { type: "submit", class: "btn btn-primary" }, TC().createClass);
      const cancel = h("button", { type: "button", class: "btn btn-ghost" }, TC().cancel);
      const form = h("form", { class: "class-form", novalidate: true }, h("p", { class: "muted" }, TC().createBody), name.nodes, formError, formActions(submit, cancel));
      const handle = showDialog({ title: TC().createTitle, body: form, size: "sm", closeButton: true, initialFocus: () => name.input, returnFocus: () => createBtn });
      cancel.addEventListener("click", () => handle.close(null));
      let busy = false;
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (busy) return;
        formError.textContent = "";
        const parsed = ClassNameSchema.safeParse(name.input.value);
        if (!parsed.success) {
          name.setError(name.input.value.trim() === "" ? TC().nameRequired : TC().nameTooLong);
          name.input.focus();
          return;
        }
        name.setError(null);
        busy = true;
        submit.setAttribute("aria-disabled", "true");
        submit.textContent = TC().creating;
        createClass(parsed.data)
          .then((created) => {
            handle.close(null);
            toast({ tone: "success", text: TC().created(created.name) });
            window.location.hash = classHref(created.id, "/manage");
          })
          .catch((err: unknown) => {
            busy = false;
            submit.removeAttribute("aria-disabled");
            submit.textContent = TC().createClass;
            // The limit is the one error people will meet: say it at the field, with the number.
            if (err instanceof ApiError && err.code === "class-limit") {
              name.setError(TC().classLimit);
              name.input.focus();
              return;
            }
            formError.textContent = err instanceof ApiError && err.isRateLimited ? TC().createRateLimited : errText(err);
            submit.focus();
          });
      });
    }
  }
}

/** "Join with a code": the code field and the result of the last try. */
function joinCard(siteAdmin: boolean): HTMLElement {
  const code: FormField = formField({
    label: TC().codeLabel,
    help: TC().joinBody,
    input: h("input", {
      id: "class-code",
      name: "class-code",
      class: "input mono class-code-input",
      type: "text",
      maxlength: "64",
      required: true,
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      dir: "ltr",
      placeholder: "ABCDE-FGHJK",
    }),
  });
  const submit = h("button", { type: "submit", class: "btn" }, TC().joinSubmit);
  const result = h("div", { class: "class-join-result" });
  const form = h("form", { class: "class-form", novalidate: true }, code.nodes, formActions(submit));
  let busy = false;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy) return;
    const value = normalizeClassCode(code.input.value);
    if (value === "") {
      code.setError(TC().codeRequired);
      code.input.focus();
      return;
    }
    code.setError(null);
    busy = true;
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = TC().joining;
    void attemptJoin(value).then((card) => {
      busy = false;
      submit.removeAttribute("aria-disabled");
      submit.textContent = TC().joinSubmit;
      setChildren(result, card);
      card.querySelector<HTMLElement>(".class-note-title")?.focus();
    });
  });
  return h(
    "section",
    { class: "class-card classes-join", "aria-labelledby": "classes-join-title" },
    h("header", { class: "class-card-head" }, h("h2", { id: "classes-join-title", class: "class-card-title" }, TC().joinTitle)),
    h("div", { class: "class-card-pad" }, siteAdmin ? h("p", { class: "muted small" }, TC().adminJoin) : form, result),
  );
}

/** Joins (or asks to join) and returns the card that says what happened. */
async function attemptJoin(code: string): Promise<HTMLElement> {
  try {
    const joined = await joinClass(code);
    const open = h("a", { class: "btn btn-primary", href: classHref(joined.id) }, TC().openClass);
    if (joined.membership?.status === "pending") {
      return noteCard({ title: TC().pendingTitle(joined.name), body: h("p", {}, TC().pendingBody), actions: h("a", { class: "btn", href: "#/classes" }, TC().allClasses), tone: "warning" });
    }
    return noteCard({ title: TC().joinedTitle(joined.name), body: h("p", {}, TC().joinedBody), actions: open });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 404) return noteCard({ title: TC().unknownTitle, body: h("p", {}, TC().unknownBody), tone: "danger" });
      if (err.code === "class-full") return noteCard({ title: TC().fullTitle, body: h("p", {}, TC().fullBody), tone: "danger" });
      if (err.code === "guest") return guestCard();
      if (err.code === "admin") return noteCard({ title: TC().joinPageTitle, body: h("p", {}, TC().adminJoin) });
      if (err.isRateLimited) return noteCard({ title: TC().joinPageTitle, body: h("p", {}, TC().joinRateLimited(Math.max(1, Math.ceil((err.retryAfterSeconds ?? 60) / 60)))), tone: "warning" });
    }
    return noteCard({ title: TC().joinPageTitle, body: h("p", {}, TC().joinFailed(errText(err))), tone: "danger" });
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : TC().unknownError);

// ---- #/join/<code> ---------------------------------------------------------------------------------------

export function joinView(rawCode: string): ViewResult {
  const main = h("div", { class: "view classes-page" });
  return { main, start: () => renderJoin(main, normalizeClassCode(rawCode).slice(0, 64)) };
}

function renderJoin(root: HTMLElement, code: string): void {
  watchAccount();
  document.title = `${TC().joinPageTitle} · IncidentLab`;
  const body = h("div", { class: "classes-body is-narrow" }, h("p", { class: "muted" }, TC().joining));
  setChildren(root, pageHeader({ title: TC().joinPageTitle, meta: h("span", { class: "mono", dir: "ltr" }, code), id: "join-title" }), body);
  void loadAccount().then(
    (account) => {
      if (account !== null && isGuest(account)) return setChildren(body, guestCard());
      // Signed out: the gate's sign-in form, then the join runs as soon as the account is ready.
      withApprovedAccount(
        body,
        TC().joinPageTitle,
        () => {
          // A join that already went through is a no-op on the server (a language switch re-runs it).
          setChildren(body, h("p", { class: "muted" }, TC().joining));
          void attemptJoin(code).then((card) => {
            setChildren(body, card);
            card.querySelector<HTMLElement>(".class-note-title")?.focus();
          });
        },
        {
          signInTitle: TC().joinSignIn,
          titleTag: "h2", // the page header above is the h1
          // Sign-up here carries the code (#204): the new account joins at once and lands on the class page.
          inviteCode: code,
          onAdmin: () => setChildren(body, noteCard({ title: TC().joinPageTitle, body: h("p", {}, TC().adminJoin), actions: h("a", { class: "btn", href: "#/classes" }, TC().allClasses) })),
        },
      );
    },
    () => setChildren(body, h("p", { class: "muted", role: "alert" }, TC().loadFailed)),
  );
}
