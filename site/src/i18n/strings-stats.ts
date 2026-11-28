import { defineStrings, formatNumber as num } from "./i18n";
import { TC } from "./strings-challenges";

// Strings for the slimmed My stats page (#240): its four groups, the zero state, achievement progress and the
// history list. Case titles and achievement names are never concatenated in here: the view puts them in <bdi>.

export const TS = defineStrings({
  en: {
    summaryTitle: "Summary",
    progressTitle: "Progress per case",
    historyTitle: "History",
    historyNote: "Your latest finished cases and achievements.",
    histCompleted: "Case finished",
    histEarned: "Achievement earned",
    zeroEyebrow: "Start here",
    zeroTitle: "Your stats start with your first stage",
    zeroBody: "Solve a stage to see your score, accuracy, daily streak and achievements here.",
    zeroPlay: "Play the start-here case",
    zeroBrowse: "Browse the cases",
    firstBloods: (n: number): string => (n === 1 ? "1 first blood" : `${num(n)} first bloods`),
    stagesSolved: (n: number): string => (n === 1 ? "1 stage solved" : `${num(n)} stages solved`),
    streakBest: (n: number): string => `best ${num(n)} · a stage solved each day`,
    achStages: (have: number, need: number): string => `${num(have)} of ${num(need)} stages`,
    achProgress: "Progress",
  },
  he: {
    summaryTitle: "סיכום",
    progressTitle: "התקדמות לפי תיק",
    historyTitle: "היסטוריה",
    historyNote: "התיקים שסיימתם וההישגים האחרונים שלכם.",
    histCompleted: "תיק הושלם",
    histEarned: "הישג חדש",
    zeroEyebrow: "מתחילים כאן",
    zeroTitle: "הנתונים שלכם מתחילים בשלב הראשון",
    zeroBody: "פתרו שלב כדי לראות כאן ניקוד, דיוק, רצף יומי והישגים.",
    zeroPlay: "לשחק בתיק הפתיחה",
    zeroBrowse: "לכל התיקים",
    firstBloods: (n: number): string => (n === 1 ? "דם ראשון אחד" : `${num(n)} פעמים דם ראשון`),
    stagesSolved: (n: number): string => (n === 1 ? "שלב אחד נפתר" : `${num(n)} שלבים נפתרו`),
    streakBest: (n: number): string => `שיא ${num(n)} · שלב שנפתר בכל יום`,
    achStages: (have: number, need: number): string => `${num(have)} מתוך ${num(need)} שלבים`,
    achProgress: "התקדמות",
  },
});

/** "2 of 3 days", "1 of 7 cases", "3 of 5 stages": progress toward a counted achievement in its own unit. */
export function achievementCountText(id: string, have: number, need: number): string {
  if (id === "all-cases") return TC().nextCases(have, need);
  if (id === "no-hints-5") return TS().achStages(have, need);
  return TC().nextDays(have, need);
}
