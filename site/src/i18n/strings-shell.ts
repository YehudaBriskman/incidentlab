import { defineStrings, formatNumber as num } from "./i18n";

/** Signed amounts as an LTR isolate (LRI…PDI), so "−5" keeps its sign before the digits in Hebrew. */
const ltr = (text: string): string => `\u2066${text}\u2069`;

// Strings for the app shell: the navbar, the live strip, the ⚙ display settings menu and the per-page
// sidebar (shell/sidebar.ts plus the sidebar content of the case, toolbox and home views).
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
    shortcuts: "Shortcut keys",
    shortcutsOn: "On",
    shortcutsOff: "Off",
    a11yStatement: "Accessibility statement",

    // sidebar chrome (shell/sidebar.ts)
    sidebarCollapse: "Collapse the sidebar",
    sidebarExpand: "Expand the sidebar",
    sidebarOpen: (label: string): string => `Open ${label}`,

    // case sidebar
    caseSide: "Case navigation",
    caseSideTrigger: "Stages and score",
    sideStages: "Stages",
    sideScore: "Score",
    sideScoreValue: (score: number, par: number): string => `${num(score)} of ${num(par)} pts`,
    sideSolved: (n: number, total: number): string => `${n} of ${total} stages done`,
    sideClock: (time: string): string => `Time ${time}`,
    sideClockSetup: "The clock starts at Stage 1",
    sideTools: "Tools",
    sideToolbox: "Toolbox: all commands",
    sideExplorer: "Evidence Explorer",
    sideBudget: "Hint budget",
    sideHintsUsed: (used: number, total: number, pts: number): string =>
      `${used} of ${total} hints used${pts > 0 ? ` · ${ltr(`−${num(pts)}`)} pts` : ""}`,
    sideCommandsUsed: (n: number, pts: number): string =>
      `${n} ${n === 1 ? "command" : "commands"} revealed${pts > 0 ? ` · ${ltr(`−${num(pts)}`)} pts` : ""}`,
    sideStageHints: (left: number, cost: number): string => `This stage: ${left} ${left === 1 ? "hint" : "hints"} left, the next costs ${num(cost)} pts`,
    sideStageNoHints: "This stage: no hints left",

    // toolbox sidebar
    tbSide: "Toolbox contents",
    tbSideTrigger: "Contents and filter",
    tbShellLegend: "Show commands for",

    // home sidebar
    homeSide: "Filter cases",
    filterDifficulty: "Difficulty",
    filterTags: "Topics",
    filterStatus: "Status",
    statusAny: "All",
    statusNew: "Not started",
    statusProgress: "In progress",
    statusDone: "Completed",
    filterClear: "Clear filters",
    filterShown: (n: number, total: number): string => `${n} of ${total} cases shown`,
    filterNoCases: "No case matches these filters.",

    // admin sidebar (views/admin.ts)
    adminSide: "Dashboard menu",
    adminSideTrigger: "Sections",
    adminSideTriggerOn: (section: string): string => `Sections: ${section}`,
    adminQuick: "Quick actions",
    adminGroupPeople: "People",
    adminGroupLive: "Live",
    adminGroupEvent: "Event",
    adminGroupAudit: "Audit",
    adminProjector: "Projector board",

    // app frame (shell/frame.ts, nav.ts, topbar.ts)
    navHome: "Home",
    logoHome: "IncidentLab home",
    navTodayCase: "Today's case",
    navCollapse: "Collapse navigation",
    navExpand: "Expand navigation",
    navOpen: "Open navigation",
    navDrawer: "Navigation",
    crumbs: "Breadcrumb",
    crumbSignIn: "Sign in",
    caseInvestigation: "Investigation",
    adminSections: "Dashboard sections",
    statusToday: "Today",
    statusTodayTitle: (title: string, next: string): string => `Today's case: \u2068${title}\u2069. The next case starts in ${next}.`,
    statusOffline: "Offline",
    accountButton: (name: string): string => `Account: \u2068${name}\u2069`,
    accountPanel: "Account",
    roleAdmin: "Instructor",
    roleAuthor: "Author",
    rolePlayer: "Player",

    // filterButton() (components/filterPopover.ts)
    filterButton: "Filter",
    filterButtonCount: (n: number): string => `Filter, ${n} active`,
    filterClearAll: "Clear all",
    filterPanel: "Filters",
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
    shortcuts: "מקשי קיצור",
    shortcutsOn: "פעילים",
    shortcutsOff: "כבויים",
    a11yStatement: "הצהרת נגישות",

    sidebarCollapse: "כיווץ סרגל הצד",
    sidebarExpand: "הרחבת סרגל הצד",
    sidebarOpen: (label: string): string => `פתיחת ${label}`,

    caseSide: "ניווט בתיק",
    caseSideTrigger: "שלבים וניקוד",
    sideStages: "שלבים",
    sideScore: "ניקוד",
    sideScoreValue: (score: number, par: number): string => `${num(score)} מתוך ${num(par)} נק׳`,
    sideSolved: (n: number, total: number): string => `${n} מתוך ${total} שלבים הושלמו`,
    sideClock: (time: string): string => `זמן ${time}`,
    sideClockSetup: "השעון מתחיל בשלב 1",
    sideTools: "כלים",
    sideToolbox: "ארגז הכלים: כל הפקודות",
    sideExplorer: "סייר הראיות",
    sideBudget: "תקציב רמזים",
    sideHintsUsed: (used: number, total: number, pts: number): string =>
      `נוצלו ${used} מתוך ${total} רמזים${pts > 0 ? ` · ${ltr(`−${num(pts)}`)} נק׳` : ""}`,
    sideCommandsUsed: (n: number, pts: number): string =>
      `${n === 1 ? "נחשפה פקודה אחת" : `נחשפו ${n} פקודות`}${pts > 0 ? ` · ${ltr(`−${num(pts)}`)} נק׳` : ""}`,
    sideStageHints: (left: number, cost: number): string =>
      `בשלב הזה: ${left === 1 ? "נותר רמז אחד" : `נותרו ${left} רמזים`}, הבא עולה ${num(cost)} נק׳`,
    sideStageNoHints: "בשלב הזה לא נותרו רמזים",

    tbSide: "תוכן ארגז הכלים",
    tbSideTrigger: "תוכן וסינון",
    tbShellLegend: "הצגת פקודות עבור",

    homeSide: "סינון תיקים",
    filterDifficulty: "רמת קושי",
    filterTags: "נושאים",
    filterStatus: "מצב",
    statusAny: "הכול",
    statusNew: "טרם התחיל",
    statusProgress: "בתהליך",
    statusDone: "הושלם",
    filterClear: "ניקוי הסינון",
    filterShown: (n: number, total: number): string => `מוצגים ${n} מתוך ${total} תיקים`,
    filterNoCases: "אין תיק שמתאים לסינון.",

    adminSide: "תפריט לוח הבקרה",
    adminSideTrigger: "אזורים",
    adminSideTriggerOn: (section: string): string => `אזורים: ${section}`,
    adminQuick: "פעולות מהירות",
    adminGroupPeople: "אנשים",
    adminGroupLive: "בזמן אמת",
    adminGroupEvent: "אירוע",
    adminGroupAudit: "ביקורת",
    adminProjector: "לוח למקרן",

    navHome: "בית",
    logoHome: "IncidentLab, דף הבית",
    navTodayCase: "התיק של היום",
    navCollapse: "כיווץ הניווט",
    navExpand: "הרחבת הניווט",
    navOpen: "פתיחת הניווט",
    navDrawer: "ניווט",
    crumbs: "פירורי לחם",
    crumbSignIn: "כניסה",
    caseInvestigation: "החקירה",
    adminSections: "אזורי לוח הבקרה",
    statusToday: "היום",
    statusTodayTitle: (title: string, next: string): string => `התיק של היום: \u2068${title}\u2069. התיק הבא מתחיל בעוד ${next}.`,
    statusOffline: "אין חיבור",
    accountButton: (name: string): string => `חשבון: \u2068${name}\u2069`,
    accountPanel: "חשבון",
    roleAdmin: "מדריך",
    roleAuthor: "כותב תיקים",
    rolePlayer: "שחקן",

    filterButton: "סינון",
    filterButtonCount: (n: number): string => `סינון, ${n} פעילים`,
    filterClearAll: "ניקוי הכול",
    filterPanel: "מסננים",
  },
});
