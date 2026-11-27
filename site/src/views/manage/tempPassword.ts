// The one-time temporary password dialog (#205), shared by the owner's password reset (manage/memberActions.ts)
// and the approval of a teacher-vouched reset request (manage/resetRequests.ts, #254). The password exists only in
// this dialog: it is never stored by the browser, and closing without copying asks first ("Back" reopens it).
import { T } from "../../i18n/strings-tools";
import { copyButton, h } from "../../lib/dom";
import { openDialog } from "../../lib/overlay";
import type { ManageHost } from "./host";

export async function showTemporaryPassword(host: Pick<ManageHost, "askConfirm" | "disposed">, opts: { username: string; password: string; help?: string }): Promise<void> {
  let copied = false;
  for (;;) {
    const copy = copyButton(() => opts.password, T().admCopyPassword);
    copy.addEventListener("click", () => (copied = true));
    await openDialog({
      size: "sm",
      title: T().admTempPwTitle(opts.username),
      className: "admin-pw-dialog",
      body: [
        h("p", { class: "muted" }, opts.help ?? T().admTempPwHelp),
        h("div", { class: "admin-share admin-pw" }, h("code", { class: "admin-share-url admin-pw-value", "data-testid": "temp-password" }, opts.password), copy),
      ],
      actions: [{ value: "done", label: T().admDone, tone: "primary", autofocus: true }],
    });
    if (copied) break;
    const close = await host.askConfirm({
      title: T().admPwUncopiedTitle,
      body: T().admPwUncopiedBody,
      confirmLabel: T().admPwCloseAnyway,
      cancelLabel: T().admPwBack,
      tone: "danger",
    });
    if (close || host.disposed()) break;
  }
}
