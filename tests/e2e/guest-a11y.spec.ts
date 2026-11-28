// axe scan of the guest's pages (#176): the guest banner and the guest account menu; the scan is in a11y-support.ts.
import { test } from "@playwright/test";
import { axeScan, WIDTHS } from "./a11y-support";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["en", "he"] as const) {
    for (const width of WIDTHS) test(`axe: guest, ${lang}, ${scheme}, ${width}px`, axeScan("guest", lang, scheme, width));
  }
}
