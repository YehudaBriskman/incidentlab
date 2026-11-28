import { defineStrings } from "./i18n";

// Event runs (#253): the case page's choice between a class event run and the player's own run, and the status
// line's "Event run · <class>". Class names are never concatenated in here: the view puts them in their own <bdi>.

export const TR = defineStrings({
  en: {
    choiceLabel: "Class event run",
    choiceTitle: "A class event is live on this case",
    choiceBody: "An event run starts this case fresh. Its points count on the class board only, not on the global board or in My stats. Your own run stays as it is.",
    choiceDone: "You finished this case before tonight, so that solve doesn't count on the class board tonight. Play the event run to score for your class.",
    choiceClass: "Class:",
    playEvent: "Play the event run for",
    playEventNote: "(counts on the class board only)",
    continueOwn: "Continue your own run",
    runChip: "Event run",
    runSr: "You're playing the event run of",
    switchOwn: "Switch",
    switchOwnLong: "Switch to your own run",
    switchEvent: "Play the event run",
    runClosed: "That event run isn't open now (the event ended, or you're no longer in the class). You're back on your own run.",
    runRefused: "The event run isn't open now: the event has ended or you're no longer in the class. Switch to your own run to keep playing.",
  },
  he: {
    choiceLabel: "ריצת אירוע של הכיתה",
    choiceTitle: "אירוע כיתה פעיל עכשיו בתיק הזה",
    choiceBody: "ריצת אירוע מתחילה את התיק מחדש. הנקודות שלה נספרות רק בלוח של הכיתה, לא בלוח הכללי ולא בסטטיסטיקה שלי. הריצה שלך נשארת כמו שהיא.",
    choiceDone: "סיימת את התיק הזה לפני הערב, ולכן הפתרון הזה לא נספר הערב בלוח של הכיתה. שחק את ריצת האירוע כדי לצבור נקודות לכיתה.",
    choiceClass: "כיתה:",
    playEvent: "שחק את ריצת האירוע של",
    playEventNote: "(נספרת רק בלוח של הכיתה)",
    continueOwn: "המשך בריצה שלך",
    runChip: "ריצת אירוע",
    runSr: "אתה משחק את ריצת האירוע של",
    switchOwn: "החלף",
    switchOwnLong: "חזור לריצה שלך",
    switchEvent: "שחק את ריצת האירוע",
    runClosed: "ריצת האירוע הזו לא פתוחה עכשיו (האירוע נגמר, או שאתה כבר לא בכיתה). חזרת לריצה שלך.",
    runRefused: "ריצת האירוע לא פתוחה עכשיו: האירוע נגמר או שאתה כבר לא בכיתה. חזור לריצה שלך כדי להמשיך לשחק.",
  },
});
