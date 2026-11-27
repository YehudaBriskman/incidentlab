import { defineStrings } from "./i18n";

// Strings for the opt-in global leaderboard (#175): the switch on #/me, the rank tile, the account menu line
// and the note on the leaderboard page. Usernames are never concatenated in here.

export const TB = defineStrings({
  en: {
    sectionTitle: "Global leaderboard",
    switchLabel: "Show me on the global leaderboard",
    privacyNote: "Off by default. While it's on, your username and score are public on the leaderboard. You can turn it off at any time.",
    shownToast: "You're on the global leaderboard.",
    hiddenToast: "You're hidden from the global leaderboard.",
    saveFailed: "Couldn't change the setting. Try again.",
    guestNote: "Guests aren't listed on the leaderboard. Create an account to appear on it.",
    kpiRank: "Global rank",
    notOnBoard: "Not on the board",
    notOnBoardSub: "Turn on the leaderboard switch to get a rank.",
    menuHidden: "Hidden from the board",
    lbOptInNote: "Only players who chose to appear are listed.",
    lbYouHidden: "You're hidden from this board.",
    lbOptInLink: "Show me on the board",
  },
  he: {
    sectionTitle: "טבלת המובילים העולמית",
    switchLabel: "הציגו אותי בטבלת המובילים העולמית",
    privacyNote: "כבוי כברירת מחדל. כל עוד הוא פועל, שם המשתמש והניקוד שלכם גלויים לכולם בטבלת המובילים. אפשר לכבות אותו בכל רגע.",
    shownToast: "אתם מופיעים בטבלת המובילים העולמית.",
    hiddenToast: "אתם מוסתרים מטבלת המובילים העולמית.",
    saveFailed: "לא הצלחנו לשנות את ההגדרה. נסו שוב.",
    guestNote: "אורחים לא מופיעים בטבלת המובילים. צרו חשבון כדי להופיע בה.",
    kpiRank: "דירוג עולמי",
    notOnBoard: "לא בטבלה",
    notOnBoardSub: "הפעילו את המתג של טבלת המובילים כדי לקבל דירוג.",
    menuHidden: "מוסתר מהטבלה",
    lbOptInNote: "מופיעים כאן רק שחקנים שבחרו להופיע.",
    lbYouHidden: "אתם מוסתרים מהטבלה הזו.",
    lbOptInLink: "הציגו אותי בטבלה",
  },
});
