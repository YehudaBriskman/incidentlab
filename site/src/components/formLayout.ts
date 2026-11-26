// Form layout (DESIGN.md "Form field"): one labelled field = label, optional hint, inline error, control, in
// that reading order. The hint and the error are linked to the control with aria-describedby, and an error
// sets aria-invalid. Sections group fields under a legend; the actions row holds the submit and secondary
// buttons. Used by sign-in/sign-up (views/auth.ts) and the case upload form.
import { h, type Child } from "../lib/dom";

export type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type FormField<C extends FieldControl = HTMLInputElement> = {
  readonly input: C;
  /** the visible label text (for an error summary or a Show/Hide toggle name) */
  readonly label: string;
  /** label, hint, error slot and control, in reading order */
  readonly nodes: Child[];
  setError(message: string | null): void;
  hasError(): boolean;
};

/**
 * One labelled field. `extra` (e.g. a password Show/Hide toggle) goes after the control so Tab reaches the
 * next field before it. The control must already have an id.
 */
export function formField<C extends FieldControl>(opts: { input: C; label: string; help?: string; extra?: HTMLElement }): FormField<C> {
  const id = opts.input.id;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const errorEl = h("p", { id: errorId, class: "field-error", hidden: true });
  const describe = (): void => {
    const ids = [opts.help ? helpId : null, errorEl.hidden ? null : errorId].filter((v): v is string => v !== null);
    if (ids.length > 0) opts.input.setAttribute("aria-describedby", ids.join(" "));
    else opts.input.removeAttribute("aria-describedby");
  };
  describe();
  return {
    input: opts.input,
    label: opts.label,
    setError(message) {
      errorEl.textContent = message ?? "";
      errorEl.hidden = message === null;
      if (message === null) opts.input.removeAttribute("aria-invalid");
      else opts.input.setAttribute("aria-invalid", "true");
      describe();
    },
    hasError: () => !errorEl.hidden,
    // One group per field, so the label sits closer to its own control than to the previous field.
    nodes: [
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", for: id }, opts.label),
        opts.help ? h("p", { id: helpId, class: "field-help muted small" }, opts.help) : null,
        errorEl,
        opts.input,
        opts.extra ?? null,
      ),
    ],
  };
}

/** A titled group of fields (<fieldset> + <legend>), for longer forms such as the case upload. */
export function formSection(legend: string, ...fields: Child[]): HTMLFieldSetElement {
  return h("fieldset", { class: "form-section" }, h("legend", { class: "form-section-legend" }, legend), fields);
}

/** The buttons row: primary action first in the DOM (it is what Enter submits), wraps on phones. */
export function formActions(...buttons: Child[]): HTMLElement {
  return h("div", { class: "form-actions" }, buttons);
}
