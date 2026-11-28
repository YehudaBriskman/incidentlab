import { defineStrings, getLang, type Lang } from "./i18n";

// The static About and Privacy pages (#225): #/about and #/privacy (views/pages.ts). Every statement on the Privacy
// page describes what the server and the client actually do; change it together with the code it describes:
// - account record: username, scrypt password hash, recovery-code hash (server/domain/types.ts AccountRecordSchema)
// - guests deleted after 30 days idle (GUEST_IDLE_DAYS, server/services/AccountHygieneService.ts)
// - rate limits keyed by a SHA-256 of the network address, swept within a day (RateLimiter, RATE_LIMIT_STALE_MS)
// - deletes are soft for 7 days (TrashService); the global board is opt-in (showOnGlobalBoard defaults to false).

export type InfoSection = { readonly title: string; readonly items: readonly string[] };

export const TPg = defineStrings({
  en: {
    aboutTitle: "About IncidentLab",
    aboutLead:
      "IncidentLab is a free training site for incident forensics. Each case is a fictional company's outage with realistic evidence: logs, metrics, chat and a git history. You work it end to end, one question at a time, until you can name the root cause.",
    howTitle: "How a case works",
    whoTitle: "Who it's for",
    whoBody:
      "Engineers who want practice reading production evidence, and instructors who run classes and event nights. A class gets its own board, schedule and events.",
    costTitle: "What it costs",
    costBody:
      "Nothing. There are no ads and no paid tier, and you don't need an email address: play as a guest, or create an account with a username and a password.",
    aboutMore: "How your data is handled is on the privacy page.",
    browseCases: "Browse all cases",

    privacyTitle: "Privacy",
    privacyLead: "What IncidentLab stores about you, what it doesn't, and for how long.",
  },
  he: {
    aboutTitle: "אודות IncidentLab",
    aboutLead:
      "IncidentLab הוא אתר אימון חינמי לחקירת תקלות. כל תיק הוא תקלה בחברה בדיונית, עם ראיות מציאותיות: לוגים, מטריקות, צ'אט והיסטוריית git. חוקרים אותו מההתחלה ועד הסוף, שאלה אחר שאלה, עד שמזהים את שורש הבעיה.",
    howTitle: "איך עובד תיק",
    whoTitle: "למי זה מתאים",
    whoBody:
      "למהנדסים שרוצים להתאמן בקריאת ראיות מפרודקשן, ולמדריכים שמעבירים כיתות וערבי אירוע. לכל כיתה יש טבלת מובילים, לוח זמנים ואירועים משלה.",
    costTitle: "כמה זה עולה",
    costBody:
      "כלום. אין פרסומות ואין מסלול בתשלום, ולא צריך כתובת אימייל: אפשר לשחק כאורחים, או לפתוח חשבון עם שם משתמש וסיסמה.",
    aboutMore: "איך הנתונים שלכם נשמרים מוסבר בדף הפרטיות.",
    browseCases: "לכל התיקים",

    privacyTitle: "פרטיות",
    privacyLead: "מה IncidentLab שומר עליכם, מה לא, ולכמה זמן.",
  },
});

/** The privacy page's sections, per language (lists, so they live outside defineStrings). */
const PRIVACY: Readonly<Record<Lang, readonly InfoSection[]>> = {
  en: [
    {
      title: "What we store",
      items: [
        "Your username and a hash of your password (scrypt). The password itself is never stored.",
        "Your progress: which stages you solved, the hints and commands you revealed, how many wrong attempts you made, and when.",
        "Your recovery code, hashed like a password. It is shown to you once, and only you have it.",
        "The classes you join, and whether you appear on the public leaderboard. The board is opt-in and off until you turn it on.",
        "A session cookie that keeps you signed in. It is HttpOnly and used for nothing else.",
      ],
    },
    {
      title: "What we don't collect",
      items: ["No email address, real name or phone number.", "No ads, analytics or third-party trackers."],
    },
    {
      title: "Guests",
      items: [
        "A guest is deleted, with its progress, after 30 days without play.",
        "Create an account before then to keep it: your guest progress moves to the new account.",
      ],
    },
    {
      title: "On your device",
      items: [
        "Your language, theme and display settings, answer drafts and recently visited pages are kept in your browser's local storage. They never leave your device.",
      ],
    },
    {
      title: "Abuse protection and hosting",
      items: [
        "Sign-in, sign-up and guest starts are rate-limited by network address. The address is stored only as a hash, and the record is removed within a day.",
        "The site runs on Netlify, whose servers see standard request data, such as IP addresses, to deliver the pages.",
      ],
    },
    {
      title: "Deleting an account",
      items: ["A deleted account can be restored for 7 days. After that it is removed with its progress."],
    },
  ],
  he: [
    {
      title: "מה אנחנו שומרים",
      items: [
        "שם המשתמש שלכם ו-hash של הסיסמה (scrypt). הסיסמה עצמה אף פעם לא נשמרת.",
        "ההתקדמות שלכם: אילו שלבים פתרתם, אילו רמזים ופקודות חשפתם, כמה תשובות שגויות נתתם, ומתי.",
        "קוד השחזור שלכם, שמור כ-hash כמו סיסמה. הוא מוצג לכם פעם אחת, ורק לכם יש אותו.",
        "הכיתות שהצטרפתם אליהן, והאם אתם מופיעים בטבלת המובילים הציבורית. ההופעה בטבלה כבויה עד שתפעילו אותה.",
        "עוגיית סשן שמשאירה אתכם מחוברים. היא HttpOnly ולא משמשת לשום דבר אחר.",
      ],
    },
    {
      title: "מה אנחנו לא אוספים",
      items: ["לא כתובת אימייל, לא שם אמיתי ולא מספר טלפון.", "אין פרסומות, אין כלי אנליטיקה ואין מעקב של צד שלישי."],
    },
    {
      title: "אורחים",
      items: [
        "אורח נמחק, יחד עם ההתקדמות שלו, אחרי 30 יום בלי משחק.",
        "כדי לשמור את ההתקדמות, פתחו חשבון לפני כן: ההתקדמות שלכם כאורחים עוברת לחשבון החדש.",
      ],
    },
    {
      title: "במכשיר שלכם",
      items: [
        "השפה, ערכת הצבעים והגדרות התצוגה, טיוטות של תשובות ודפים שביקרתם בהם לאחרונה נשמרים באחסון המקומי של הדפדפן. הם לא יוצאים מהמכשיר.",
      ],
    },
    {
      title: "הגנה מפני ניצול לרעה ואחסון",
      items: [
        "כניסה, פתיחת חשבון והתחלת משחק כאורח מוגבלות בקצב לפי כתובת רשת. הכתובת נשמרת רק כ-hash, והרשומה נמחקת תוך יום.",
        "האתר רץ על Netlify, שהשרתים שלה רואים נתוני בקשה רגילים, כמו כתובות IP, כדי להגיש את הדפים.",
      ],
    },
    {
      title: "מחיקת חשבון",
      items: ["חשבון שנמחק אפשר לשחזר במשך 7 ימים. אחרי זה הוא נמחק יחד עם ההתקדמות שלו."],
    },
  ],
};

export const privacySections = (): readonly InfoSection[] => PRIVACY[getLang()];
