// Case authoring (#/author, #66): the instructor and authors upload a case package, see what changed against
// the live version, publish, roll back, delete and restore. The upload itself is shared/upload-client.ts (the
// same code as `scripts/data.ts upload`): it validates the package in the browser, sends only the chunks the
// server lacks (resumable), saves a draft, and publishes only when asked. Answer-key changes that would re-score
// players need an explicit second confirmation.
import { z } from "zod";
import {
  AuthorCasesResponseSchema,
  DeleteCaseResponseSchema,
  RestoreCaseResponseSchema,
  type AuthorCase,
  type FinalizeResponse,
} from "../../shared/author-contract";
import { ErrorBodySchema } from "../../shared/contract";
import { publishCaseVersion, uploadCasePackage, UploadError, type UploadProgress, type UploadTransport } from "../../shared/upload-client";
import { dataTable, type DataTable } from "../components/dataTable";
import { formActions, formField, formSection } from "../components/formLayout";
import { TAu } from "../i18n/strings-author";
import { TA } from "../i18n/strings-account";
import { locale } from "../i18n/i18n";
import { rawApiFetch } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { confirm, menu, toast } from "../lib/overlay";
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
      draw(root);
    })
    .catch((err: unknown) => setChildren(root, h("section", { class: "center-card", role: "alert" }, h("p", {}, errorText(err)))));
}

function draw(root: HTMLElement): void {
  /* ---------- cases table ---------- */
  let cases: readonly AuthorCase[] = [];
  const dateFmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const versionText = (v: number | null): Child => (v === null ? h("span", { class: "muted" }, TAu().none) : `v${v}`);

  const table: DataTable<AuthorCase> = dataTable<AuthorCase>({
    columns: [
      { id: "case", header: TAu().colCase, rowHeader: true, sortValue: (c) => c.title, cell: (c) => [h("bdi", {}, c.title), " ", h("span", { class: "muted small mono", dir: "ltr" }, c.id)] },
      { id: "status", header: TAu().colStatus, sortValue: (c) => c.status, cell: (c) => h("span", { class: `status-pill is-case-${c.status}` }, TAu().statusLabel(c.status)) },
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
    try {
      await publishCaseVersion(send, caseId, version, false);
    } catch (err: unknown) {
      if (!(err instanceof UploadError && err.code === "answer-drift")) throw err;
      const accept = await confirm({ title: TAu().driftTitle, body: TAu().driftBody, confirmLabel: TAu().driftConfirm, tone: "danger", typedName: caseId });
      if (!accept) return;
      await publishCaseVersion(send, caseId, version, true);
    }
    toast({ tone: "success", text: TAu().published(caseId, version) });
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
      return [
        ...(draft ? [{ label: TAu().menuPublish(draft.version), run: () => void publish(c.id, draft.version, false).catch(failToast) }] : []),
        ...(previous ? [{ label: TAu().menuRollback(previous.version), run: () => void publish(c.id, previous.version, true).catch(failToast) }] : []),
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
        if (outcome.published) toast({ tone: "success", text: TAu().published(outcome.draft.caseId, outcome.published.publishedVersion) });
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
      form,
      h("h2", { id: "author-cases-h", class: "section-title" }, TAu().casesTitle),
      table.element,
    ),
  );
  void loadCases();
}
