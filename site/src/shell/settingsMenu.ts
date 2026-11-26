// The ⚙ display settings menu: a button and a Popover API panel with one radio group per setting.
// Self-contained on purpose: the overlay module (#61) will absorb the popover plumbing (positioning,
// light dismiss, focus return) into its shared primitives.
import { h, html, setChildren } from "../lib/dom";
import { locale } from "../i18n/i18n";
import { TS } from "../i18n/strings-shell";
import { loadSettings, MOTIONS, onSettingsChange, SPACINGS, TEXT_SCALES, THEMES, updateSettings, type Settings } from "./settings";

const PANEL_ID = "settings-panel";
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

type Option = { value: string; label: string };
type Group = { name: string; legend: string; options: Option[]; current: string; apply: (value: string) => void };

const supportsPopover = (): boolean => typeof HTMLElement.prototype.showPopover === "function";

function percent(scale: number): string {
  return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(scale / 100);
}

function groups(s: Settings): Group[] {
  const t = TS();
  const themeLabel: Record<Settings["theme"], string> = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };
  const motionLabel: Record<Settings["reducedMotion"], string> = { system: t.motionSystem, reduce: t.motionReduce };
  const spacingLabel: Record<Settings["spacing"], string> = { normal: t.spacingNormal, wide: t.spacingWide };
  return [
    {
      name: "theme",
      legend: t.theme,
      options: THEMES.map((v) => ({ value: v, label: themeLabel[v] })),
      current: s.theme,
      apply: (v) => {
        const theme = THEMES.find((x) => x === v);
        if (theme !== undefined) updateSettings({ theme });
      },
    },
    {
      name: "text-scale",
      legend: t.textSize,
      options: TEXT_SCALES.map((v) => ({ value: String(v), label: percent(v) })),
      current: String(s.textScale),
      apply: (v) => {
        const textScale = TEXT_SCALES.find((x) => String(x) === v);
        if (textScale !== undefined) updateSettings({ textScale });
      },
    },
    {
      name: "motion",
      legend: t.motion,
      options: MOTIONS.map((v) => ({ value: v, label: motionLabel[v] })),
      current: s.reducedMotion,
      apply: (v) => {
        const reducedMotion = MOTIONS.find((x) => x === v);
        if (reducedMotion !== undefined) updateSettings({ reducedMotion });
      },
    },
    {
      name: "contrast",
      legend: t.contrast,
      options: [
        { value: "off", label: t.contrastStandard },
        { value: "on", label: t.contrastHigh },
      ],
      current: s.highContrast ? "on" : "off",
      apply: (v) => void updateSettings({ highContrast: v === "on" }),
    },
    {
      name: "spacing",
      legend: t.spacing,
      options: SPACINGS.map((v) => ({ value: v, label: spacingLabel[v] })),
      current: s.spacing,
      apply: (v) => {
        const spacing = SPACINGS.find((x) => x === v);
        if (spacing !== undefined) updateSettings({ spacing });
      },
    },
  ];
}

function renderGroup(g: Group): HTMLFieldSetElement {
  return h(
    "fieldset",
    { class: "settings-group" },
    h("legend", { class: "settings-legend" }, g.legend),
    h(
      "div",
      { class: "settings-options" },
      g.options.map((o) =>
        h(
          "label",
          { class: "settings-option" },
          h("input", {
            type: "radio",
            name: `set-${g.name}`,
            value: o.value,
            checked: o.value === g.current,
            onchange: (ev) => {
              if (ev.currentTarget instanceof HTMLInputElement && ev.currentTarget.checked) g.apply(o.value);
            },
          }),
          h("span", {}, o.label),
        ),
      ),
    ),
  );
}

/** Builds the ⚙ button and its panel; returns them in DOM order (the panel follows the button for Tab). */
export function createSettingsMenu(): HTMLElement[] {
  // An inline SVG gear (currentColor), not the ⚙ character: many systems draw that as a colour emoji.
  const icon = html("span", { class: "icon", "aria-hidden": "true" }, GEAR_SVG);
  const button = h("button", { type: "button", class: "settings-btn", "aria-controls": PANEL_ID, "aria-expanded": "false" }, icon);
  const panel = h("div", { id: PANEL_ID, class: "settings-panel", role: "dialog", "aria-labelledby": `${PANEL_ID}-title` });
  const popover = supportsPopover();
  if (popover) {
    panel.setAttribute("popover", "auto");
    button.setAttribute("popovertarget", PANEL_ID);
  } else {
    panel.hidden = true;
  }

  const isOpen = (): boolean => (popover ? panel.matches(":popover-open") : !panel.hidden);
  const hide = (): void => {
    if (!isOpen()) return;
    if (popover) panel.hidePopover();
    else {
      panel.hidden = true;
      onClosed();
    }
  };

  const draw = (): void => {
    const focused = document.activeElement;
    const focusName = focused instanceof HTMLInputElement && panel.contains(focused) ? focused.name : null;
    button.setAttribute("aria-label", TS().settingsButton);
    button.title = TS().settingsButton;
    setChildren(
      panel,
      h("h2", { id: `${PANEL_ID}-title`, class: "settings-title" }, TS().settingsTitle),
      groups(loadSettings()).map(renderGroup),
      h("a", { class: "settings-link", href: "/accessibility.html" }, TS().a11yStatement),
    );
    if (focusName !== null) panel.querySelector<HTMLInputElement>(`input[name="${focusName}"]:checked`)?.focus();
  };

  // Anchored under the button, its inline-end edge on the button's (so it grows away from the screen edge).
  const place = (): void => {
    const rect = button.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const rtl = document.documentElement.dir === "rtl";
    const edge = Math.max(8, rtl ? rect.left : width - rect.right);
    panel.style.insetBlockStart = `${Math.round(rect.bottom + 8)}px`;
    panel.style.insetInlineEnd = `${Math.round(edge)}px`;
  };

  function onOpened(): void {
    button.setAttribute("aria-expanded", "true");
    place();
    panel.querySelector<HTMLInputElement>("input:checked")?.focus();
  }
  function onClosed(): void {
    button.setAttribute("aria-expanded", "false");
    const active = document.activeElement;
    if (active === null || active === document.body || panel.contains(active)) button.focus();
  }

  if (popover) {
    panel.addEventListener("toggle", (ev) => {
      if (!(ev instanceof ToggleEvent)) return;
      if (ev.newState === "open") onOpened();
      else onClosed();
    });
  } else {
    button.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (panel.hidden) onClosed();
      else onOpened();
    });
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") hide();
    });
  }
  // Tabbing out of the panel closes it (it is not modal), so focus never sits behind an open panel.
  panel.addEventListener("focusout", (ev) => {
    const next = ev.relatedTarget;
    if (next instanceof Node && !panel.contains(next) && next !== button) hide();
  });
  window.addEventListener("resize", () => {
    if (isOpen()) place();
  });
  window.addEventListener("hashchange", draw); // re-label on language change
  onSettingsChange(() => {
    // the radios already show the change; only resync if something else changed the settings
    if (!panel.contains(document.activeElement)) draw();
  });
  draw();
  return [button, panel];
}
