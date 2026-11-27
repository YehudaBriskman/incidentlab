// The display settings as radio groups, drawn by the account menu (language and theme, shell/accountMenu.ts) and
// by #/settings/display (all of them, views/settings.ts). Both read and write the one stored state in
// shell/settings.ts (loadSettings / updateSettings / onSettingsChange), so they always agree.
import { h } from "../lib/dom";
import { getLang, locale } from "../i18n/i18n";
import { TS } from "../i18n/strings-shell";
import { switchLang } from "./lang";
import { MOTIONS, SPACINGS, TEXT_SCALES, THEMES, updateSettings, type Settings } from "./settings";

/** One radio of a display setting; `lang` marks an option written in another language (the language picker). */
export type SettingOption = { value: string; label: string; lang?: string };
/** One display setting as a radio group. Shared with the settings page's Display section (views/settings.ts). */
export type SettingGroup = { name: string; legend: string; options: SettingOption[]; current: string; apply: (value: string) => void };

function percent(scale: number): string {
  return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(scale / 100);
}

/** The display settings as radio groups, in on-screen order (#/settings/display draws them all). */
export function displayGroups(s: Settings): SettingGroup[] {
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
    {
      name: "shortcuts",
      legend: t.shortcuts,
      options: [
        { value: "on", label: t.shortcutsOn },
        { value: "off", label: t.shortcutsOff },
      ],
      current: s.keyShortcuts ? "on" : "off",
      apply: (v) => void updateSettings({ keyShortcuts: v === "on" }),
    },
  ];
}

/**
 * One setting as a fieldset of native radios styled as a segmented control. `namePrefix` keeps two copies on one
 * page (the account menu and the settings page) in separate radio groups.
 */
export function renderSettingGroup(g: SettingGroup, namePrefix = "set"): HTMLFieldSetElement {
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
          { class: "settings-option", lang: o.lang },
          h("input", {
            type: "radio",
            name: `${namePrefix}-${g.name}`,
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

/**
 * The language as a radio group of native names (each option carries its own `lang`). `onSwitch` runs before the
 * switch, so a caller can note that it should take focus back after the re-render (the settings page does).
 */
export function languageGroup(legend: string, onSwitch: (lang: "en" | "he") => void = () => undefined): SettingGroup {
  return {
    name: "lang",
    legend,
    options: [
      { value: "en", label: "English", lang: "en" },
      { value: "he", label: "עברית", lang: "he" },
    ],
    current: getLang(),
    apply: (v) => {
      if (v !== "en" && v !== "he") return;
      onSwitch(v);
      switchLang(v, null);
    },
  };
}

/** The theme on its own: the one display choice the account menu offers inline (the rest are on #/settings/display). */
export function themeGroup(s: Settings): SettingGroup | undefined {
  return displayGroups(s).find((g) => g.name === "theme");
}
