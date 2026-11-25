// Tiny i18n: English (default) + Hebrew (RTL). Language persists in localStorage "il.lang".
// Usage: const T = defineStrings({ en: {...}, he: {...} }); T().someKey
// Commands, code, log lines, file paths stay LTR: wrap them in elements with dir="ltr" (class "ltr").
export type Lang = "en" | "he";
const KEY = "il.lang";

export function getLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "he" || v === "en") return v;
  } catch { /* storage blocked */ }
  return navigator.language.toLowerCase().startsWith("he") ? "he" : "en";
}

export function applyLang(lang: Lang = getLang()): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
}

/** The hash that was re-rendered for a language switch (not a navigation), while the user stays on it. */
let relabelHash: string | null = null;

/**
 * True while the current route is being re-rendered because the language changed. Views use it to keep
 * what the user was looking at (e.g. the stage being viewed) instead of resetting to their defaults.
 */
export function isRelabel(): boolean {
  return relabelHash !== null && relabelHash === window.location.hash;
}

/** Called by the router on every route: a real navigation ends the language re-render. */
export function noteRoute(): void {
  if (relabelHash !== window.location.hash) relabelHash = null;
}

export function setLang(lang: Lang): void {
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked */ }
  applyLang(lang);
  relabelHash = window.location.hash;
  window.dispatchEvent(new HashChangeEvent("hashchange")); // re-render current route in the new language
}

/** BCP 47 locale for Intl formatters in the current language. */
export function locale(lang: Lang = getLang()): string {
  return lang === "he" ? "he-IL" : "en-US";
}

/** Whole numbers with the locale's thousands separator ("1,030"). */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(n);
}

export function defineStrings<S extends Record<string, string | ((...args: never[]) => string)>>(
  dict: { en: S; he: S },
): () => S {
  return () => dict[getLang()];
}
