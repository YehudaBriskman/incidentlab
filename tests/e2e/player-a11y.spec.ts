// axe scan of every main page as the player (#135, #166); the scan itself is in a11y-support.ts.
import { test } from "@playwright/test";
import { axeScan, WIDTHS } from "./a11y-support";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["en", "he"] as const) {
    for (const width of WIDTHS) test(`axe: player, ${lang}, ${scheme}, ${width}px`, axeScan("player", lang, scheme, width));
  }
}
