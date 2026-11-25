import { defineStrings, formatNumber as num } from "./i18n";

// Case play loop (wave 3): focus and announcements, upfront costs, the answer form, the stepper,
// the toolbox filter and the shared confirm/copy controls. Costs use U+2212 (−), which keeps its
// place before the digits in RTL.
/** Signed amounts as an LTR isolate (LRI…PDI), so "+10" and "−5" keep their sign before the digits in Hebrew. */
const ltr = (text: string): string => `\u2066${text}\u2069`;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const heCount = (n: number, one: string, two: string, many: string): string => (n === 1 ? one : n === 2 ? two : `${n} ${many}`);

export const TP = defineStrings({
  en: {
    // shared controls (lib/dom.ts)
    cancel: "Cancel",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    copiedAnnounce: "Copied to the clipboard.",

    // stepper and progress
    viewing: "viewing",
    stepNow: (n: number, total: number, name: string): string => `Stage ${n} of ${total}: ${name}`,
    progressLine: (solved: number, total: number, score: string, par: string, time: string): string =>
      `${solved} of ${total} stages · Score ${score} pts · par ${par} · Time ${time}`,
    progressLineSetup: (total: number, score: string, par: string): string =>
      `0 of ${total} stages · Score ${score} pts · par ${par} · Clock starts at Stage 1`,

    // focus targets and announcements
    jumpToAnswer: "Jump to the answer ↓",
    solvedAnnounce: (pts: number): string => `Solved. +${pts} points.`,
    revealedAnnounce: (answer: string): string => `Answer revealed: ${answer}. This stage scores 0.`,
    hintAnnounce: (i: number, cost: number): string => `Hint ${i} revealed, −${cost} points.`,

    // the answer form
    checkAnswer: "Check answer",
    checking: "Checking…",
    costNote: (wrong: number, cap: number, clean: number, cleanOpen: boolean): string =>
      `A wrong answer costs ${wrong} pts (at most −${cap} per stage)${cleanOpen ? ` and ends the +${clean} clean bonus` : ""}. An answer in the wrong format is free.`,
    formatMismatch: (format: string): string => `That doesn't match the format (${format}). Nothing was charged; fix it and check again.`,
    wrongValue: (n: number, cost: number): string =>
      `Right format, wrong value (−${cost} pts). ${n} wrong ${plural(n, "answer", "answers")} on this stage.`,
    wrongValueCapped: (n: number, cap: number): string =>
      `Right format, wrong value. ${n} wrong answers; the penalty is capped at −${cap}, so more tries cost nothing extra.`,
    phTime: "HH:MM:SS",
    phInteger: "digits only",
    phIpv4: "N.N.N.N",
    phSha: "7 hex characters",
    phVersion: "X.Y.Z",
    phChange: "CHG-NNNN",
    phOrder: "ORD-XXXXXX",
    phAccessKey: "ASIAXXXXXXXXXXXXXXXX",

    // the live stage meter
    meterUpTo: (n: number): string => `Up to ${n} pts`,
    meterTime: (bonus: number): string => `Time bonus +${bonus}`,
    meterHints: (n: number): string => `Hints ${n > 0 ? `−${n}` : "0"}`,
    meterCommands: (n: number): string => `Commands ${n > 0 ? `−${n}` : "0"}`,
    meterWrong: (n: number, capped: boolean): string => `Wrong ${n > 0 ? `−${n}` : "0"}${capped ? " (cap)" : ""}`,
    hintLabel: (i: number, cost: number): string => `Hint ${i} · −${cost} pts`,
    meterClean: (bonus: number): string => `Clean +${bonus}`,
    meterCleanLost: (bonus: number): string => `Clean +${bonus} lost`,
    meterFirst: (bonus: number): string => `First solver +${bonus}`,
    meterFirstSub: "if nobody solved it yet",

    // hints
    revealHint: (i: number, total: number, cost: number, clean: number, cleanOpen: boolean): string =>
      `Reveal hint ${i} of ${total} (−${cost} pts${cleanOpen ? `, ends the +${clean} clean bonus` : ""})`,

    // full commands
    cmdPrompt: (cost: number, stage: number, clean: number, cleanOpen: boolean): string =>
      `Spend ${cost} pts on stage ${stage}?${cleanOpen ? ` It's your first spend on this stage, so it also ends the +${clean} clean bonus.` : ""}`,
    cmdConfirm: (cost: number): string => `Yes, spend ${cost} pts`,

    // reveal the answer
    revealAnswer: (completion: number, completionOpen: boolean): string =>
      `Stuck? Reveal the answer (0 pts for this stage${completionOpen ? `, −${completion} completion bonus` : ""})`,
    revealPrompt: (stage: number, completion: number, completionOpen: boolean): string =>
      completionOpen
        ? `Reveal the answer to stage ${stage}? This stage scores 0 and you lose the +${completion} completion bonus.`
        : `Reveal the answer to stage ${stage}? This stage scores 0 (the completion bonus is already gone).`,
    revealConfirm: "Yes, reveal the answer",
    keepTrying: "Keep trying",

    // debrief share line
    shareHints: (n: number): string => (n === 0 ? "no hints" : `${n} ${plural(n, "hint", "hints")}`),
    sharePts: (score: number): string => `${num(score)} pts`,
    sharePar: (par: number): string => `par ${num(par)}`,

    // toolbox
    filterLabel: "Filter commands",
    filterHint: "Matches titles, syntax and explanations.",
    filterCount: (n: number, total: number): string => `${n} of ${total} commands`,
    filterNone: "No command matches that filter.",
    jumpTo: "Jump to a section",
  },
  he: {
    cancel: "ביטול",
    copy: "העתקה",
    copied: "הועתק",
    copyFailed: "ההעתקה נכשלה",
    copiedAnnounce: "הועתק ללוח.",

    viewing: "מוצג",
    stepNow: (n: number, total: number, name: string): string => `שלב ${n} מתוך ${total}: ${name}`,
    progressLine: (solved: number, total: number, score: string, par: string, time: string): string =>
      `${solved} מתוך ${total} שלבים · ניקוד ${score} נק' · יעד ${par} · זמן ${time}`,
    progressLineSetup: (total: number, score: string, par: string): string =>
      `0 מתוך ${total} שלבים · ניקוד ${score} נק' · יעד ${par} · השעון מתחיל בשלב 1`,

    jumpToAnswer: "↓ לתשובה",
    solvedAnnounce: (pts: number): string => `נפתר. ${ltr(`+${pts}`)} נקודות.`,
    revealedAnnounce: (answer: string): string => `התשובה נחשפה: ${answer}. השלב מקבל 0.`,
    hintAnnounce: (i: number, cost: number): string => `רמז ${i} נחשף, ${ltr(`−${cost}`)} נקודות.`,

    checkAnswer: "בדיקת התשובה",
    checking: "בודקים…",
    costNote: (wrong: number, cap: number, clean: number, cleanOpen: boolean): string =>
      `תשובה שגויה עולה ${wrong} נק' (עד ${ltr(`−${cap}`)} לשלב)${cleanOpen ? ` ומבטלת את בונוס הפתרון הנקי (${ltr(`+${clean}`)})` : ""}. תשובה בפורמט לא נכון לא עולה כלום.`,
    formatMismatch: (format: string): string => `זה לא תואם את הפורמט (${format}). לא ירדו נקודות; תקנו ובדקו שוב.`,
    wrongValue: (n: number, cost: number): string =>
      `הפורמט נכון, הערך לא (${ltr(`−${cost}`)} נק'). ${heCount(n, "תשובה שגויה אחת", "שתי תשובות שגויות", "תשובות שגויות")} בשלב הזה.`,
    wrongValueCapped: (n: number, cap: number): string =>
      `הפורמט נכון, הערך לא. ${n} תשובות שגויות; הקנס מוגבל ל־${ltr(`−${cap}`)}, כך שניסיונות נוספים לא עולים עוד.`,
    phTime: "HH:MM:SS",
    phInteger: "ספרות בלבד",
    phIpv4: "N.N.N.N",
    phSha: "xxxxxxx (hex)",
    phVersion: "X.Y.Z",
    phChange: "CHG-NNNN",
    phOrder: "ORD-XXXXXX",
    phAccessKey: "ASIAXXXXXXXXXXXXXXXX",

    meterUpTo: (n: number): string => `עד ${n} נק'`,
    meterTime: (bonus: number): string => `בונוס זמן ${ltr(`+${bonus}`)}`,
    meterHints: (n: number): string => `רמזים ${n > 0 ? ltr(`−${n}`) : "0"}`,
    meterCommands: (n: number): string => `פקודות ${n > 0 ? ltr(`−${n}`) : "0"}`,
    meterWrong: (n: number, capped: boolean): string => `שגויות ${n > 0 ? ltr(`−${n}`) : "0"}${capped ? " (תקרה)" : ""}`,
    hintLabel: (i: number, cost: number): string => `רמז ${i} · ${ltr(`−${cost}`)} נק'`,
    meterClean: (bonus: number): string => `פתרון נקי ${ltr(`+${bonus}`)}`,
    meterCleanLost: (bonus: number): string => `פתרון נקי ${ltr(`+${bonus}`)} אבד`,
    meterFirst: (bonus: number): string => `ראשונים לפתור ${ltr(`+${bonus}`)}`,
    meterFirstSub: "אם אף אחד עוד לא פתר",

    revealHint: (i: number, total: number, cost: number, clean: number, cleanOpen: boolean): string =>
      `לחשוף רמז ${i} מתוך ${total} (${ltr(`−${cost}`)} נק'${cleanOpen ? `, מבטל את בונוס הפתרון הנקי ${ltr(`+${clean}`)}` : ""})`,

    cmdPrompt: (cost: number, stage: number, clean: number, cleanOpen: boolean): string =>
      `להוציא ${cost} נק' על חשבון שלב ${stage}?${cleanOpen ? ` זו ההוצאה הראשונה בשלב, ולכן היא מבטלת גם את בונוס הפתרון הנקי (${ltr(`+${clean}`)}).` : ""}`,
    cmdConfirm: (cost: number): string => `כן, להוציא ${cost} נק'`,

    revealAnswer: (completion: number, completionOpen: boolean): string =>
      `תקועים? חשיפת התשובה (0 נק' לשלב${completionOpen ? `, ${ltr(`−${completion}`)} בונוס סיום` : ""})`,
    revealPrompt: (stage: number, completion: number, completionOpen: boolean): string =>
      completionOpen
        ? `לחשוף את התשובה לשלב ${stage}? השלב יקבל 0 ותאבדו את בונוס הסיום (${ltr(`+${completion}`)}).`
        : `לחשוף את התשובה לשלב ${stage}? השלב יקבל 0 (בונוס הסיום כבר אבד).`,
    revealConfirm: "כן, לחשוף את התשובה",
    keepTrying: "להמשיך לנסות",

    shareHints: (n: number): string => (n === 0 ? "ללא רמזים" : heCount(n, "רמז אחד", "שני רמזים", "רמזים")),
    sharePts: (score: number): string => `${num(score)} נק'`,
    sharePar: (par: number): string => `יעד ${num(par)}`,

    filterLabel: "סינון פקודות",
    filterHint: "מחפש בכותרות, בתחביר ובהסברים.",
    filterCount: (n: number, total: number): string => `${n} מתוך ${total} פקודות`,
    filterNone: "אף פקודה לא מתאימה לסינון.",
    jumpTo: "מעבר לקטגוריה",
  },
});
