import { defineStrings, formatNumber as num } from "./i18n";

// The docked "Current question" strip on the Explorer and Toolbox routes (#215). It answers through the same form
// as the case page, so the answer, format and cooldown texts stay in strings-play / strings-player.
const ltr = (text: string): string => `⁦${text}⁩`;

export const TQ = defineStrings({
  en: {
    stripLabel: "Current question",
    loading: "Loading your progress…",
    loadFailed: "Couldn't load your progress, so you can't answer here right now.",
    retry: "Try again",
    signedOutTitle: "Sign in to answer from here",
    signedOutBody: "Your answer, its draft and your score are shared with the case page.",
    signIn: "Sign in on the case page",
    notStarted: "Start the case on the case page (“I'm ready”), then answer from here.",
    openCase: "Open the case",
    complete: "Every stage is done.",
    readDebrief: "Read the debrief",
    solved: (n: number, pts: number): string => `Stage ${n} solved: ${ltr(`+${num(pts)}`)} pts.`,
    nextStage: "Next stage →",
    toDebrief: "Go to the debrief →",
    answerNext: (n: number): string => `Answer stage ${n} here`,
  },
  he: {
    stripLabel: "השאלה הנוכחית",
    loading: "טוענים את ההתקדמות שלכם…",
    loadFailed: "לא הצלחנו לטעון את ההתקדמות שלכם, ולכן אי אפשר לענות כאן כרגע.",
    retry: "לנסות שוב",
    signedOutTitle: "היכנסו כדי לענות מכאן",
    signedOutBody: "התשובה, הטיוטה שלה והניקוד משותפים עם דף התיק.",
    signIn: "כניסה בדף התיק",
    notStarted: "התחילו את התיק בדף התיק („מוכן/ה”), ואז ענו מכאן.",
    openCase: "לפתוח את התיק",
    complete: "כל השלבים הושלמו.",
    readDebrief: "לקרוא את התחקיר",
    solved: (n: number, pts: number): string => `שלב ${n} נפתר: ${ltr(`+${num(pts)}`)} נק'.`,
    nextStage: "לשלב הבא ←",
    toDebrief: "לתחקיר ←",
    answerNext: (n: number): string => `לענות כאן על שלב ${n}`,
  },
});
