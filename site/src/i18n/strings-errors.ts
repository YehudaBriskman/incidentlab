import { defineStrings } from "./i18n";

/** Load-failure and auth-loss texts (#208, #209): the "couldn't load" card, the update reload, 401/403. */
export const TE = defineStrings({
  en: {
    // main.ts: the "couldn't load" card (offline, 5xx, failed content, catalog or code)
    loadFailedTitle: "Couldn't load this page",
    loadFailedOffline: "You're offline. It will try again when your connection is back.",
    loadFailedServer: "The IncidentLab server had a problem. Your progress is saved.",
    loadFailedOther: "Something went wrong while loading. Your progress is saved.",
    loadFailedCode: "Part of the site didn't load. Reloading the page usually fixes it.",
    loadFailedPageTitle: "Couldn't load · IncidentLab",
    reloadPage: "Reload page",
    // main.ts: a stale chunk after a deploy
    updatedReloading: "IncidentLab was updated, reloading…",
    // lib/errors.ts: gameplay 401 / 403
    signedOut: "You were signed out. Sign in again to carry on; your answer is kept.",
    forbidden: "You can't do that with this account.",
    // class Live and the admin console: a panel that failed to load
    panelLoadFailed: "Couldn't load this data.",
    staleData: "Showing the last data that loaded.",
    adminLoadFailedTitle: "Couldn't load the console",
  },
  he: {
    loadFailedTitle: "לא הצלחנו לטעון את הדף",
    loadFailedOffline: "אין חיבור לרשת. ננסה שוב כשהחיבור יחזור.",
    loadFailedServer: "לשרת של IncidentLab הייתה תקלה. ההתקדמות שלכם שמורה.",
    loadFailedOther: "משהו השתבש בטעינה. ההתקדמות שלכם שמורה.",
    loadFailedCode: "חלק מהאתר לא נטען. רענון הדף בדרך כלל פותר את זה.",
    loadFailedPageTitle: "לא נטען · IncidentLab",
    reloadPage: "לרענן את הדף",
    updatedReloading: "IncidentLab עודכן, מרעננים…",
    signedOut: "התנתקתם. היכנסו שוב כדי להמשיך; התשובה שלכם נשמרה.",
    forbidden: "אי אפשר לעשות את זה עם החשבון הזה.",
    panelLoadFailed: "לא הצלחנו לטעון את הנתונים.",
    staleData: "מוצגים הנתונים האחרונים שנטענו.",
    adminLoadFailedTitle: "לא הצלחנו לטעון את המסוף",
  },
});
