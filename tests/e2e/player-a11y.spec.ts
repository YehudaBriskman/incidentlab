// axe scan of every main page as the player (#135, #166); the scan itself is in a11y-support.ts.
import { test } from "@playwright/test";
import { axeScan } from "./a11y-support";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["en", "he"] as const) {
    test(`axe: player, ${lang}, ${scheme}`, axeScan("player", lang, scheme));
  }
}
