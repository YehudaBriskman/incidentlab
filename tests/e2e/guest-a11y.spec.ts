// axe scan of the guest's pages (#176): the guest banner and the guest account menu; the scan is in a11y-support.ts.
import { test } from "@playwright/test";
import { axeScan } from "./a11y-support";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["en", "he"] as const) {
    test(`axe: guest, ${lang}, ${scheme}`, axeScan("guest", lang, scheme));
  }
}
