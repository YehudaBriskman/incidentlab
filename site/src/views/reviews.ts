// The owner's review queue (#/admin/reviews, #184; inside the platform console since #221): authors' cases waiting for review. Approve makes the reviewed
// version public (with the same answer-drift confirmation as a publish); reject needs a note, which the author sees
// next to the case on #/author. Only the site admin gets the queue; the server checks that on every call.
import { z } from "zod";
import { AuthorCaseResponseSchema, REVIEW_NOTE_MAX, ReviewContentResponseSchema, ReviewsResponseSchema, type ReviewContentResponse, type ReviewItem } from "../../shared/author-contract";
import { AccountResponseSchema, AuthorAccessRequestsResponseSchema, ErrorBodySchema, type AuthorAccessRequest } from "../../shared/contract";
import { TOw } from "../i18n/strings-owner";
import { consoleHeader } from "./admin";
import "../owner.css";
import { dataTable, type DataTable } from "../components/dataTable";
import { formField } from "../components/formLayout";
import { TA } from "../i18n/strings-account";
import { TRv } from "../i18n/strings-review";
import { TS } from "../i18n/strings-shell";
import { locale } from "../i18n/i18n";
import { rawApiFetch } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { confirm, menu, showDialog, toast } from "../lib/overlay";
import { loadAccount } from "../lib/session";
import "../player.css";

class ReviewError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

async function adminJson<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const res = await rawApiFetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorBodySchema.safeParse(json);
    throw new ReviewError(err.success ? err.data.error : `HTTP ${res.status}`, err.success ? (err.data.code ?? null) : null);
  }
  return schema.parse(json);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A POST answered with 204 (the author access decline). */
async function adminNoContent(path: string): Promise<void> {
  const res = await rawApiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) {
    const err = ErrorBodySchema.safeParse(await res.json().catch(() => null));
    throw new ReviewError(err.success ? err.data.error : `HTTP ${res.status}`, err.success ? (err.data.code ?? null) : null);
  }
}

export function renderReviews(root: HTMLElement): void {
  document.title = `${TRv().reviewsTitle} · ${TS().navConsole} · IncidentLab`;
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, TRv().reviewsLoading)));
  loadAccount()
    .then((account) => {
      if (account === null) {
        setChildren(root, h("section", { class: "center-card" }, h("h1", {}, TRv().reviewsTitle), h("p", {}, TRv().notAdmin), h("a", { class: "btn btn-primary", href: "#/login" }, TA().signIn)));
        return;
      }
      if (account.role !== "admin") {
        setChildren(root, h("section", { class: "center-card" }, h("h1", {}, TRv().reviewsTitle), h("p", {}, TRv().notAdmin)));
        return;
      }
      draw(root);
    })
    .catch((err: unknown) => setChildren(root, h("section", { class: "center-card", role: "alert" }, h("p", {}, errorText(err)))));
}

function draw(root: HTMLElement): void {
  const dateFmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const versionCell = (r: ReviewItem): Child[] => [
    `v${r.version}`,
    h("span", { class: "author-review" }, r.visibility === "public" && r.publishedVersion !== null ? TRv().replacesPublic(r.publishedVersion) : TRv().privateNow),
    r.answerKeyChanged ? h("span", { class: "author-review is-warning" }, TRv().answersChanged) : null,
  ];

  const table: DataTable<ReviewItem> = dataTable<ReviewItem>({
    columns: [
      {
        id: "case", header: TRv().colCase, rowHeader: true, sortValue: (r) => r.title,
        cell: (r) => [h("bdi", {}, r.title), " ", h("span", { class: "muted small mono", dir: "ltr" }, r.caseId)],
      },
      { id: "author", header: TRv().colAuthor, sortValue: (r) => r.author ?? "", cell: (r) => (r.author === null ? h("span", { class: "muted" }, TRv().unknownAuthor) : h("bdi", {}, r.author)) },
      { id: "version", header: TRv().colVersion, sortValue: (r) => r.version, cell: (r) => versionCell(r) },
      { id: "submitted", header: TRv().colSubmitted, optional: true, sortFirst: "desc", sortValue: (r) => r.submittedAt ?? "", cell: (r) => (r.submittedAt === null ? "" : dateFmt.format(new Date(r.submittedAt))) },
      { id: "actions", header: TRv().colActions, cell: (r) => actionsButton(r) },
    ],
    rows: [],
    initialSort: { id: "submitted", dir: "asc" },
    labelledBy: "reviews-h",
    regionLabel: TRv().reviewsTitle,
    stackOnPhone: true,
    empty: h("p", {}, TRv().reviewsEmpty),
    state: { kind: "loading", label: TRv().reviewsLoading, rows: 2 },
  });

  const load = async (): Promise<void> => {
    try {
      const { reviews } = await adminJson("GET", "/api/admin/reviews", ReviewsResponseSchema);
      table.setState({ kind: "ready" });
      table.update(reviews);
    } catch (err: unknown) {
      table.setState({ kind: "error", message: `${TRv().reviewsFailed} ${errorText(err)}`, retry: { label: TRv().retry, run: () => void load() } });
    }
  };

  const failToast = (err: unknown): void => {
    toast({ tone: "error", text: errorText(err) });
  };

  /** The decision dialog: a note field (required to reject), then the call; answer drift asks once more. */
  const decide = async (r: ReviewItem, decision: "approve" | "reject"): Promise<void> => {
    const noteInput = h("textarea", { id: `review-note-${r.caseId}`, class: "input review-note", maxlength: REVIEW_NOTE_MAX, dir: "auto" });
    const note = formField({ input: noteInput, label: TRv().noteLabel, help: decision === "reject" ? TRv().noteRequired : TRv().noteOptional });
    const reject = decision === "reject";
    const send = (acceptAnswerChanges: boolean): Promise<unknown> =>
      adminJson("POST", `/api/admin/cases/${encodeURIComponent(r.caseId)}/review`, AuthorCaseResponseSchema, {
        decision,
        note: noteInput.value.trim() === "" ? null : noteInput.value.trim(),
        acceptAnswerChanges,
      });
    let drift = false;
    const dialog = showDialog<"go" | "cancel">({
      role: "alertdialog",
      title: reject ? TRv().rejectTitle(r.caseId) : TRv().approveTitle(r.caseId, r.version),
      body: [h("p", {}, reject ? TRv().rejectBody : TRv().approveBody), ...note.nodes],
      initialFocus: () => noteInput,
      actions: [
        { value: "cancel", label: TRv().cancel },
        {
          value: "go",
          label: reject ? TRv().rejectConfirm : TRv().approveConfirm,
          tone: reject ? "danger" : "primary",
          disabled: reject,
          busyLabel: TRv().saving,
          run: async () => {
            try {
              await send(false);
            } catch (err: unknown) {
              if (err instanceof ReviewError && err.code === "answer-drift") drift = true;
              else throw err;
            }
          },
        },
      ],
    });
    if (reject) {
      noteInput.addEventListener("input", () => {
        const go = dialog.button("go");
        if (go) go.disabled = noteInput.value.trim() === "";
      });
    }
    if ((await dialog.result) !== "go") return;
    if (drift) {
      const accept = await confirm({ title: TRv().driftTitle, body: TRv().driftBody, confirmLabel: TRv().driftConfirm, tone: "danger", typedName: r.caseId });
      if (!accept) return;
      await send(true);
    }
    toast({ tone: "success", text: reject ? TRv().rejected(r.caseId) : TRv().approved(r.caseId) });
    await load();
  };

  /**
   * The content preview (#235): the reviewed version's public content per language, so the owner can judge quality
   * before approving. Plain text only (an author's markdown is never parsed into markup here); no answers reach it.
   */
  const preview = async (r: ReviewItem): Promise<void> => {
    const langs = r.langs.includes("he") ? (["en", "he"] as const) : (["en"] as const);
    const bodyEl = h("div", { class: "preview-body", "aria-live": "polite" }, h("p", { class: "muted" }, TOw().previewLoading));
    const show = async (lang: "en" | "he"): Promise<void> => {
      setChildren(bodyEl, h("p", { class: "muted" }, TOw().previewLoading));
      try {
        const res = await adminJson("GET", `/api/admin/cases/${encodeURIComponent(r.caseId)}/review-content?lang=${lang}`, ReviewContentResponseSchema);
        setChildren(bodyEl, previewBody(res, lang));
      } catch (err: unknown) {
        setChildren(bodyEl, h("p", { class: "admin-error", role: "alert" }, TOw().previewFailed(errorText(err))));
      }
    };
    const radios = langs.map((lang) => {
      const input = h("input", { type: "radio", name: `preview-lang-${r.caseId}`, value: lang, id: `preview-${r.caseId}-${lang}`, checked: lang === "en" });
      input.addEventListener("change", () => {
        if (input.checked) void show(lang);
      });
      return h("label", { for: input.id }, input, lang === "en" ? TOw().langEn : TOw().langHe);
    });
    const dialog = showDialog<"close">({
      size: "lg",
      title: TOw().previewTitle(r.caseId, r.version),
      body: [
        h("p", { class: "muted small" }, TOw().previewNote),
        langs.length > 1 ? h("fieldset", { class: "preview-lang" }, h("legend", {}, TOw().previewLang), radios) : null,
        bodyEl,
      ],
      actions: [{ value: "close", label: TOw().previewClose }],
    });
    void show("en");
    await dialog.result;
  };

  function previewBody(res: ReviewContentResponse, asked: "en" | "he"): Child[] {
    const c = res.content;
    const dir = res.lang === "he" ? "rtl" : "ltr";
    const section = (title: string, ...children: Child[]): HTMLElement => h("section", { lang: res.lang, dir }, h("h3", {}, title), children);
    return [
      asked !== res.lang ? h("p", { class: "muted small" }, TOw().previewFallback) : null,
      h("section", { lang: res.lang, dir }, h("h3", {}, c.title), h("p", { class: "muted" }, c.subtitle), h("p", { class: "muted small" }, TOw().previewMeta(c.difficulty, c.estMinutes, c.questions.length))),
      section(TOw().previewBriefing, h("pre", { class: "preview-source" }, c.briefing)),
      section(
        TOw().previewQuestions,
        h(
          "ol",
          { class: "preview-list" },
          c.questions.map((q) =>
            h(
              "li",
              {},
              h("strong", {}, q.title),
              h("pre", { class: "preview-source" }, q.prompt),
              h("p", { class: "muted small" }, TOw().previewFormat(q.answerFormat), " · ", TOw().previewHints(q.hints.length)),
            ),
          ),
        ),
      ),
      section(
        TOw().previewToolbox,
        h("ul", { class: "preview-list" }, c.toolbox.flatMap((sec) => sec.items.map((item) => h("li", {}, h("strong", {}, item.title), item.syntax === undefined ? null : [" ", h("code", { dir: "ltr" }, item.syntax)])))),
      ),
      section(TOw().previewEvidence, h("ul", { class: "preview-list" }, c.evidence.map((e) => h("li", {}, h("code", { dir: "ltr" }, e.path), " · ", e.format, " · ", e.description)))),
      section(TOw().previewRules, h("ul", { class: "preview-list" }, c.rules.map((rule) => h("li", {}, rule)))),
    ];
  }

  function actionsButton(r: ReviewItem): HTMLElement {
    const btn = h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": TRv().actionsFor(r.caseId) }, "⋯");
    menu(btn, () => [
      { label: TOw().previewItem, run: () => void preview(r).catch(failToast) },
      { label: TRv().approve, run: () => void decide(r, "approve").catch(failToast) },
      { label: TRv().reject, tone: "danger" as const, run: () => void decide(r, "reject").catch(failToast) },
      { label: TRv().openCase, run: () => {
        window.location.hash = `#/case/${encodeURIComponent(r.caseId)}`;
      } },
    ]);
    return btn;
  }

  // ---- author access requests (#234): players asking to write cases ----
  const requestsTable: DataTable<AuthorAccessRequest> = dataTable<AuthorAccessRequest>({
    columns: [
      { id: "user", header: TOw().reqColUser, rowHeader: true, sortValue: (q) => q.username, cell: (q) => h("bdi", {}, q.username) },
      { id: "note", header: TOw().reqColNote, cell: (q) => (q.note === null ? h("span", { class: "muted" }, TOw().reqNoNote) : h("span", { class: "req-note", dir: "auto" }, q.note)) },
      { id: "asked", header: TOw().reqColAsked, sortFirst: "desc", sortValue: (q) => q.createdAt, cell: (q) => dateFmt.format(new Date(q.createdAt)) },
      { id: "actions", header: TOw().reqColActions, cell: (q) => requestActions(q) },
    ],
    rows: [],
    initialSort: { id: "asked", dir: "asc" },
    labelledBy: "author-requests-h",
    regionLabel: TOw().reqTitle,
    stackOnPhone: true,
    empty: h("p", {}, TOw().reqEmpty),
    state: { kind: "loading", label: TOw().reqLoading, rows: 1 },
  });
  const requestsSection = h(
    // Not a landmark: the table's scroller is the region named after the heading (no duplicate names).
    "div",
    { class: "author-requests", id: "author-requests" },
    h("h2", { id: "author-requests-h", class: "admin-h2" }, TOw().reqTitle),
    h("p", { class: "muted" }, TOw().reqLead),
    requestsTable.element,
  );
  const loadRequests = async (): Promise<void> => {
    try {
      const { requests } = await adminJson("GET", "/api/admin/author-requests", AuthorAccessRequestsResponseSchema);
      requestsTable.setState({ kind: "ready" });
      requestsTable.update(requests);
    } catch (err: unknown) {
      requestsTable.setState({ kind: "error", message: `${TOw().reqFailed} ${errorText(err)}`, retry: { label: TRv().retry, run: () => void loadRequests() } });
    }
  };
  const decideRequest = async (q: AuthorAccessRequest, grant: boolean): Promise<void> => {
    const ok = await confirm({
      title: grant ? TOw().reqGrantTitle(q.username) : TOw().reqDeclineTitle(q.username),
      body: grant ? TOw().reqGrantBody : TOw().reqDeclineBody,
      confirmLabel: grant ? TOw().reqGrant : TOw().reqDecline,
      tone: grant ? "default" : "danger",
      run: async () => {
        const path = `/api/admin/author-requests/${encodeURIComponent(q.accountId)}/${grant ? "approve" : "reject"}`;
        if (grant) await adminJson("POST", path, AccountResponseSchema, {});
        else await adminNoContent(path);
      },
    });
    if (!ok) return;
    toast({ tone: "success", text: grant ? TOw().reqGranted(q.username) : TOw().reqDeclined(q.username) });
    await loadRequests();
  };
  function requestActions(q: AuthorAccessRequest): HTMLElement {
    const btn = h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": TOw().reqActionsFor(q.username) }, "⋯");
    menu(btn, () => [
      { label: TOw().reqGrant, run: () => void decideRequest(q, true).catch(failToast) },
      { label: TOw().reqDecline, tone: "danger" as const, run: () => void decideRequest(q, false).catch(failToast) },
    ]);
    return btn;
  }

  setChildren(
    root,
    h(
      "section",
      { class: "review-page" },
      // One console header for every section (#285); the queue is the page's h2.
      consoleHeader(),
      h("h2", { id: "reviews-h", class: "admin-h2" }, TRv().reviewsTitle),
      h("p", { class: "muted" }, TRv().reviewsLead),
      h("p", {}, h("a", { class: "hit-link", href: "#/admin" }, TRv().backToAuthoring)),
      table.element,
      requestsSection,
    ),
  );
  void load();
  void loadRequests();
}
