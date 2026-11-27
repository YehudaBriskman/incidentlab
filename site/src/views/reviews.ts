// The owner's review queue (#/author/reviews, #184): authors' cases waiting for review. Approve makes the reviewed
// version public (with the same answer-drift confirmation as a publish); reject needs a note, which the author sees
// next to the case on #/author. Only the site admin gets the queue; the server checks that on every call.
import { z } from "zod";
import { AuthorCaseResponseSchema, REVIEW_NOTE_MAX, ReviewsResponseSchema, type ReviewItem } from "../../shared/author-contract";
import { ErrorBodySchema } from "../../shared/contract";
import { dataTable, type DataTable } from "../components/dataTable";
import { formField } from "../components/formLayout";
import { TA } from "../i18n/strings-account";
import { TRv } from "../i18n/strings-review";
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

export function renderReviews(root: HTMLElement): void {
  document.title = `${TRv().reviewsTitle} · IncidentLab`;
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

  function actionsButton(r: ReviewItem): HTMLElement {
    const btn = h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": TRv().actionsFor(r.caseId) }, "⋯");
    menu(btn, () => [
      { label: TRv().approve, run: () => void decide(r, "approve").catch(failToast) },
      { label: TRv().reject, tone: "danger" as const, run: () => void decide(r, "reject").catch(failToast) },
      { label: TRv().openCase, run: () => {
        window.location.hash = `#/case/${encodeURIComponent(r.caseId)}`;
      } },
    ]);
    return btn;
  }

  setChildren(
    root,
    h(
      "section",
      { class: "review-page" },
      h("h1", { id: "reviews-h" }, TRv().reviewsTitle),
      h("p", { class: "muted" }, TRv().reviewsLead),
      h("p", {}, h("a", { class: "hit-link", href: "#/author" }, TRv().backToAuthoring)),
      table.element,
    ),
  );
  void load();
}
