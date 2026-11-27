// The settings page's routes (#219), DOM-free so it runs under `npm run test:client`.
// #/settings redirects to #/settings/account; #/settings/{account,security,privacy,display} are its sections.

export const SETTINGS_SECTIONS = ["account", "security", "privacy", "display"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "account";

export type SettingsRoute = { kind: "redirect"; to: string } | { kind: "section"; section: SettingsSection };

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export const settingsHref = (section: SettingsSection): string => `#/settings/${section}`;

/**
 * Reads the route parts (the hash path split on "/", without the query). Null when the route is not the
 * settings page or names no section it has (the router then shows its 404).
 */
export function parseSettingsRoute(parts: readonly string[]): SettingsRoute | null {
  if (parts[0] !== "settings") return null;
  if (parts.length === 1) return { kind: "redirect", to: settingsHref(DEFAULT_SETTINGS_SECTION) };
  const section = parts[1];
  if (parts.length !== 2 || section === undefined || !isSettingsSection(section)) return null;
  return { kind: "section", section };
}
