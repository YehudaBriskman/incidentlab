// A small dialog that sets one whole-number limit (an account's class limit, a class's member limit), from
// lib/overlay.ts. Save stays disabled while the number is out of range, so the dialog never closes on a typo; the
// save itself runs inside the dialog (busy label), and a failure rejects for the caller's banner.
import { T } from "../../i18n/strings-tools";
import { h } from "../../lib/dom";
import { showDialog } from "../../lib/overlay";
import { formField } from "../../components/formLayout";
import { fmtInt } from "./format";

export type LimitDialogOptions = {
  title: string;
  label: string;
  help: string;
  /** the current value; null = the default applies */
  value: number | null;
  /** shown as the placeholder while the default applies */
  defaultValue: number;
  min: number;
  max: number;
  /** offers "Use the default" (saves null) */
  allowDefault: boolean;
  save(value: number | null): Promise<void>;
  returnFocus?: () => HTMLElement | null;
};

/** Resolves to the saved value (null = default), or undefined when cancelled. */
export async function limitDialog(opts: LimitDialogOptions): Promise<number | null | undefined> {
  const input = h("input", {
    type: "number",
    id: "limit-dialog-value",
    class: "admin-input limit-input",
    inputmode: "numeric",
    min: String(opts.min),
    max: String(opts.max),
    step: "1",
    required: !opts.allowDefault,
    placeholder: fmtInt(opts.defaultValue),
    value: opts.value === null ? "" : String(opts.value),
  });
  const field = formField({ input, label: opts.label, help: opts.help });
  const parse = (): number | null | "invalid" => {
    const raw = input.value.trim();
    if (raw === "") return opts.allowDefault ? null : "invalid";
    const n = Number(raw);
    return Number.isInteger(n) && n >= opts.min && n <= opts.max ? n : "invalid";
  };
  let saved: number | null = null;
  const handle = showDialog<"save" | "default" | "cancel">({
    size: "sm",
    title: opts.title,
    className: "limit-dialog",
    body: h("div", { class: "limit-dialog-body" }, field.nodes),
    actions: [
      { value: "cancel", label: T().admCancel },
      ...(opts.allowDefault
        ? [{ value: "default" as const, label: T().admLimitUseDefault(fmtInt(opts.defaultValue)), busyLabel: T().admSaving, run: async () => {
            saved = null;
            await opts.save(null);
          } }]
        : []),
      {
        value: "save",
        label: T().admLimitSave,
        tone: "primary",
        busyLabel: T().admSaving,
        run: async () => {
          const value = parse();
          if (value === "invalid") throw new Error(T().admLimitInvalid(fmtInt(opts.min), fmtInt(opts.max)));
          saved = value;
          await opts.save(value);
        },
      },
    ],
    initialFocus: () => input,
    returnFocus: opts.returnFocus,
  });
  const sync = (): void => {
    const invalid = parse() === "invalid";
    field.setError(invalid && input.value.trim() !== "" ? T().admLimitInvalid(fmtInt(opts.min), fmtInt(opts.max)) : null);
    const save = handle.button("save");
    if (save) save.disabled = invalid;
  };
  input.addEventListener("input", sync);
  sync();
  const result = await handle.result;
  return result === "save" || result === "default" ? saved : undefined;
}
