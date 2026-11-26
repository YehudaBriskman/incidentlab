---
version: alpha
name: IncidentLab
description: CTF-style incident puzzles where engineers and student cohorts work a realistic outage end to end, from evidence to root cause.
colors:
  primary: "oklch(0.494 0.105 72.3)"
  light:
    canvas: "oklch(0.985 0.003 250)"
    surface: "oklch(1 0 0)"
    surface-2: "oklch(0.969 0.004 250)"
    surface-3: "oklch(0.928 0.006 250)"
    border: "oklch(0.876 0.008 250)"
    border-strong: "oklch(0.592 0.012 250)"
    text: "oklch(0.213 0.02 250)"
    text-muted: "oklch(0.49 0.016 250)"
    accent: "oklch(0.494 0.105 72.3)"
    danger-fg: "oklch(0.525 0.19 27)"
    warning-fg: "oklch(0.515 0.11 65)"
    success-fg: "oklch(0.495 0.13 150)"
    info-fg: "oklch(0.505 0.14 250)"
    on-accent: "oklch(1 0 0)"
  dark:
    canvas: "oklch(0.179 0.006 250)"
    surface: "oklch(0.215 0.008 250)"
    surface-2: "oklch(0.251 0.009 250)"
    surface-3: "oklch(0.292 0.01 250)"
    border: "oklch(0.354 0.012 250)"
    border-strong: "oklch(0.598 0.014 250)"
    text: "oklch(0.954 0.006 250)"
    text-muted: "oklch(0.788 0.014 250)"
    accent: "#f5a524"
    danger-fg: "oklch(0.804 0.112 25)"
    warning-fg: "oklch(0.824 0.14 80)"
    success-fg: "oklch(0.779 0.15 150)"
    info-fg: "oklch(0.794 0.109 250)"
    on-accent: "oklch(0.179 0.006 250)"
typography:
  display:
    fontFamily: Inter
    fontSize: clamp(2rem, 6vw, 3.2rem)
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.03em
  title:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: Inter
    fontSize: 1.0625rem
    fontWeight: 400
    lineHeight: 1.65
  meta:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.08em
  code:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 24px
  "6": 32px
  "7": 48px
  "8": 64px
components:
  button-primary:
    backgroundColor: "{colors.light.accent}"
    textColor: "{colors.light.on-accent}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
    rounded: "{rounded.lg}"
---

<!--
  Decision record for the IncidentLab UI. Read it before any UI change.
  Tokens live in site/src/styles.css (one layer; admin.css and explorer.css only consume roles).
  Open work goes in GitHub issues, never in this file.
-->

# IncidentLab design system v1.0.0

## Overview

IncidentLab is a learning game for engineers: each case is a fictional outage with real-looking evidence (logs, pcaps, configs) and a chain of questions that ends in a root cause and a debrief. Players are working engineers and student cohorts, alone or in a class or event night; an instructor runs the admin dashboard and projects the leaderboard. It should feel like a calm, precise terminal-side tool with one warm signal colour, the on-call pager amber.

- **Profile:** derived, **dev tools × consumer (learning game)**, with the **real-time** and **projector** modifiers.
- **Evidence for the profile:**
  - Dev tools: keyboard-heavy deep work on logs, regexes and shell commands; mono for code and IDs; code panels stay dark; the explorer is an IDE-like tool.
  - Consumer/game: students on phones (390px is a real case), Hebrew users, achievements, streaks, time bonus and a leaderboard. So: 17px reading body, 44px touch targets, expressive motion only at key moments (solve pop, wrong-answer shake).
  - Real-time: event clock, live admin funnel, leaderboard refresh. Numbers use tabular figures and status is never colour-only.
  - Projector: `body.projector` and the admin board need large type and the high-contrast theme.
- **Token set version:** 1.0.0

### Design brief

- **Why would someone open this?** To work a realistic outage end to end. The first question is "what is today's incident, and where was I?"
- **How do they actually use it?** 30–70 minute sessions, often in class or at an event night, on a laptop with a terminal beside it, sometimes on a phone. The instructor uses the admin dashboard on a laptop and projects the leaderboard.
- **What would they want to know next?** "Which command or file tells me this?" (the toolbox and the explorer), then after solving "how did I score, and what really happened?" (the debrief, which is printed or shared).
- **What are we leaving out?** Decorative illustration, marketing gradients, sound, and per-user themes beyond the OS light/dark/contrast settings. The trade-off: the system stays terse and terminal-like, and the brand lives in one colour.
- **Who carries the complexity?** The system: one control-height scale so mixed rows align without per-page fixes; logical properties so Hebrew mirrors without patches; print and forced-colours layers so nobody has to restyle a page to print a debrief or read the admin in Windows high contrast.

| Borrowed pattern | Why it exists in its source | Does the reason hold here? | Decision |
|---|---|---|---|
| Always-dark code/terminal panel (IDEs, docs sites) | Code reads best on the colours it is written in; syntax colours are tuned for dark | Yes: commands are copied into a dark terminal; the explorer is a log viewer | Keep as the "code island" (D1) |
| Projector leaderboard (quiz games) | One shared screen, read from across a room | Yes: event nights and classes | Keep; page override below |
| Account popover menu (multi-account SaaS) | Switch between several accounts | No: one account per player | Not used; header shows plain actions |

## Colors

- One neutral family (hue 250, cool blue-grey, tint 1) in both themes; the light theme is the generated counterpart of the dark one, not a separate warm paper palette.
- **Accent (amber)** is for primary actions, links, focus, selection (tabs, pressed toggles, current row) and the logo. Chrome stays neutral.
  - Light: `#855602` (oklch 0.494 0.105 72.3), 6.0:1 on canvas. Text on an accent tint uses `--accent-strong` (brand-11).
  - Dark: the brand `#f5a524` (deviation D2).
- **Status roles:** `success` (solved, approved, finished), `warning` (stuck, pending, stale, unsaved), `danger` (wrong, rejected, delete, alerts), `info` (live/today/session/frozen). Each has `-fg` and a `-bg` tint (10% light, 16% dark). Status is always also carried by text, an icon or a shape.
- **Buttons on fills:** `--on-accent` and `--on-danger` are white in light and the dark canvas in dark (white on the dark-theme red would be 3:1).
- **Boundaries:** `--border` is for decorative dividers only. Every input, select, checkbox and button edge uses `--border-strong` (>= 3:1, WCAG 1.4.11).
- **Themes:** OS-driven via `prefers-color-scheme`, overridable with `<html data-theme="light|dark">` from the ⚙ menu (`data-contrast="more"` mirrors `prefers-contrast: more`); `prefers-contrast: more` swaps in the generator's contrast-100 values; `forced-colors: active` maps meaning onto system colours (see Accessibility).

## Typography

- **Families:** Inter (Latin UI), Rubik (Hebrew UI; the whole page in Hebrew), JetBrains Mono (code, IDs, commands, clocks). All three are OFL and self-hosted as WOFF2 subsets (latin + hebrew) in `site/public/fonts/`, with `font-display: swap` and metric-matched local fallbacks (`Inter Fallback`, `Rubik Fallback`, `JetBrains Mono Fallback`, from capsize metrics) so the swap barely moves text.
- **Hebrew in Latin stacks:** a Hebrew-only face (`Rubik Hebrew`) sits right after Inter in `--font-sans` and after JetBrains Mono in `--font-mono`. Hebrew user names and mono-styled translated labels render in Rubik on every OS instead of a random system mono.
- **Scale (deviation D3):** 7 steps, `--step--2` 0.75rem (labels, chips) · `--step--1` 0.875rem (meta, small, tables) · `--step-0` 1.0625rem (body, 17px at the default root) · `--step-1` 1.25rem · `--step-2` 1.5rem · `--step-3` clamp(1.75rem, 4vw, 2.4rem) · `--step-4` clamp(2rem, 6vw, 3.2rem). The body size is in rem, so a larger browser default font scales body text too.
- Leading 1.65 for body (Hebrew-safe), 1.25 for headings. Labels: uppercase, `--track-label` 0.08em (never on Hebrew meaning).
- Numbers that align use `font-variant-numeric: tabular-nums` (every pill does).

## Layout

- 4px spacing base, 8 steps (`--space-1…8`: 4, 8, 12, 16, 24, 32, 48, 64). `--gutter` 16px.
- Widths: `--read` 760 (stage, prose), `--page` 1080 (chrome, main), `--page-narrow` 900 (stats, leaderboard), `--page-wide` 1280 (admin).
- Density: comfortable everywhere; admin tables use the same scale with smaller type.
- **App shell:** a grid of navbar, announcement, a reserved sidebar column (#60), main and footer. The navbar row is 56px (`--control-md` + `--space-3`) and spans `--page`; the live strip under it (today's case, event clock, connectivity) hides when empty.
- **Narrow header (≤1024px):** navigation, account and language fold behind a menu button; the row keeps logo, menu and ⚙ (DOM order = visual order). Signed in at 390px the header is the navbar row plus the live strip.

## Elevation & Depth

- Surfaces: `--canvas` < `--surface` (cards) < `--surface-2` (inset, table headers, chips) < `--surface-3` (tracks); `--sunken` for wells.
- Player cards are flat (border only). Admin panels get `--shadow-sm`; toasts and dialogs `--shadow-lg`; the dialog backdrop is `--scrim`.

## Shapes

- Radius base 8: `--radius-xs` 4 (code chips, tracks) · `-sm` 6 · `-md` 8 (buttons, inputs, hints) · `-lg` 12 (cards, panels) · `-xl` 16 · `-full` (pills). `--radius` is an alias of `-lg`.

## Motion

- Durations: `--motion-dur-short` 150ms (micro), `-medium` 240ms, `-long` 400ms (progress, shake), `-data` 900ms (time-bonus meter). Easings: `--motion-ease-standard`, `--motion-ease-enter`.
- Budget: subtle. Expressive only for solve (pop) and wrong answer (shake).
- `prefers-reduced-motion: reduce` removes shake, pop, pulses, the skeleton shimmer and every width transition (progress, meter, funnel, caret, explorer progress).

## Voice & Content Strategy

- Terse and technical; numbers through `Intl`; code, commands, timestamps and IDs are LTR islands in Hebrew.

## Components

| Component | Classes | Tokens |
|---|---|---|
| Button | `.btn` + `-primary`, `-ghost`, `-danger`, `-sm`, `-lg`, `-copy`, `.link-btn` | heights `--control-xs/sm/md/lg` = 28/36/44/52 (xs and sm become 44 on `pointer: coarse`); edge `--border-strong`; `.link-btn` min 24px |
| Input | `.input`, `.admin-input`, `.ex-input`, `.ex-select` | `--surface` fill, `--border-strong` edge, `--radius-md`; `.input` 44, admin/explorer 36 (beside `.btn-sm`) |
| Pill | `.chip`, `.meter-item`, `.event-clock`, `.stuck-badge`, `.status-pill`, `.via-pill`, `.today-tag`, `.hardest-badge`, `.tab-badge`, `.count-badge`, `.admin-session-tag`, `.ex-chip`, `.board-*-chip` | one base rule; tones set `--pill-fg/-bg/-line`: neutral, accent, success, warning, danger, info (`.pill-*` helpers) |
| Table header | `.stats-table thead th`, `.admin-table th`, `.prose thead th`, `.ex-table th` | `--step--2`, uppercase, `--text-muted` on `--surface-2`, `--border-strong` underline |
| Focus ring | global `:focus-visible` | `--focus-width` 2px solid `--focus-ring`, offset `--focus-offset` 2px; inset (-2px) only inside clipped scrollers (shell tabs, explorer rows); `Highlight` in forced colours; `--code-accent` inside the code island |
| Tabs | `.shell-tab[aria-selected]`, `.admin-tab.is-active` | accent tint + 2–3px accent underline; Highlight fill/underline in forced colours |
| Navbar | `.navbar`, `.nav-link[aria-current]`, `.nav-toggle`, `.settings-btn` | 56px row; current page = 2px accent underline (3px inline-start bar in the folded menu, `--dir`); underline in forced colours |
| Display settings | `.settings-panel` (Popover API), `.settings-option` | `--shadow-lg`, `--radius-lg`; checked option = accent tint + accent edge. Applies `data-theme`, `data-text-scale`, `data-motion`, `data-contrast`, `data-spacing` on `<html>` (token overrides only) |
| Data table | `dataTable()` in `src/components/dataTable.ts` → `.dt-wrap.table-wrap` > `table.stats-table.data-table`; `.dt-sort` header buttons with `aria-sort`; `.dt-opt` columns; `.dt-stack` phone cards; `.dt-message`, `.dt-skeleton` | sticky `thead`; numbers `.num` end-aligned with tabular figures; missing values sort last both ways; `.dt-opt` hides below 640px; `.dt-stack` turns each row into a labelled card below 600px (`data-label` per cell); loading = skeleton rows + a `role=status` label; error = `role=alert` + retry. Used by My stats and the leaderboard (admin tables move after the overlay work, #61/#62) |
| Stat tile | `statTile()`, `statGrid()`, `statTileSkeleton()` in `src/components/statGrid.ts` → `.kpi-grid` > `.stat-tile.kpi` | label `--step--2` uppercase muted; value 1.6rem 700 tabular; context lines `.stat-sub` (`.is-up` success, `.is-down` danger); skeleton keeps the tile's footprint |
| Reading layout | `readingLayout()` in `src/components/readingLayout.ts` → `.reading` > `details.toc` + content | `--read` measure; "On this page" contents (`.toc-list`, h3 as `.toc-sub`) only with ≥3 h2/h3 headings; links scroll and focus the heading without touching the hash route; used by the debrief |
| Form field | `formField()`, `formSection()`, `formActions()` in `src/components/formLayout.ts` → `.field`, `.field-label`, `.field-help`, `.field-error`, `.form-section`, `.form-actions` | order: label, hint, error, control; hint + error in `aria-describedby`, error sets `aria-invalid`; `.form-section` = fieldset with legend, `--radius-lg` edge; used by sign-in/sign-up, ready for the upload form |
| Progress | `.progress-*`, `.meter-*`, `.bar*`, `.funnel-*`, `.cell.*` | fills on `--surface-3`/`--border`; forced colours: Canvas track + CanvasText edge + Highlight fill; revealed cells hatched |

## Do's and Don'ts

- Do use roles and steps only; a missing value is a new token (version bump) or a Deviation row.
- Do use logical properties (`inline-start`, `padding-inline`, `inset-inline`); a physical side needs a comment naming why (only the LTR code islands have them).
- Do put accent text on accent tints with `--accent-strong`, never `--accent`.
- Don't use `--border` as an input edge or as text.
- Don't introduce a new pill, table header or focus-ring style; map onto the shared ones.
- Don't add `[dir=rtl]` mirror patches; fix the rule with a logical property (the `--dir` multiplier exists for inset box-shadow markers).

## Generator inputs

| Input | Value |
|---|---|
| hue | 250 |
| tint | 1 |
| accent | #f5a524 |
| contrast | 55 |
| density | comfortable |
| radius | 8 |
| lockAccent | false |
| highContrast | true |

Command: `node <design-system>/scripts/theme.mjs --config design/theme.json --out design/tokens --format css,dtcg,design-md,report`
Report: 300 pairs verified (WCAG 2 text 4.5:1, non-text 3:1; APCA Lc 75 body / 60 text / 30 non-text) in light, dark and both high-contrast themes, 10 lightness adjustments, 16 gamut-mapped colours, 0 failures.

## Stack mapping

- **Stack:** Vite + TypeScript SPA, vanilla CSS (`site/src/styles.css` global; `admin.css` and `explorer.css` lazy-loaded with their views).
- **Loaded files:** `styles.css` holds the only token layer: fonts, scales, colour roles (light, dark, `data-theme`, `prefers-contrast: more`), derived roles, then components, RTL, forced colours and print.
- **Generated values pasted, not imported:** the generator's role values are copied into `styles.css` (ramps, chart, money and density tokens are omitted because nothing uses them). Regenerate with the inputs above and diff the role values when changing them.
- **Alias layer (deprecated names kept so the views keep working):**

| Existing | Role |
|---|---|
| `--bg` | `--canvas` |
| `--muted` | `--text-muted` |
| `--text-2` | mix of `--text` 55% / `--text-muted` (prose and secondary copy; reaches APCA body contrast in dark, unlike the old `#b4bbc8`) |
| `--accent-ink` | `--on-accent` |
| `--ok`, `--ok-soft` | `--success-fg`, `--success-bg` |
| `--bad`, `--bad-soft` | `--danger-fg`, `--danger-bg` |
| `--radius` | `--radius-lg` |
| `--sans`, `--mono` | `--font-sans`, `--font-mono` |
| `--shadow` | `--shadow-md` |
| removed: `--amber*`, `--green*`, `--red*`, `--bg-2`, `--admin-blue*` | accent / success / danger / surface-2 / info roles (admin.css and explorer.css migrated) |

- **App roles beyond the generator:** `--accent-strong` (brand-11 in light), `--accent-soft`, `--accent-line`, `--on-danger`, the `--code-*` island roles, `--control-*`, `--step-*`, `--dir`.

## Page overrides

| Scope | Change | Reason |
|---|---|---|
| Leaderboard projector (`body.projector`, `.lb-page.is-projector`, admin board) | Display type in clamp() sizes, no chrome | Read across a room; the brief's projector modifier |
| Explorer (`.explorer`) | Code island surfaces, smaller controls (36px, 44 on touch) | Dense tool next to a dark log pane |
| Admin (`.admin`) | `--page-wide` 1280, panels with `--shadow-sm` | Instructor dashboard with wide tables |
| Admin below 900px | `--control-xs`, `--control-sm` and `--target-min` set to 44px; Live and Accounts render as cards; checkboxes keep a 24px visible box inside a 44px hit area | The instructor walks the room with a phone or tablet; same values the `pointer: coarse` rule uses |
| Print (`@media print`) | Forced light roles, black on white; chrome, buttons, stepper and progress hidden; code blocks bordered and wrapped; collapsed `details` open; external links print their URL | The debrief and case pages are printed and shared |

## Deviations

| ID | What | Where | Why | Agreed | Revisit |
|---|---|---|---|---|---|
| D1 | Code island stays dark in the light theme (`--code-bg`, `--code-text`, `--code-muted`, `--code-accent`); trips the gate's DR-MIXED-THEME on the explorer | code blocks, answer code, explorer pane | Commands are copied into dark terminals; the log viewer is read like one. All `--code-*` text pairs meet 4.5:1 on `--code-bg` in both themes | design-system audit (#39) | if a light syntax theme is designed |
| D2 | Dark accent kept at brand `#f5a524` instead of the generated `#eaae5e` | dark theme `--accent` | The generated amber is desaturated and weakens the brand; `#f5a524` measures about 9:1 on the dark canvas. Used for text and labels, never body copy | #39 | never, unless the brand changes |
| D3 | Reading type scale (17px body, 7 steps) instead of the generator's 14px dashboard scale | `--step-*` | Long-form reading game, not a dashboard | #39 | — |
| D4 | Explorer viewport text fixed at 12px (`ds-allow D4`) | `.ex-viewport` | The virtual list renders fixed 20px rows (`ROW_H` in `views/explorer.ts`); rem text would clip at larger browser font settings | this change | if the virtual list measures rows |
| D5 | Display sizes for the projector and page titles remain `clamp()` values outside the 7 steps | `.is-projector`, `.admin-board-*`, card and stage titles | Fluid sizes tuned per surface; folding them into one step changes the projector layout | this change | next type pass |

## Accessibility floors

- WCAG 2.2 AA plus APCA (Lc 75 body / 60 text / 30 non-text). Targets 24px everywhere, 44px on `pointer: coarse`.
- **Forced colours:** progress, score and meter bars, admin progress cells, legend keys and funnel use `forced-color-adjust: none` with Canvas/CanvasText/Highlight; selected shell tabs, pressed language buttons and the active admin tab use Highlight; pills and status markers get CanvasText borders.
- **Reflow:** no page-level horizontal scroll at 320px; wide tables scroll inside their wrappers. `body` no longer hides horizontal overflow, so a regression shows up instead of clipping text.
- **Print:** see Page overrides.
- An IS 5568 accessibility statement for the Hebrew UI is still owed (tracked in #39).

## Decision log

- **1.0.1 (2026-11-25):** admin below 900px uses 44px controls and card layouts (Page overrides); the 18px admin checkboxes became 24px with a 44px hit area on touch.
- **1.0.0 (2026-11-25):** initial system from the generator inputs above, mapped onto the existing CSS through an alias layer. Light accent #a85f00 → #855602; warm light neutrals replaced by the hue-250 family; one control-height scale, pill, table header and focus ring; forced-colours and print layers; logical properties for RTL; self-hosted fonts.

## Rendered gate (design-review `gate.mjs`)

Routes: home, case (active stage and solved debrief), toolbox, explorer, stats, leaderboard and admin; light and dark × 1280 and 390 × EN and HE.

| Detector | Before 1.0.0 | 1.0.0 |
|---|---:|---:|
| DR-CONTRAST | 1028 | 0 |
| DR-TARGET-SIZE | 1250 | 4 (explorer "wrap lines" checkbox is 24px inside a 44px label on phones) |
| DR-MIXED-THEME | 4 | 4 (explorer code island, D1) |
| All other detectors | 0 | 0 |

`lint-ui.mjs` over `site/src`: 1 error and 4 warnings before, 0 and 0 after.

## Drift baseline

Counted over `styles.css`, `admin.css` and `explorer.css`, outside custom-property declarations.

| Measure | Before 1.0.0 | 1.0.0 |
|---|---|---|
| Raw colour literals | 24 | 0 (print values are role overrides) |
| Distinct font-size values | 52 | 38 (24 of them clamp() display sizes and em-relative values, D5) |
| Distinct radii | 12 | 9 (6 tokens, plus 2px/3px hairline tracks and 50% dots) |
| Distinct px spacing literals | 26 | 16 (hairlines 1–3px, negative nudges, clamp() bounds) |
| Pill implementations | 13 | 1 base rule with tones |
| Table header styles | 6 | 1 |
| Focus-ring specs | 5 | 1 (plus the inset variant for clipped scrollers) |
| Control heights | 12 | 4 steps |
