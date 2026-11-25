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

export function setLang(lang: Lang): void {
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked */ }
  applyLang(lang);
  window.dispatchEvent(new HashChangeEvent("hashchange")); // re-render current route
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
