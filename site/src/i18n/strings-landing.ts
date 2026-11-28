import { defineStrings, getLang } from "./i18n";

// The landing page at #/ (#279, views/landing.ts). The hero's own strings (title, sub, calls to action, trust line)
// stay in strings-onboard.ts, because site/index.html paints a static copy of the hero and keeps them in step.
// The example stage in the hero is illustrative: a made-up service, not from any case (no answers here).

export type PracticeItem = { readonly title: string; readonly body: string };
export type TeachItem = { readonly title: string; readonly body: string };

export const TL = defineStrings({
  en: {
    pageTitle: "IncidentLab: real incidents, real evidence, your RCA",
    dashboardTitle: "Home · IncidentLab",
    crumb: "IncidentLab",
    goDashboard: "Go to your dashboard",
    playSecondary: "Play now",

    // the hero's example stage (a picture of the product: evidence, then the question)
    figureLabel: "An example stage",
    figureCaption: "A stage from a case: search the evidence, then answer the question.",
    figureStage: "Stage 2 of 6",
    figureQuestion: "Which service ran out of database connections first?",
    figureAnswerLabel: "Your answer",
    figureResult: "Correct. Stage 3 is open.",

    howTitle: "How it works",
    how1Title: "Open the evidence",
    how1Body: "Logs, metrics, chat and a git history from a fictional company's bad night. It opens in your browser, and a zip is there for your own terminal.",
    how2Title: "Answer six questions",
    how2Body: "Each stage asks one thing and checks your answer on the server. Stuck? Hints and ready-made commands cost a few points.",
    how3Title: "Read the debrief",
    how3Body: "Once you've named the root cause, read what really happened and see how you scored.",

    casesTitle: "The cases",
    casesLead: "Each case is a fictional outage built on a real-world failure mode. New here? Begin with the one marked Start here: it's short and shows you how a case works.",
    casesLoading: "Loading the cases…",
    casesFailed: "The case list didn't load.",
    casesRetry: "Try again",
    casesAll: "Browse all cases",
    casesEmpty: "No cases are published yet.",

    practiceTitle: "What you'll practise",

    teachTitle: "For teachers and classes",
    teachLead: "Run a case with your class. Everyone works the same outage, at their own pace or against the clock, and nobody needs an email address to join.",
    teachCta: "Set up a class",

    closingTitle: "Try one case, no account needed",
    closingTitleIn: "Pick up where you left off",
    footerLabel: "Site",
  },
  he: {
    pageTitle: "IncidentLab: תקלות אמיתיות, ראיות אמיתיות, ה-RCA שלכם",
    dashboardTitle: "בית · IncidentLab",
    crumb: "IncidentLab",
    goDashboard: "למסך הבית שלכם",
    playSecondary: "לשחק עכשיו",

    figureLabel: "שלב לדוגמה",
    figureCaption: "שלב מתוך תיק: מחפשים בראיות, ואז עונים על השאלה.",
    figureStage: "שלב 2 מתוך 6",
    figureQuestion: "איזה שירות נשאר ראשון בלי חיבורים למסד הנתונים?",
    figureAnswerLabel: "התשובה שלכם",
    figureResult: "נכון. שלב 3 פתוח.",

    howTitle: "איך זה עובד",
    how1Title: "פותחים את הראיות",
    how1Body: "לוגים, מטריקות, צ'אט והיסטוריית git מלילה רע בחברה בדיונית. הכול נפתח בדפדפן, ויש גם קובץ zip לטרמינל שלכם.",
    how2Title: "עונים על שש שאלות",
    how2Body: "כל שלב שואל דבר אחד, והתשובה נבדקת בשרת. נתקעתם? רמזים ופקודות מוכנות עולים כמה נקודות.",
    how3Title: "קוראים את התחקיר",
    how3Body: "אחרי שזיהיתם את שורש הבעיה, קוראים מה באמת קרה ורואים כמה נקודות צברתם.",

    casesTitle: "התיקים",
    casesLead: "כל תיק הוא תקלה בדיונית שבנויה על דפוס כשל מהעולם האמיתי. חדשים כאן? התחילו בתיק שמסומן „מתחילים כאן”: הוא קצר ומראה איך עובד תיק.",
    casesLoading: "טוענים את התיקים…",
    casesFailed: "רשימת התיקים לא נטענה.",
    casesRetry: "לנסות שוב",
    casesAll: "לכל התיקים",
    casesEmpty: "עוד לא פורסמו תיקים.",

    practiceTitle: "מה תתרגלו",

    teachTitle: "למורים ולכיתות",
    teachLead: "מריצים תיק עם הכיתה. כולם חוקרים את אותה תקלה, כל אחד בקצב שלו או נגד השעון, ואף אחד לא צריך כתובת אימייל כדי להצטרף.",
    teachCta: "לפתוח כיתה",

    closingTitle: "נסו תיק אחד, בלי חשבון",
    closingTitleIn: "ממשיכים מאיפה שעצרתם",
    footerLabel: "האתר",
  },
});

const PRACTICE_EN: readonly PracticeItem[] = [
  { title: "Log forensics", body: "Slice nginx and application logs with grep, awk and sort until the pattern shows." },
  { title: "Time zones and clocks", body: "Line up events logged in UTC, local time and epoch seconds, and catch the skew." },
  { title: "Networking", body: "Read packet captures and DNS answers for MTU, ICMP and resolver trouble." },
  { title: "Cloud forensics", body: "Follow who did what in AWS from CloudTrail and IAM records." },
  { title: "Kubernetes", body: "Trace restarts, probes and OOM kills through kubectl output." },
  { title: "Git and releases", body: "Dig through commits and release artefacts for the change that broke things." },
];

const PRACTICE_HE: readonly PracticeItem[] = [
  { title: "חקירת לוגים", body: "לפלח לוגים של nginx ושל האפליקציה עם grep,‏ awk ו‑sort עד שהדפוס מתגלה." },
  { title: "אזורי זמן ושעונים", body: "ליישר אירועים שנרשמו ב‑UTC, בשעון מקומי ובשניות epoch, ולתפוס את הסטייה." },
  { title: "רשתות", body: "לקרוא הקלטות רשת ותשובות DNS ולמצוא בעיות MTU,‏ ICMP ו‑resolver." },
  { title: "חקירה בענן", body: "לעקוב מי עשה מה ב‑AWS מתוך רשומות CloudTrail ו‑IAM." },
  { title: "Kubernetes", body: "לעקוב אחרי הפעלות מחדש, probes ו‑OOM kills בפלט של kubectl." },
  { title: "Git ושחרורי גרסאות", body: "לחפור ב‑commits ובקבצי גרסה עד שמוצאים את השינוי ששבר." },
];

const TEACH_EN: readonly TeachItem[] = [
  { title: "Classes", body: "Invite students with a link or a code, and pick the case of the day." },
  { title: "Event nights", body: "Schedule a timed event. The board freezes when time runs out." },
  { title: "The class board", body: "A leaderboard for your class alone, ready to put on the projector." },
];

const TEACH_HE: readonly TeachItem[] = [
  { title: "כיתות", body: "מזמינים תלמידים בקישור או בקוד, ובוחרים את תיק היום." },
  { title: "ערבי אירוע", body: "קובעים אירוע עם זמן מוגבל. טבלת המובילים ננעלת כשהזמן נגמר." },
  { title: "טבלת הכיתה", body: "טבלת מובילים לכיתה שלכם בלבד, מוכנה להקרנה." },
];

/** The skills list, in the current language. */
export const practiceItems = (): readonly PracticeItem[] => (getLang() === "he" ? PRACTICE_HE : PRACTICE_EN);

/** The teachers' points, in the current language. */
export const teachItems = (): readonly TeachItem[] => (getLang() === "he" ? TEACH_HE : TEACH_EN);
