// UI strings for the settings page (#219, views/settings.ts): its sections Account, Security, Privacy and Display,
// the section list, and the "Settings" links on My stats and in the account menu. Usernames are never
// concatenated in here; the view puts them in <bdi>.
import { defineStrings } from "./i18n";
import type { SettingsSection } from "../lib/settings-route";

export const TSe = defineStrings({
  en: {
    title: "Settings",
    sectionsLabel: "Settings sections",
    sectionsTrigger: "Sections",
    account: "Account",
    security: "Security",
    privacy: "Privacy",
    display: "Display & language",
    displayShort: "Display",
    pageTitle: (section: string): string => `${section} · Settings · IncidentLab`,
    loading: "Loading your account…",
    signInTitle: "Sign in to manage your account",
    // Account
    accountIntro: "Who you are on IncidentLab.",
    username: "Username",
    usernameNote: "Usernames can't be changed yet.",
    role: "Role",
    kind: "Account type",
    kindUser: "Account",
    kindGuest: "Guest",
    memberSince: "Member since",
    classesTitle: "Your classes",
    classesLoading: "Loading your classes…",
    sessionTitle: "Session",
    signOutNote: "Signs you out on this device.",
    guestSignOutNote: "A guest can't sign back in. Create an account first to keep your progress.",
    adminNote: "The platform owner's session signs in with the admin key, so it has no password, recovery code or board setting here.",
    // Security
    securityIntro: "Your password and the recovery code that resets it.",
    guestSecurity: "Guests have no password. Create an account to set one, with a recovery code.",
    // Privacy
    privacyIntro: "Choose what other players can see.",
    classBoardsTitle: "Class boards",
    classBoardsNote: "Your classes always see your score on their class board, whatever you choose here.",
    openClasses: "Open your classes",
    // Display
    displayIntro: "Saved on this device only: other devices keep their own display settings.",
    language: "Language",
    // links elsewhere
    statsSettingsLink: "Password, recovery code and leaderboard: Settings",
    menuSettings: "Settings",
  },
  he: {
    title: "הגדרות",
    sectionsLabel: "חלקי ההגדרות",
    sectionsTrigger: "חלקים",
    account: "חשבון",
    security: "אבטחה",
    privacy: "פרטיות",
    display: "תצוגה ושפה",
    displayShort: "תצוגה",
    pageTitle: (section: string): string => `${section} · הגדרות · IncidentLab`,
    loading: "טוענים את החשבון שלכם…",
    signInTitle: "התחברו כדי לנהל את החשבון",
    // Account
    accountIntro: "מי אתם ב-IncidentLab.",
    username: "שם משתמש",
    usernameNote: "עדיין אי אפשר לשנות שם משתמש.",
    role: "תפקיד",
    kind: "סוג חשבון",
    kindUser: "חשבון",
    kindGuest: "אורח",
    memberSince: "חבר/ה מאז",
    classesTitle: "הכיתות שלכם",
    classesLoading: "טוענים את הכיתות שלכם…",
    sessionTitle: "התחברות",
    signOutNote: "מנתק אתכם במכשיר הזה.",
    guestSignOutNote: "אורח לא יכול להתחבר שוב. פתחו חשבון קודם כדי לשמור את ההתקדמות.",
    adminNote: "החיבור של בעלי הפלטפורמה נעשה עם מפתח הניהול, ולכן אין לו כאן סיסמה, קוד שחזור או הגדרת טבלה.",
    // Security
    securityIntro: "הסיסמה שלכם וקוד השחזור שמאפס אותה.",
    guestSecurity: "לאורחים אין סיסמה. פתחו חשבון כדי לקבוע סיסמה וקוד שחזור.",
    // Privacy
    privacyIntro: "בחרו מה שחקנים אחרים יכולים לראות.",
    classBoardsTitle: "טבלאות כיתה",
    classBoardsNote: "הכיתות שלכם תמיד רואות את הניקוד שלכם בטבלת הכיתה, בלי קשר לבחירה כאן.",
    openClasses: "לכיתות שלכם",
    // Display
    displayIntro: "נשמר במכשיר הזה בלבד: במכשירים אחרים נשמרות הגדרות תצוגה משלהם.",
    language: "שפה",
    // links elsewhere
    statsSettingsLink: "סיסמה, קוד שחזור וטבלת המובילים: בהגדרות",
    menuSettings: "הגדרות",
  },
});

/** A section's name: its h2, its crumb, its item in the section list and its part of the page title. */
export function settingsSectionLabel(section: SettingsSection): string {
  const t = TSe();
  return section === "account" ? t.account : section === "security" ? t.security : section === "privacy" ? t.privacy : t.display;
}
