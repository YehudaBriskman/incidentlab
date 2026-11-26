import { defineStrings } from "./i18n";

// Strings for the shared overlay primitives in lib/overlay.ts: dialogs, sheets, menus, toasts and banners.
// Names typed into a confirm are never concatenated in here: the dialog puts them in their own element.

export const TV = defineStrings({
  en: {
    close: "Close",
    cancel: "Cancel",
    confirm: "Confirm",
    dismiss: "Dismiss",
    toastCount: (n: number): string => `×${n}`,
    typeToConfirmBefore: "Type ",
    typeToConfirmAfter: " to confirm.",
    typedNameHint: "The button turns on once the text matches exactly.",
    toneSuccess: "Success:",
    toneInfo: "Info:",
    toneWarning: "Warning:",
    toneError: "Error:",
  },
  he: {
    close: "סגירה",
    cancel: "ביטול",
    confirm: "אישור",
    dismiss: "סגירה",
    toastCount: (n: number): string => `×${n}`,
    typeToConfirmBefore: "הקלידו ",
    typeToConfirmAfter: " לאישור.",
    typedNameHint: "הכפתור יופעל כשהטקסט יתאים בדיוק.",
    toneSuccess: "הצלחה:",
    toneInfo: "מידע:",
    toneWarning: "אזהרה:",
    toneError: "שגיאה:",
  },
});
