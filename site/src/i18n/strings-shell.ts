import { defineStrings } from "./i18n";

// Strings for the app shell: the navbar, the live strip and the ⚙ display settings menu.
// Case titles and user names are never concatenated in here: the shell puts them in their own <bdi>.

export const TS = defineStrings({
  en: {
    // navbar
    navMain: "Main",
    navCases: "Cases",
    navToday: "Today",
    navAuthor: "Authoring",
    navMenu: "Menu",

    // live strip
    liveStrip: "Live status",
    stripToday: "Today:",
    stripNextIn: (time: string): string => `next case in ${time}`,

    // ⚙ settings
    settingsButton: "Display settings",
    settingsTitle: "Display settings",
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    textSize: "Text size",
    motion: "Motion",
    motionSystem: "System",
    motionReduce: "Reduce",
    contrast: "Contrast",
    contrastStandard: "Standard",
    contrastHigh: "High",
    spacing: "Text spacing",
    spacingNormal: "Normal",
    spacingWide: "Wide",
    a11yStatement: "Accessibility statement",
  },
  he: {
    navMain: "ראשי",
    navCases: "תיקים",
    navToday: "היום",
    navAuthor: "ניהול תיקים",
    navMenu: "תפריט",

    liveStrip: "מצב חי",
    stripToday: "היום:",
    stripNextIn: (time: string): string => `התיק הבא בעוד ${time}`,

    settingsButton: "הגדרות תצוגה",
    settingsTitle: "הגדרות תצוגה",
    theme: "ערכת צבעים",
    themeSystem: "לפי המערכת",
    themeLight: "בהירה",
    themeDark: "כהה",
    textSize: "גודל טקסט",
    motion: "תנועה",
    motionSystem: "לפי המערכת",
    motionReduce: "מופחתת",
    contrast: "ניגודיות",
    contrastStandard: "רגילה",
    contrastHigh: "גבוהה",
    spacing: "ריווח טקסט",
    spacingNormal: "רגיל",
    spacingWide: "רחב",
    a11yStatement: "הצהרת נגישות",
  },
});
