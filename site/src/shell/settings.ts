// Display settings (the ⚙ menu): theme, text size, motion, contrast and text spacing, plus the desktop
// nav's collapse state (shell/nav.ts; `sidebarCollapsed` is the retired per-page sidebar's, kept so old values parse). They are kept in
// localStorage under SETTINGS_KEY and applied as data-* attributes on <html>. public/settings-boot.js applies
// the same key and shape before first paint (the CSP blocks inline scripts), so keep the two in step.
import { z } from "zod";

export const SETTINGS_KEY = "il.settings";

export const THEMES = ["system", "light", "dark"] as const;
export const TEXT_SCALES = [100, 112.5, 125] as const;
export const MOTIONS = ["system", "reduce"] as const;
export const SPACINGS = ["normal", "wide"] as const;

/** Each field falls back on its own, so one bad or missing value never resets the others. */
export const SettingsSchema = z.object({
  theme: z.enum(THEMES).catch("system"),
  textScale: z.union([z.literal(100), z.literal(112.5), z.literal(125)]).catch(100),
  reducedMotion: z.enum(MOTIONS).catch("system"),
  highContrast: z.boolean().catch(false),
  spacing: z.enum(SPACINGS).catch("normal"),
  /** Desktop sidebar folded to its icon rail (#60). Added later: stored settings without it read as false. */
  sidebarCollapsed: z.boolean().catch(false),
  /** The global nav folded to its icon rail (app frame). Added later: stored settings without it read as false. */
  navCollapsed: z.boolean().catch(false),
  /** Single-key shortcuts such as `/` to search the Toolbox (#214). WCAG 2.1.4: they can be turned off. */
  keyShortcuts: z.boolean().catch(true),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type Theme = Settings["theme"];
export type TextScale = Settings["textScale"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

function parseStored(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = SettingsSchema.safeParse(typeof parsed === "object" && parsed !== null ? parsed : {});
    return result.success ? result.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function loadSettings(): Settings {
  try {
    return parseStored(window.localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS; // storage blocked
  }
}

/** Sets or removes one data-* attribute; the default value never leaves an attribute behind. */
function setAttr(name: string, value: string | null): void {
  if (value === null) document.documentElement.removeAttribute(name);
  else document.documentElement.setAttribute(name, value);
}

export function applySettings(settings: Settings): void {
  setAttr("data-theme", settings.theme === "system" ? null : settings.theme);
  setAttr("data-text-scale", settings.textScale === 100 ? null : String(settings.textScale));
  setAttr("data-motion", settings.reducedMotion === "reduce" ? "reduce" : null);
  setAttr("data-contrast", settings.highContrast ? "more" : null);
  setAttr("data-spacing", settings.spacing === "wide" ? "wide" : null);
  setAttr("data-nav", settings.navCollapsed ? "collapsed" : null);
}

const listeners = new Set<(settings: Settings) => void>();

export function onSettingsChange(fn: (settings: Settings) => void): void {
  listeners.add(fn);
}

/** Saves a change, applies it at once and tells listeners. Storage failures only lose persistence. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const next = SettingsSchema.parse({ ...loadSettings(), ...patch });
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the setting holds for this page load only */
  }
  applySettings(next);
  for (const fn of listeners) fn(next);
  return next;
}
