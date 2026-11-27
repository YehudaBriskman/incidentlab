import { defineStrings, formatNumber, locale } from "./i18n";

// Strings for onboarding and the public pages (wave 3): auth form errors, the pending / rejected / forced
// password screens, 404, the home landing, the stats KPIs and the leaderboard states.
// Values that come from users or content (names, case titles) are never concatenated in here: views put
// them in their own <bdi> next to these fragments.

/** "+835" / "−12" / "0" with the locale's separators and a true minus sign. */
const signed = (n: number): string =>
  new Intl.NumberFormat(locale(), { signDisplay: "exceptZero", maximumFractionDigits: 0 })
    .formatToParts(n)
    .map((p) => (p.type === "minusSign" ? "−" : p.value))
    .join("");

/** "0:47" style clock for short countdowns. */
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export const TO = defineStrings({
  en: {
    // auth form: validation and errors
    errorSummaryTitle: "There is a problem",
    errorTitlePrefix: "Error: ",
    enterUsername: "Enter your username.",
    enterPassword: "Enter your password.",
    enterCurrentPassword: "Enter your current password.",
    enterTempPassword: "Enter the temporary password you signed in with.",
    showField: (label: string): string => `Show ${lowerFirst(label)}`,
    hideField: (label: string): string => `Hide ${lowerFirst(label)}`,
    rateLimited: (seconds: number): string => `Too many attempts for this username. Try again in ${clock(seconds)}.`,
    rateLimitOver: "You can try again now.",
    offline: "Can't reach the server. Check your connection and try again.",
    signInForStats: "Sign in to see your stats",
    skipToContent: "Skip to content",
    footerTagline: "IncidentLab · fictional companies, real failure modes · built for engineers who like a good outage",
    countdownLong: (days: number, hours: number, minutes: number): string => `${formatNumber(days)}d ${formatNumber(hours)}h ${formatNumber(minutes)}m`,

    // pending / rejected
    pendingHi: "Hi ",
    pendingBody: "This account is waiting for approval. This page updates by itself, so you can leave it open.",
    pendingLastChecked: (time: string): string => `Last checked ${time}`,
    pendingApproved: "You're approved. Opening your cases…",
    pendingRejected: "This account wasn't approved.",
    rejectedLead: "The account ",
    rejectedTail: " wasn't approved, so it can't be used. You can create a new account.",
    createNewAccount: "Create a new account",
    backToSignIn: "Back to sign in",

    // forced password change
    pwHelpForcedCarried: "Your password was reset. Choose a new one that only you know.",
    pwChangedContinue: "Password changed. Opening your cases…",

    // 404
    notOnRunbook: "That page is not on the runbook.",
    notFoundHint: "The link may be old, or the page was renamed.",
    toLeaderboard: "Leaderboard",

    // home: signed out
    heroTitle: "Debug realistic production outages, from evidence to root cause.",
    heroSub: "Hands-on incident puzzles for engineers and student cohorts: logs, metrics, chat and a git repo, one question at a time.",
    ctaCreate: "Create account",
    ctaSignIn: "Sign in",
    ctaNote: "Free to play. Create an account and start your first case right away.",
    proofLine: (players: number, stages: number): string =>
      `${formatNumber(players)} ${players === 1 ? "investigator" : "investigators"} on the leaderboard · ${formatNumber(stages)} ${stages === 1 ? "stage" : "stages"} solved`,
    learnTitle: "What you'll practise",
    learn1Title: "Read the evidence like on call",
    learn1Body: "Search and slice real-looking logs, pcaps and configs with grep, awk and sort.",
    learn2Title: "Build the timeline",
    learn2Body: "Line up metrics, chat and git history until the story holds together.",
    learn3Title: "Name the root cause",
    learn3Body: "Answer six short questions, then read the debrief of what really happened.",

    // home: signed in
    welcome: "Welcome back, ",
    resumeKicker: "Continue where you left off",
    resume: "Resume",
    stageOf: (n: number, total: number): string => `Stage ${n} of ${total}`,
    allSolved: (total: number): string => `All ${total} stages done`,
    reviewDebrief: "Review debrief",
    openCase: "Open case",
    todayTag: "Today",

    // case cards
    difficulty: (d: "easy" | "medium" | "hard"): string => (d === "easy" ? "Easy" : d === "medium" ? "Medium" : "Hard"),
    minutes: (n: number): string => `~${n} min`,
    stages: (n: number): string => (n === 1 ? "1 stage" : `${n} stages`),

    // stats
    statsSub: "How you're doing across every released case.",
    kpiScore: "Total score",
    kpiRank: "Class rank",
    kpiCases: "Cases completed",
    kpiStreak: "Daily streak",
    rankOfN: (rank: number, total: number): string => `#${formatNumber(rank)} of ${formatNumber(total)}`,
    rankAlone: (rank: number): string => `#${formatNumber(rank)}`,
    unranked: "Unranked",
    unrankedSub: "Solve a stage to get a rank.",
    vsMedian: (diff: number, median: number): string => `${signed(diff)} vs the global board median (${formatNumber(median)})`,
    ofPar: (pct: number): string => `${formatNumber(pct)}% of par on finished cases`,
    pts: (n: number): string => `${formatNumber(n)} pts`,
    ptsUnit: "pts",
    casesOf: (done: number, total: number): string => `${formatNumber(done)} of ${formatNumber(total)}`,
    inProgress: (n: number): string => `${formatNumber(n)} in progress`,
    streakDays: (n: number): string => (n === 1 ? "1 day" : `${formatNumber(n)} days`),
    streakBest: (n: number): string => `best ${formatNumber(n)} · today's incident, finished on the day`,
    detailTitle: "Details",
    stagesSolved: "Stages solved",
    accuracy: "Accuracy",
    accuracyOf: (pct: string, solved: number, tries: number): string => `${pct} (${formatNumber(solved)} of ${formatNumber(tries)} tries)`,
    noData: "No data",
    perCaseRegion: "Per case results (scrolls sideways)",

    // leaderboard
    lbFrozenTitle: (time: string): string => `Standings frozen at ${time}`,
    lbFrozenTitleNoTime: "Standings are frozen",
    lbFrozenBody: "Points scored after the freeze stay hidden until the instructor unfreezes the board.",
    lbSubLive: "Live standings. Refreshes every 10 seconds.",
    lbSubFrozen: "Frozen standings. The board refreshes, but new points stay hidden.",
    lbSubPaused: "Paused while this tab is hidden.",
    lbEmptyLive: "No scores yet. Solve a stage to appear here.",
    lbEmptyFrozen: "No scores were recorded before the freeze.",
    lbUnrankedRow: "Not ranked yet: solve a stage to get on the board.",
    lbCaptionOverall: "Overall standings",
    lbCaptionCase: (title: string): string => `Standings for ${title}`,
    lbCaptionFrozen: (time: string): string => `, frozen at ${time}`,
    lbExitProjector: "Exit projector (Esc)",
  },
  he: {
    errorSummaryTitle: "יש בעיה",
    errorTitlePrefix: "שגיאה: ",
    enterUsername: "הזינו שם משתמש.",
    enterPassword: "הזינו סיסמה.",
    enterCurrentPassword: "הזינו את הסיסמה הנוכחית.",
    enterTempPassword: "הזינו את הסיסמה הזמנית שאיתה נכנסתם.",
    // starts with the visible word "הצגה" (Label in Name, WCAG 2.5.3)
    showField: (label: string): string => `הצגה: ${label}`,
    hideField: (label: string): string => `הסתרת ${label}`,
    rateLimited: (seconds: number): string => `יותר מדי ניסיונות לשם המשתמש הזה. נסו שוב בעוד ${clock(seconds)}.`,
    rateLimitOver: "אפשר לנסות שוב עכשיו.",
    offline: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
    signInForStats: "היכנסו כדי לראות את הסטטיסטיקות",
    skipToContent: "דילוג לתוכן",
    footerTagline: "IncidentLab · חברות בדיוניות, תקלות אמיתיות · נבנה למהנדסים שאוהבים תקלה טובה",
    countdownLong: (days: number, hours: number, minutes: number): string =>
      `${days === 1 ? "יום 1" : `${formatNumber(days)} ימים`} ${formatNumber(hours)} שע' ${formatNumber(minutes)} דק'`,

    pendingHi: "היי ",
    pendingBody: "החשבון הזה ממתין לאישור. הדף מתעדכן לבד, אפשר להשאיר אותו פתוח.",
    pendingLastChecked: (time: string): string => `בדיקה אחרונה: ${time}`,
    pendingApproved: "החשבון אושר. פותחים את התיקים…",
    pendingRejected: "החשבון הזה לא אושר.",
    rejectedLead: "החשבון ",
    rejectedTail: " לא אושר, ולכן אי אפשר להשתמש בו. אפשר לפתוח חשבון חדש.",
    createNewAccount: "פתיחת חשבון חדש",
    backToSignIn: "חזרה לכניסה",

    pwHelpForcedCarried: "הסיסמה שלכם אופסה. בחרו סיסמה חדשה שרק אתם יודעים.",
    pwChangedContinue: "הסיסמה שונתה. פותחים את התיקים…",

    notOnRunbook: "הדף הזה לא מופיע בספר הנהלים.",
    notFoundHint: "אולי הקישור ישן, או שהדף קיבל שם אחר.",
    toLeaderboard: "טבלת מובילים",

    heroTitle: "חקרו תקלות פרודקשן מציאותיות, מהראיות ועד שורש הבעיה.",
    heroSub: "חידות תקלה מעשיות למהנדסים ולכיתות: לוגים, מטריקות, צ'אט ומאגר git, שאלה אחר שאלה.",
    ctaCreate: "פתיחת חשבון",
    ctaSignIn: "כניסה",
    ctaNote: "בחינם. פותחים חשבון ומתחילים את התיק הראשון מיד.",
    proofLine: (players: number, stages: number): string =>
      `${players === 1 ? "חוקר/ת אחד/ת" : `${formatNumber(players)} חוקרים`} בטבלת המובילים · ${stages === 1 ? "שלב אחד נפתר" : `${formatNumber(stages)} שלבים נפתרו`}`,
    learnTitle: "מה תתרגלו",
    learn1Title: "לקרוא ראיות כמו בתורנות",
    learn1Body: "לחפש ולפלח לוגים, הקלטות רשת וקונפיגורציות עם grep,‏ awk ו‑sort.",
    learn2Title: "לבנות ציר זמן",
    learn2Body: "לסדר מטריקות, צ'אט והיסטוריית git עד שהסיפור מתחבר.",
    learn3Title: "לזהות את שורש הבעיה",
    learn3Body: "לענות על שש שאלות קצרות, ואז לקרוא תחקיר של מה שקרה באמת.",

    welcome: "ברוכים השבים, ",
    resumeKicker: "להמשיך מאיפה שעצרתם",
    resume: "להמשיך:",
    stageOf: (n: number, total: number): string => `שלב ${n} מתוך ${total}`,
    allSolved: (total: number): string => `כל ${total} השלבים הושלמו`,
    reviewDebrief: "לתחקיר",
    openCase: "לפתוח את התיק",
    todayTag: "היום",

    difficulty: (d: "easy" | "medium" | "hard"): string => (d === "easy" ? "קל" : d === "medium" ? "בינוני" : "קשה"),
    minutes: (n: number): string => `~${n} דק'`,
    stages: (n: number): string => (n === 1 ? "שלב אחד" : `${n} שלבים`),

    statsSub: "איך אתם מתקדמים בכל התיקים שפורסמו.",
    kpiScore: "ניקוד כולל",
    kpiRank: "דירוג בכיתה",
    kpiCases: "תיקים שהושלמו",
    kpiStreak: "רצף יומי",
    rankOfN: (rank: number, total: number): string => `מקום ${formatNumber(rank)} מתוך ${formatNumber(total)}`,
    rankAlone: (rank: number): string => `מקום ${formatNumber(rank)}`,
    unranked: "ללא דירוג",
    unrankedSub: "פתרו שלב כדי לקבל דירוג.",
    vsMedian: (diff: number, median: number): string => `${signed(diff)} לעומת החציון בלוח הכללי (${formatNumber(median)})`,
    ofPar: (pct: number): string => `${formatNumber(pct)}% מהיעד בתיקים שהושלמו`,
    pts: (n: number): string => `${formatNumber(n)} נק'`,
    ptsUnit: "נק'",
    casesOf: (done: number, total: number): string => `${formatNumber(done)} מתוך ${formatNumber(total)}`,
    inProgress: (n: number): string => `${formatNumber(n)} בתהליך`,
    streakDays: (n: number): string => (n === 1 ? "יום אחד" : n === 2 ? "יומיים" : `${formatNumber(n)} ימים`),
    streakBest: (n: number): string => `שיא ${formatNumber(n)} · התקלה של היום, באותו יום`,
    detailTitle: "פירוט",
    stagesSolved: "שלבים שנפתרו",
    accuracy: "דיוק",
    accuracyOf: (pct: string, solved: number, tries: number): string => `${pct} (${formatNumber(solved)} מתוך ${formatNumber(tries)} ניסיונות)`,
    noData: "אין נתונים",
    perCaseRegion: "תוצאות לפי תיק (גלילה לצדדים)",

    lbFrozenTitle: (time: string): string => `הטבלה הוקפאה ב‑${time}`,
    lbFrozenTitleNoTime: "הטבלה מוקפאת",
    lbFrozenBody: "נקודות שנצברו אחרי ההקפאה מוסתרות עד שהמדריכים יפשירו את הטבלה.",
    lbSubLive: "דירוג חי. מתעדכן כל 10 שניות.",
    lbSubFrozen: "הטבלה מוקפאת. היא ממשיכה להתעדכן, אבל נקודות חדשות מוסתרות.",
    lbSubPaused: "העדכון מושהה כל עוד הלשונית מוסתרת.",
    lbEmptyLive: "עוד אין ניקוד. פתרו שלב כדי להופיע כאן.",
    lbEmptyFrozen: "לא נרשם ניקוד לפני ההקפאה.",
    lbUnrankedRow: "עוד לא בדירוג: פתרו שלב כדי להיכנס לטבלה.",
    lbCaptionOverall: "דירוג כללי",
    lbCaptionCase: (title: string): string => `דירוג עבור ${title}`,
    lbCaptionFrozen: (time: string): string => `, מוקפא ב‑${time}`,
    lbExitProjector: "יציאה ממצב מקרן (Esc)",
  },
});
