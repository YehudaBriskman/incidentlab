// Case authoring (#/author, #66): the instructor and authors upload a case package, see what changed against
// the live version, publish, roll back, delete and restore. The upload itself is shared/upload-client.ts (the
// same code as `scripts/data.ts upload`): it validates the package in the browser, sends only the chunks the
// server lacks (resumable), saves a draft, and publishes only when asked. Answer-key changes that would re-score
// players need an explicit second confirmation.
// Private cases (#184): an author's case is private until the site owner approves it. The table shows its
// visibility and review state (with the owner's note), and the row menu submits it for review and picks the
// classes that may play it. The owner's queue is #/admin/reviews (views/reviews.ts).
import { z } from "zod";
import {
  AuthorCaseResponseSchema,
  AuthorCasesResponseSchema,
  DeleteCaseResponseSchema,
  RestoreCaseResponseSchema,
  type AuthorCase,
  type FinalizeResponse,
  type PublishResponse,
} from "../../shared/author-contract";
import { ClassesResponseSchema, ErrorBodySchema } from "../../shared/contract";
import { publishCaseVersion, uploadCasePackage, UploadError, type UploadProgress, type UploadTransport } from "../../shared/upload-client";
import { dataTable, type DataTable } from "../components/dataTable";
import { formActions, formField, formSection } from "../components/formLayout";
import { TAu } from "../i18n/strings-author";
import { TRv } from "../i18n/strings-review";
import { TA } from "../i18n/strings-account";
import { locale } from "../i18n/i18n";
import { rawApiFetch } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { confirm, menu, showDialog, toast } from "../lib/overlay";
import "../player.css";
import { loadAccount } from "../lib/session";

const send: UploadTransport = (path, init) =>
  rawApiFetch(path, { method: init.method, headers: init.headers, body: init.body === undefined ? undefined : init.body });

class ActionError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

async function authorJson<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const res = await send(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorBodySchema.safeParse(json);
    throw new ActionError(err.success ? err.data.error : `HTTP ${res.status}`, err.success ? (err.data.code ?? null) : null);
  }
  return schema.parse(json);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a publish did: live publicly, live privately, or waiting for the owner's review (#184). */
const publishedText = (caseId: string, version: number, result: PublishResponse): string => {
  if (result.pendingReview) return TRv().pendingReview(caseId, version);
  if (result.visibility === "private") return TRv().livePrivately(caseId, result.publishedVersion);
  return TAu().published(caseId, result.publishedVersion);
};

export function renderAuthor(root: HTMLElement): void {
  document.title = `${TAu().title} · IncidentLab`;
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, TAu().casesLoading)));
  loadAccount()
    .then((account) => {
      if (account === null) {
        setChildren(root, h("section", { class: "center-card" }, h("h1", {}, TAu().title), h("p", {}, TAu().signInNeeded), h("a", { class: "btn btn-primary", href: "#/login" }, TA().signIn)));
        return;
      }
      if (account.role !== "author" && account.role !== "admin") {
        setChildren(root, h("section", { class: "center-card" }, h("h1", {}, TAu().title), h("p", {}, TAu().notAuthor)));
        return;
      }
      draw(root, account.role === "admin");
    })
    .catch((err: unknown) => setChildren(root, h("section", { class: "center-card", role: "alert" }, h("p", {}, errorText(err)))));
}

/** The visibility pill, then the review state, a pending version, the owner's note and the class count. */
function visibilityCell(c: AuthorCase): Child[] {
  const review = TRv().review(c.review);
  return [
    h("span", { class: `status-pill is-vis-${c.visibility}` }, TRv().visibility(c.visibility)),
    review === "" ? null : h("span", { class: `author-review${c.review === "rejected" ? " is-warning" : ""}` }, review),
    c.pendingVersion === null ? null : h("span", { class: "author-review" }, TRv().pendingVersion(c.pendingVersion)),
    c.reviewNote === null ? null : h("span", { class: "author-review" }, TRv().ownerNote, " ", h("bdi", { dir: "auto" }, c.reviewNote)),
    c.visibility === "private" && c.classIds.length > 0 ? h("span", { class: "author-review" }, TRv().classCount(c.classIds.length)) : null,
  ];
}

function draw(root: HTMLElement, isOwner: boolean): void {
  /* ---------- cases table ---------- */
  let cases: readonly AuthorCase[] = [];
  const dateFmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const versionText = (v: number | null): Child => (v === null ? h("span", { class: "muted" }, TAu().none) : `v${v}`);

  const table: DataTable<AuthorCase> = dataTable<AuthorCase>({
    columns: [
      { id: "case", header: TAu().colCase, rowHeader: true, sortValue: (c) => c.title, cell: (c) => [h("bdi", {}, c.title), " ", h("span", { class: "muted small mono", dir: "ltr" }, c.id)] },
      { id: "status", header: TAu().colStatus, sortValue: (c) => c.status, cell: (c) => h("span", { class: `status-pill is-case-${c.status}` }, TAu().statusLabel(c.status)) },
      { id: "visibility", header: TRv().colVisibility, sortValue: (c) => `${c.visibility}:${c.review}`, cell: (c) => visibilityCell(c) },
      { id: "published", header: TAu().colPublished, numeric: true, sortValue: (c) => c.publishedVersion, cell: (c) => versionText(c.publishedVersion) },
      { id: "latest", header: TAu().colLatest, numeric: true, optional: true, sortValue: (c) => c.latestVersion, cell: (c) => `v${c.latestVersion}` },
      { id: "updated", header: TAu().colUpdated, optional: true, sortFirst: "desc", sortValue: (c) => c.updatedAt, cell: (c) => dateFmt.format(new Date(c.updatedAt)) },
      { id: "actions", header: TAu().colActions, cell: (c) => actionsButton(c) },
    ],
    rows: [],
    initialSort: { id: "updated", dir: "desc" },
    labelledBy: "author-cases-h",
    regionLabel: TAu().casesTitle,
    stackOnPhone: true,
    empty: h("p", {}, TAu().casesEmpty),
    state: { kind: "loading", label: TAu().casesLoading, rows: 3 },
  });

  const loadCases = async (): Promise<void> => {
    try {
      cases = (await authorJson("GET", "/api/author/cases", AuthorCasesResponseSchema)).cases;
      table.setState({ kind: "ready" });
      table.update(cases);
    } catch (err: unknown) {
      table.setState({ kind: "error", message: `${TAu().casesFailed} ${errorText(err)}`, retry: { label: TAu().retry, run: () => void loadCases() } });
    }
  };

  /** Publishes (or rolls back to) `version`; asks again when the answer key changed under players' feet. */
  const publish = async (caseId: string, version: number, rollback: boolean): Promise<void> => {
    const ok = await confirm({
      title: rollback ? TAu().rollbackTitle(caseId, version) : TAu().publishTitle(caseId, version),
      body: TAu().publishBody,
      confirmLabel: rollback ? TAu().menuRollback(version) : TAu().publishDraft(version),
    });
    if (!ok) return;
    let result: PublishResponse;
    try {
      result = await publishCaseVersion(send, caseId, version, false);
    } catch (err: unknown) {
      if (!(err instanceof UploadError && err.code === "answer-drift")) throw err;
      const accept = await confirm({ title: TAu().driftTitle, body: TAu().driftBody, confirmLabel: TAu().driftConfirm, tone: "danger", typedName: caseId });
      if (!accept) return;
      result = await publishCaseVersion(send, caseId, version, true);
    }
    toast({ tone: "success", text: publishedText(caseId, version, result) });
    await loadCases();
  };

  const submitReview = async (c: AuthorCase): Promise<void> => {
    const ok = await confirm({ title: TRv().submitTitle(c.id), body: TRv().submitBody, confirmLabel: TRv().menuSubmit });
    if (!ok) return;
    await authorJson("POST", `/api/author/cases/${encodeURIComponent(c.id)}/submit-review`, AuthorCaseResponseSchema, {});
    toast({ tone: "success", text: TRv().submitted(c.id) });
    await loadCases();
  };

  /** Picks the classes whose members may play the private case: the active classes this account admins. */
  const editClasses = async (c: AuthorCase): Promise<void> => {
    const { classes } = await authorJson("GET", "/api/classes", ClassesResponseSchema);
    const mine = classes.filter((k) => k.status === "active" && k.membership?.role === "admin" && k.membership.status === "active");
    // Classes assigned earlier stay listed (and checked) even if this account no longer admins them.
    const extra = c.classIds.filter((id) => !mine.some((k) => k.id === id)).map((id) => ({ id, name: id }));
    const options = [...mine.map((k) => ({ id: k.id, name: k.name })), ...extra];
    const boxes = options.map((o) => ({ id: o.id, box: h("input", { type: "checkbox", id: `author-class-${o.id}`, checked: c.classIds.includes(o.id) }), name: o.name }));
    const body: Child[] = [
      h("p", { class: "muted" }, TRv().classesHelp),
      boxes.length === 0
        ? h("p", {}, TRv().classesEmpty)
        : h("fieldset", { class: "author-classes" }, h("legend", {}, TRv().classesLegend), boxes.map((b) => h("label", { class: "check-row", for: b.box.id }, b.box, " ", h("bdi", {}, b.name)))),
    ];
    let saved = 0;
    const dialog = showDialog<"save" | "cancel">({
      title: TRv().classesTitle(c.id),
      body,
      actions: [
        { value: "cancel", label: TRv().cancel },
        {
          value: "save", label: TRv().save, tone: "primary", busyLabel: TRv().saving, disabled: boxes.length === 0,
          run: async () => {
            const classIds = boxes.filter((b) => b.box.checked).map((b) => b.id);
            saved = (await authorJson("PUT", `/api/author/cases/${encodeURIComponent(c.id)}/classes`, AuthorCaseResponseSchema, { classIds })).case.classIds.length;
          },
        },
      ],
    });
    if ((await dialog.result) !== "save") return;
    toast({ tone: "success", text: TRv().classesSaved(c.id, saved) });
    await loadCases();
  };

  const restore = async (caseId: string): Promise<void> => {
    await authorJson("POST", `/api/author/cases/${encodeURIComponent(caseId)}/restore`, RestoreCaseResponseSchema, {});
    toast({ tone: "success", text: TAu().restored(caseId) });
    await loadCases();
  };

  const remove = async (c: AuthorCase): Promise<void> => {
    const ok = await confirm({ title: TAu().deleteTitle(c.id), body: TAu().deleteBody, confirmLabel: TAu().deleteConfirm, tone: "danger", typedName: c.id });
    if (!ok) return;
    await authorJson("DELETE", `/api/author/cases/${encodeURIComponent(c.id)}`, DeleteCaseResponseSchema);
    toast({ tone: "success", text: TAu().deleted(c.id), action: { label: TAu().undo, run: () => void restore(c.id).catch(failToast) } });
    await loadCases();
  };

  const failToast = (err: unknown): void => {
    toast({ tone: "error", text: errorText(err) });
  };

  function actionsButton(c: AuthorCase): HTMLElement {
    const btn = h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": TAu().actionsFor(c.id) }, "⋯");
    menu(btn, () => {
      if (c.status === "trashed") return [{ label: TAu().menuRestore, run: () => void restore(c.id).catch(failToast) }];
      const draft = c.versions.find((v) => v.state === "draft");
      const previous = c.versions.filter((v) => v.state === "previous").sort((a, b) => b.version - a.version)[0];
      const canSubmit = c.status === "published" && c.visibility === "private" && c.review !== "submitted";
      return [
        ...(draft ? [{ label: TAu().menuPublish(draft.version), run: () => void publish(c.id, draft.version, false).catch(failToast) }] : []),
        ...(previous ? [{ label: TAu().menuRollback(previous.version), run: () => void publish(c.id, previous.version, true).catch(failToast) }] : []),
        ...(canSubmit ? [{ label: TRv().menuSubmit, run: () => void submitReview(c).catch(failToast) }] : []),
        ...(c.visibility === "private" ? [{ label: TRv().menuClasses, run: () => void editClasses(c).catch(failToast) }] : []),
        { label: TAu().menuDelete, tone: "danger" as const, run: () => void remove(c).catch(failToast) },
      ];
    });
    return btn;
  }

  /* ---------- upload form ---------- */
  const fileInput = h("input", { id: "author-file", type: "file", accept: ".zip,application/zip", class: "input" });
  const file = formField({ input: fileInput, label: TAu().fileLabel, help: TAu().fileHelp });
  const publishBox = h("input", { id: "author-publish", type: "checkbox" });
  const acceptBox = h("input", { id: "author-accept", type: "checkbox" });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, TAu().uploadBtn);
  const bar = h("progress", { class: "author-progress", max: "1", value: "0", "aria-label": TAu().progressLabel, hidden: true });
  const status = h("p", { class: "author-status", role: "status" });
  const result = h("div", { class: "author-result" });

  const onProgress = (p: UploadProgress): void => {
    bar.hidden = false;
    if (p.phase === "validated") status.textContent = TAu().phaseValidated(p.caseId, p.files);
    else if (p.phase === "created") status.textContent = TAu().phaseCreated(p.missingChunks, p.totalChunks);
    else if (p.phase === "chunk") {
      bar.value = p.total === 0 ? 1 : p.sent / p.total;
      status.textContent = TAu().phaseChunk(p.sent, p.total);
    } else if (p.phase === "parts") status.textContent = TAu().phaseParts(p.sent, p.total);
    else if (p.phase === "finalized") {
      bar.value = 1;
      status.textContent = TAu().phaseFinalized(p.version);
    } else status.textContent = TAu().phasePublished(p.version);
  };

  const diffView = (draft: FinalizeResponse, published: boolean): HTMLElement => {
    const d = draft.diff;
    const lines: Child[] =
      d.against === null
        ? [h("li", {}, TAu().diffNothingPublished)]
        : [
            h("li", {}, TAu().diffContent(d.contentChanged.length)),
            h("li", {}, TAu().diffEvidence(d.evidenceAdded.length, d.evidenceRemoved.length, d.evidenceChanged.length)),
            h("li", { class: d.answerFingerprintChanged ? "is-warning" : undefined }, d.answerFingerprintChanged ? TAu().diffAnswersChanged : TAu().diffAnswersSame),
          ];
    return h(
      "section",
      { class: "author-diff", "aria-labelledby": "author-diff-h" },
      h("h3", { id: "author-diff-h" }, TAu().diffTitle(draft.version)),
      h("ul", {}, lines),
      published ? null : h("button", { type: "button", class: "btn btn-primary", onclick: () => void publish(draft.caseId, draft.version, false).catch(failToast) }, TAu().publishDraft(draft.version)),
    );
  };

  const form = h(
    "form",
    { class: "author-form", novalidate: true },
    formSection(
      TAu().uploadTitle,
      file.nodes,
      h("label", { class: "check-row", for: "author-publish" }, publishBox, " ", TAu().publishAfter),
      h("label", { class: "check-row", for: "author-accept" }, acceptBox, " ", TAu().acceptChanges),
      formActions(submit),
      bar,
      status,
    ),
    result,
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const picked = fileInput.files?.[0];
    if (picked === undefined) {
      file.setError(TAu().chooseFile);
      fileInput.focus();
      return;
    }
    file.setError(null);
    submit.disabled = true;
    submit.textContent = TAu().uploading;
    setChildren(result);
    bar.value = 0;
    void picked
      .arrayBuffer()
      .then((buf) => uploadCasePackage(new Uint8Array(buf), { send, publish: publishBox.checked, acceptAnswerChanges: acceptBox.checked, onProgress }))
      .then(async (outcome) => {
        setChildren(result, diffView(outcome.draft, outcome.published !== null));
        if (outcome.published) toast({ tone: "success", text: publishedText(outcome.draft.caseId, outcome.draft.version, outcome.published) });
        await loadCases();
      })
      .catch((err: unknown) => {
        const details = err instanceof UploadError ? err.details : [];
        status.textContent = "";
        setChildren(
          result,
          h(
            "div",
            { class: "notice form-error author-error", role: "alert" },
            h("p", {}, h("strong", {}, TAu().failed), " ", errorText(err)),
            details.length > 0 ? h("ul", {}, details.map((d) => h("li", { dir: "auto" }, d))) : null,
            h("p", { class: "muted small" }, TAu().retryHint),
          ),
        );
      })
      .finally(() => {
        submit.disabled = false;
        submit.textContent = TAu().uploadBtn;
      });
  });

  setChildren(
    root,
    h(
      "section",
      { class: "author-page" },
      h("h1", {}, TAu().title),
      h("p", { class: "muted" }, TAu().lead),
      h("p", { class: "muted" }, TRv().privateLead),
      isOwner ? h("p", {}, h("a", { class: "btn btn-outline", href: "#/admin/reviews" }, TRv().reviewQueueLink)) : null,
      form,
      h("h2", { id: "author-cases-h", class: "section-title" }, TAu().casesTitle),
      table.element,
    ),
  );
  void loadCases();
}
