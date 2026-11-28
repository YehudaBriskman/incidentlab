---
version: alpha
name: IncidentLab
description: CTF-style incident puzzles where engineers and student cohorts work a realistic outage end to end, from evidence to root cause. Night Shift theme.
colors:
  primary: "oklch(0.7819 0.1585 72.33)"
  light:
    canvas: "oklch(0.972 0.005 80)"
    surface: "oklch(1 0 0)"
    fill-inset: "oklch(0.955 0.006 80)"
    edge-subtle: "oklch(0.89 0.008 75)"
    edge-control: "oklch(0.6 0.012 70)"
    text: "oklch(0.21 0.012 65)"
    text-2: "oklch(0.4 0.014 65)"
    text-3: "oklch(0.5 0.014 65)"
    accent: "oklch(0.7819 0.1585 72.33)"
    on-accent: "oklch(0.17 0.02 65)"
    accent-text: "oklch(0.46 0.1 68)"
    danger-fg: "oklch(0.48 0.18 27)"
    warning-fg: "oklch(0.48 0.14 40)"
    success-fg: "oklch(0.45 0.11 150)"
    info-fg: "oklch(0.46 0.12 255)"
  dark:
    canvas: "oklch(0.165 0.006 70)"
    surface: "oklch(0.205 0.008 70)"
    fill-inset: "oklch(0.25 0.009 70)"
    edge-subtle: "oklch(0.33 0.01 70)"
    edge-control: "oklch(0.6 0.012 70)"
    text: "oklch(0.955 0.005 75)"
    text-2: "oklch(0.875 0.01 72)"
    text-3: "oklch(0.78 0.012 70)"
    accent: "oklch(0.7819 0.1585 72.33)"
    on-accent: "oklch(0.17 0.02 65)"
    accent-text: "oklch(0.87 0.12 82)"
    danger-fg: "oklch(0.875 0.065 25)"
    warning-fg: "oklch(0.87 0.07 48)"
    success-fg: "oklch(0.86 0.11 150)"
    info-fg: "oklch(0.86 0.06 250)"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: clamp(2rem, 1.6rem + 1.6vw, 2.5rem)
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.02em
  page-title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: clamp(1.75rem, 1.5rem + 1vw, 2rem)
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.015em
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 1.375rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.35
  prose:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 1.0625rem
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.35
  kpi:
    fontFamily: "system-ui, -apple-system, Segoe UI, Noto Sans Hebrew, Noto Sans, Arial, sans-serif"
    fontSize: 2rem
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.02em
  code:
    fontFamily: IBM Plex Mono
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: 2px
  sm: 3px
  md: 4px
  lg: 6px
  xl: 8px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 24px
  "6": 32px
  "7": 48px
  "8": 64px
  gap-related: 8px
  gap-stack: 16px
  gap-section: 32px
  gap-region: 48px
  pad-card: 24px
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

# IncidentLab design system v3.0.0 (Soft UI on Night Shift colours)

## Overview

IncidentLab is a learning game for engineers: each case is a fictional outage with real-looking evidence (logs, pcaps, configs) and a chain of questions that ends in a root cause and a debrief. Players are working engineers and student cohorts, alone or in a class or event night; an instructor runs the admin dashboard and projects the leaderboard. It should feel like what an engineer sees at 3 AM with a terminal open beside it (the **Night Shift** direction, #92/#97): warm graphite, one signal colour (the on-call pager amber), time as the organising axis.

- **Profile:** derived, **dev tools × consumer (learning game)**, with the **real-time** and **projector** modifiers.
- **Evidence for the profile:**
  - Dev tools: keyboard-heavy deep work on logs, regexes and shell commands; mono for code and IDs; code panels stay dark; the explorer is an IDE-like tool.
  - Consumer/game: students on phones (390px is a real case), Hebrew users, achievements, streaks, time bonus and a leaderboard. So: a 17px prose role for reading, 44px touch targets, expressive motion only at key moments (solve pop, wrong-answer shake).
  - Real-time: event clock, live admin funnel, leaderboard refresh. Numbers use tabular figures and status is never colour-only.
  - Projector: `body.projector` and the admin board need large type and the high-contrast theme.
- **Token set version:** 3.0.0. Soft UI geometry, depth, motion and type (#104); the colour roles are unchanged from 2.0.0 (Night Shift, #101).

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
| Account popover menu (multi-account SaaS) | Switch between several accounts | Partly: one account per player, but language, theme and the account each had a top-bar control of their own | One account menu for identity, preferences and session, never account switching (#220) |

## Colors

**Night Shift (#97):** warm graphite neutrals (hue 65-80, chroma 0.005-0.014) and one signal, the pager amber `#f5a524`. Every role is OKLCH, written once in `site/src/styles.css` as `light-dark(<light>, <dark>)`; `color-scheme` on `<html>` picks the side (`light dark` by default, `light` or `dark` from `[data-theme]`, `light` in print). High contrast is one block, applied by `@media (prefers-contrast: more)` and by the ⚙ setting `[data-contrast=more]`; the two copies must match.

### Roles

| Group | Role | Job |
|---|---|---|
| Surfaces | `--level-0` … `--level-4` | canvas, card, raised, floating, modal (see Elevation) |
| Fills | `--fill-inset`, `--fill-track`, `--fill-sunken`, `--hover-fill` | table headers, chips and secondary buttons; progress tracks; wells; hover wash |
| Text | `--text-1`, `--text-2`, `--text-3` | primary and links; secondary meta, labels and help (safe at 12px); tertiary, only 16px/600+ or non-essential |
| Edges | `--edge-subtle` | decorative: card and overlay edges, row rules (exempt from 3:1) |
| | `--edge-control` | the edge that identifies a control: inputs, selects, checkboxes (>= 3:1). Not on buttons or tags |
| | `--edge-strong` | rare emphasis: the one strong rule of a table |
| | `--edge-selected` | selected, pressed, current (>= 3:1; dark amber in light, the accent in dark) |
| Accent | `--accent`, `--accent-hover`, `--on-accent` | the amber fill in every theme, always with dark text: primary action, logo, selection bar |
| | `--accent-soft` | selected row or current item fill |
| | `--accent-text` | rare amber text (selected tab label, marks); never body copy |
| Links | `--text-1` + `--link-underline` | links are text-coloured with an amber underline (2px on hover) |
| Status | `--{danger,warning,success,info}-{fg,bg,line}` | text, tinted fill and edge per state; warning is orange (hue 38-48), never brand |
| Focus | `--focus-ring`, `--focus-halo` | 2px ring outside a 2px halo of the page colour (WCAG C40) |
| Overlay | `--scrim`, `--selection-bg`, `--scrollbar-thumb/-track`, `--shadow-color` | 40% warm scrim in light, 50% black in dark; `::selection`; scrollbars |
| Code island | `--code-bg`, `-surface`, `-border`, `-text`, `-muted`, `-accent`, `-accent-text`, `-mark`, `-on-accent`, `-warn-*`, `-danger` | the terminal pane, dark in both themes (D1) |

### Rules

- **Accent budget.** One solid primary per region. The accent never encodes state ("in progress", "you", event time), data (chart bars, scores) or headings. `--accent-soft` means *selected*, never a state.
- **Status map:** live and today = info; in progress = neutral; pending, stuck, unsaved, stale = warning; solved, approved = success; wrong, rejected, delete = danger. Status always also has text, an icon or a shape.
- **Edges.** A text button or a tag needs no 3:1 outline (WCAG 1.4.11 Understanding): secondary buttons are fill plus `--elev-1`, ghost buttons and tags are borderless. `--edge-control` stays on inputs and selects only.
- **High contrast** strengthens hierarchy: darker `--text-2`/`--text-3`, a 5:1+ `--edge-control`, white or near-black surfaces. `--edge-subtle` rises only to about 2:1, so the page does not become a wireframe.
- **No opacity as colour** on text or data; use `--text-3` or a role.
- **Floors** (checked by `scripts/check-contrast.mts`, run by `build-all.sh`): text 4.5:1 and APCA Lc 75; bold labels on fills and `--text-3` 4.5:1 and Lc 60; UI edges, focus and state 3:1 and Lc 30; brand vs warning ΔE_OK >= 0.06.

### Contrast (WCAG 2 ratio · APCA |Lc|)

Output of `node --experimental-strip-types scripts/check-contrast.mts --markdown`: 81 pairs × 4 themes, 0 failures.

| Pair (fg on bg) | Floor | Light | Dark | HC light | HC dark |
|---|---|---|---|---|---|
| `text-1` on `level-0` | 4.5:1 · Lc 75 | 16.4:1 · 99 | 16.9:1 · 98 | 20.1:1 · 106 | 20.0:1 · 106 |
| `text-1` on `level-1` | 4.5:1 · Lc 75 | 17.7:1 · 105 | 15.7:1 · 97 | 20.1:1 · 106 | 19.2:1 · 105 |
| `text-1` on `level-2` | 4.5:1 · Lc 75 | 17.7:1 · 105 | 14.6:1 · 96 | 20.1:1 · 106 | 18.1:1 · 105 |
| `text-1` on `level-3` | 4.5:1 · Lc 75 | 17.7:1 · 105 | 13.4:1 · 95 | 20.1:1 · 106 | 16.6:1 · 104 |
| `text-1` on `level-4` | 4.5:1 · Lc 75 | 17.7:1 · 105 | 12.2:1 · 94 | 20.1:1 · 106 | 14.9:1 · 103 |
| `text-1` on `fill-inset` | 4.5:1 · Lc 75 | 15.6:1 · 96 | 14.0:1 · 96 | 17.4:1 · 96 | 17.6:1 · 105 |
| `text-2` on `level-0` | 4.5:1 · Lc 75 | 8.5:1 · 86 | 13.2:1 · 81 | 14.1:1 · 101 | 16.7:1 · 93 |
| `text-2` on `level-1` | 4.5:1 · Lc 75 | 9.2:1 · 91 | 12.3:1 · 80 | 14.1:1 · 101 | 16.1:1 · 93 |
| `text-2` on `level-2` | 4.5:1 · Lc 75 | 9.2:1 · 91 | 11.4:1 · 80 | 14.1:1 · 101 | 15.2:1 · 92 |
| `text-2` on `level-3` | 4.5:1 · Lc 75 | 9.2:1 · 91 | 10.5:1 · 79 | 14.1:1 · 101 | 13.9:1 · 91 |
| `text-2` on `level-4` | 4.5:1 · Lc 75 | 9.2:1 · 91 | 9.5:1 · 77 | 14.1:1 · 101 | 12.5:1 · 90 |
| `text-2` on `fill-inset` | 4.5:1 · Lc 75 | 8.1:1 · 82 | 11.0:1 · 79 | 12.2:1 · 91 | 14.7:1 · 92 |
| `text-1` on `accent-soft` | 4.5:1 · Lc 75 | 15.6:1 · 96 | 13.3:1 · 95 | 16.9:1 · 94 | 15.6:1 · 103 |
| `text-1` on `selection-bg` | 4.5:1 · Lc 75 | 12.7:1 · 83 | 7.5:1 · 84 | 13.5:1 · 81 | 9.1:1 · 93 |
| `text-1` on `hover-fill` | 4.5:1 · Lc 75 | 14.5:1 · 91 | 14.6:1 · 96 | 17.8:1 · 98 | 17.9:1 · 105 |
| `text-3` on `level-0` (16px/600+ or non-essential only) | 4.5:1 · Lc 60 | 5.5:1 · 74 | 9.6:1 · 63 | 10.9:1 · 95 | 13.4:1 · 78 |
| `text-3` on `level-1` (16px/600+ or non-essential only) | 4.5:1 · Lc 60 | 6.0:1 · 80 | 8.9:1 · 62 | 10.9:1 · 95 | 12.9:1 · 78 |
| `text-3` on `level-2` (16px/600+ or non-essential only) | 4.5:1 · Lc 60 | 6.0:1 · 80 | 8.3:1 · 62 | 10.9:1 · 95 | 12.2:1 · 78 |
| `text-3` on `fill-inset` (16px/600+ or non-essential only) | 4.5:1 · Lc 60 | 5.3:1 · 71 | 8.0:1 · 61 | 9.4:1 · 85 | 11.8:1 · 78 |
| `accent-text` on `level-0` | 4.5:1 · Lc 75 | 6.7:1 · 79 | 12.9:1 · 80 | 10.2:1 · 93 | 15.7:1 · 88 |
| `accent-text` on `level-1` | 4.5:1 · Lc 75 | 7.3:1 · 85 | 12.0:1 · 79 | 10.2:1 · 93 | 15.1:1 · 88 |
| `accent-text` on `level-3` | 4.5:1 · Lc 75 | 7.3:1 · 85 | 10.3:1 · 77 | 10.2:1 · 93 | 13.1:1 · 87 |
| `accent-text` on `fill-inset` | 4.5:1 · Lc 75 | 6.4:1 · 76 | 10.7:1 · 78 | 8.8:1 · 84 | 13.8:1 · 88 |
| `accent-text` on `accent-soft` | 4.5:1 · Lc 75 | 6.4:1 · 76 | 10.1:1 · 77 | 8.6:1 · 82 | 12.3:1 · 86 |
| `on-accent` on `accent` (button labels 14px/600+) | 4.5:1 · Lc 60 | 9.4:1 · 64 | 9.4:1 · 64 | 9.9:1 · 64 | 9.9:1 · 64 |
| `on-accent` on `accent-hover` (button labels 14px/600+) | 4.5:1 · Lc 60 | 11.2:1 · 73 | 11.2:1 · 73 | 11.8:1 · 73 | 11.8:1 · 73 |
| `on-danger` on `danger-fg` (.btn-danger label) | 4.5:1 · Lc 60 | 7.2:1 · 88 | 12.9:1 · 80 | 9.6:1 · 95 | 15.0:1 · 86 |
| `danger-fg` on `danger-bg` | 4.5:1 · Lc 75 | 6.5:1 · 76 | 10.6:1 · 77 | 8.3:1 · 81 | 12.8:1 · 84 |
| `danger-fg` on `level-1` | 4.5:1 · Lc 75 | 7.2:1 · 83 | 12.0:1 · 79 | 9.6:1 · 90 | 14.4:1 · 85 |
| `danger-fg` on `level-0` | 4.5:1 · Lc 75 | 6.6:1 · 77 | 12.9:1 · 80 | 9.6:1 · 90 | 15.0:1 · 85 |
| `danger-line` on `level-1` | 3:1 · Lc 30 | 4.7:1 · 71 | 4.9:1 · 38 | 9.6:1 · 90 | 14.4:1 · 85 |
| `danger-line` on `danger-bg` | 3:1 · Lc 30 | 4.2:1 · 64 | 4.4:1 · 36 | 8.3:1 · 81 | 12.8:1 · 84 |
| `warning-fg` on `warning-bg` | 4.5:1 · Lc 75 | 6.3:1 · 76 | 10.4:1 · 77 | 8.2:1 · 81 | 12.4:1 · 82 |
| `warning-fg` on `level-1` | 4.5:1 · Lc 75 | 7.0:1 · 83 | 11.9:1 · 78 | 9.3:1 · 91 | 14.0:1 · 83 |
| `warning-fg` on `level-0` | 4.5:1 · Lc 75 | 6.4:1 · 78 | 12.8:1 · 79 | 9.3:1 · 91 | 14.6:1 · 84 |
| `warning-line` on `level-1` | 3:1 · Lc 30 | 4.2:1 · 68 | 5.9:1 · 44 | 9.3:1 · 91 | 14.0:1 · 83 |
| `warning-line` on `warning-bg` | 3:1 · Lc 30 | 3.8:1 · 61 | 5.2:1 · 42 | 8.2:1 · 81 | 12.4:1 · 82 |
| `success-fg` on `success-bg` | 4.5:1 · Lc 75 | 6.5:1 · 78 | 10.7:1 · 79 | 8.5:1 · 84 | 13.9:1 · 90 |
| `success-fg` on `level-1` | 4.5:1 · Lc 75 | 7.1:1 · 84 | 12.2:1 · 80 | 9.6:1 · 92 | 15.7:1 · 91 |
| `success-fg` on `level-0` | 4.5:1 · Lc 75 | 6.5:1 · 79 | 13.1:1 · 81 | 9.6:1 · 92 | 16.3:1 · 91 |
| `success-line` on `level-1` | 3:1 · Lc 30 | 4.0:1 · 67 | 5.2:1 · 39 | 9.6:1 · 92 | 15.7:1 · 91 |
| `success-line` on `success-bg` | 3:1 · Lc 30 | 3.7:1 · 61 | 4.6:1 · 37 | 8.5:1 · 84 | 13.9:1 · 90 |
| `info-fg` on `info-bg` | 4.5:1 · Lc 75 | 6.5:1 · 78 | 10.5:1 · 76 | 8.5:1 · 83 | 13.6:1 · 88 |
| `info-fg` on `level-1` | 4.5:1 · Lc 75 | 7.2:1 · 85 | 11.8:1 · 78 | 9.7:1 · 92 | 15.2:1 · 89 |
| `info-fg` on `level-0` | 4.5:1 · Lc 75 | 6.6:1 · 79 | 12.7:1 · 79 | 9.7:1 · 92 | 15.8:1 · 89 |
| `info-line` on `level-1` | 3:1 · Lc 30 | 4.3:1 · 69 | 5.4:1 · 40 | 9.7:1 · 92 | 15.2:1 · 89 |
| `info-line` on `info-bg` | 3:1 · Lc 30 | 3.9:1 · 63 | 4.8:1 · 39 | 8.5:1 · 83 | 13.6:1 · 88 |
| `edge-control` on `level-0` (inputs and selects only) | 3:1 · Lc 30 | 3.6:1 · 61 | 4.9:1 · 34 | 7.5:1 · 86 | 9.6:1 · 60 |
| `edge-control` on `level-1` (inputs and selects only) | 3:1 · Lc 30 | 4.0:1 · 67 | 4.5:1 · 34 | 7.5:1 · 86 | 9.2:1 · 60 |
| `edge-control` on `level-2` (inputs and selects only) | 3:1 · Lc 30 | 4.0:1 · 67 | 4.2:1 · 33 | 7.5:1 · 86 | 8.7:1 · 59 |
| `edge-control` on `level-3` (inputs and selects only) | 3:1 · Lc 30 | 4.0:1 · 67 | 3.9:1 · 32 | 7.5:1 · 86 | 8.0:1 · 58 |
| `edge-control` on `level-4` (inputs and selects only) | 3:1 · Lc 30 | 4.0:1 · 67 | 3.5:1 · 30 | 7.5:1 · 86 | 7.1:1 · 57 |
| `edge-control` on `fill-inset` (inputs and selects only) | 3:1 · Lc 30 | 3.5:1 · 58 | 4.1:1 · 32 | 6.4:1 · 76 | 8.4:1 · 59 |
| `edge-strong` on `level-1` | 3:1 · Lc 30 | 6.8:1 · 84 | 7.2:1 · 52 | 13.7:1 · 100 | 12.9:1 · 78 |
| `edge-strong` on `fill-inset` | 3:1 · Lc 30 | 6.0:1 · 75 | 6.4:1 · 51 | 11.8:1 · 90 | 11.8:1 · 78 |
| `edge-selected` on `level-0` | 3:1 · Lc 30 | 4.4:1 · 67 | 9.4:1 · 63 | 8.7:1 · 89 | 10.1:1 · 63 |
| `edge-selected` on `level-1` | 3:1 · Lc 30 | 4.8:1 · 73 | 8.8:1 · 62 | 8.7:1 · 89 | 9.7:1 · 63 |
| `edge-selected` on `accent-soft` | 3:1 · Lc 30 | 4.2:1 · 64 | 7.4:1 · 60 | 7.3:1 · 78 | 7.9:1 · 61 |
| `focus-ring` on `level-0` | 3:1 · Lc 30 | 6.4:1 · 78 | 9.4:1 · 63 | 10.2:1 · 93 | 10.1:1 · 63 |
| `focus-ring` on `level-1` | 3:1 · Lc 30 | 7.0:1 · 84 | 8.8:1 · 62 | 10.2:1 · 93 | 9.7:1 · 63 |
| `focus-ring` on `level-2` | 3:1 · Lc 30 | 7.0:1 · 84 | 8.2:1 · 61 | 10.2:1 · 93 | 9.1:1 · 62 |
| `focus-ring` on `level-3` | 3:1 · Lc 30 | 7.0:1 · 84 | 7.5:1 · 60 | 10.2:1 · 93 | 8.4:1 · 61 |
| `focus-ring` on `level-4` | 3:1 · Lc 30 | 7.0:1 · 84 | 6.8:1 · 59 | 10.2:1 · 93 | 7.5:1 · 60 |
| `focus-ring` on `fill-inset` | 3:1 · Lc 30 | 6.1:1 · 75 | 7.8:1 · 61 | 8.8:1 · 84 | 8.9:1 · 62 |
| `focus-ring` on `accent-soft` | 3:1 · Lc 30 | 6.1:1 · 75 | 7.4:1 · 60 | 8.6:1 · 82 | 7.9:1 · 61 |
| `focus-ring` on `focus-halo` | 3:1 · Lc 30 | 7.0:1 · 84 | 9.4:1 · 63 | 10.2:1 · 93 | 10.1:1 · 63 |
| `accent` on `level-1` (fill only; light buttons are identified by label and fill) | info | 2.0:1 · 39 | 8.8:1 · 62 | 2.0:1 · 39 | 9.7:1 · 63 |
| `link-underline` on `level-0` | 3:1 · Lc 30 | 3.2:1 · 56 | 9.4:1 · 63 | 8.7:1 · 89 | 10.1:1 · 63 |
| `link-underline` on `level-1` | 3:1 · Lc 30 | 3.5:1 · 62 | 8.8:1 · 62 | 8.7:1 · 89 | 9.7:1 · 63 |
| `scrollbar-thumb` on `scrollbar-track` | 3:1 · Lc 30 | 3.6:1 · 61 | 4.9:1 · 34 | 7.5:1 · 86 | 8.3:1 · 53 |
| `edge-subtle` on `level-1` (decorative) | info | 1.4:1 · 19 | 1.5:1 · 0 | 2.2:1 · 44 | 2.7:1 · 16 |
| `edge-subtle` on `level-0` (decorative) | info | 1.3:1 · 13 | 1.6:1 · 0 | 2.2:1 · 44 | 2.8:1 · 16 |
| `code-text` on `code-bg` | 4.5:1 · Lc 75 | 14.3:1 · 91 | 14.9:1 · 92 | 14.3:1 · 91 | 18.8:1 · 103 |
| `code-text` on `code-surface` | 4.5:1 · Lc 75 | 12.5:1 · 90 | 12.8:1 · 90 | 12.5:1 · 90 | 17.1:1 · 103 |
| `code-muted` on `code-bg` | 4.5:1 · Lc 75 | 11.8:1 · 79 | 12.3:1 · 80 | 11.8:1 · 79 | 15.2:1 · 88 |
| `code-muted` on `code-surface` | 4.5:1 · Lc 75 | 10.3:1 · 78 | 10.6:1 · 78 | 10.3:1 · 78 | 13.9:1 · 88 |
| `code-accent-text` on `code-bg` | 4.5:1 · Lc 75 | 11.7:1 · 79 | 12.3:1 · 79 | 11.7:1 · 79 | 15.7:1 · 90 |
| `code-accent-text` on `code-surface` | 4.5:1 · Lc 75 | 10.3:1 · 77 | 10.6:1 · 78 | 10.3:1 · 77 | 14.3:1 · 90 |
| `code-danger` on `code-bg` | 4.5:1 · Lc 75 | 11.5:1 · 78 | 12.1:1 · 78 | 11.5:1 · 78 | 14.5:1 · 85 |
| `code-danger` on `code-surface` | 4.5:1 · Lc 75 | 10.1:1 · 76 | 10.4:1 · 77 | 10.1:1 · 76 | 13.2:1 · 84 |
| `code-warn-fg` on `code-warn-bg` | 4.5:1 · Lc 75 | 11.2:1 · 83 | 11.2:1 · 83 | 11.2:1 · 83 | 11.2:1 · 83 |
| `code-on-accent` on `code-mark` (highlighted match) | 4.5:1 · Lc 75 | 12.8:1 · 80 | 12.8:1 · 80 | 12.8:1 · 80 | 12.8:1 · 80 |
| `code-on-accent` on `code-accent` (primary button inside the pane) | 4.5:1 · Lc 60 | 9.4:1 · 64 | 9.4:1 · 64 | 9.4:1 · 64 | 9.4:1 · 64 |
| `code-accent` on `code-bg` (focus ring and cursor inside the code island) | 3:1 · Lc 30 | 8.6:1 · 62 | 9.0:1 · 62 | 8.6:1 · 62 | 9.8:1 · 63 |
| `code-border` on `code-bg` (decorative) | info | 1.9:1 · 10 | 1.8:1 · 8 | 1.9:1 · 10 | 5.0:1 · 35 |
| `code-bg` on `level-0` (terminal pane edge) | info | 16.2:1 · 99 | 1.1:1 · 0 | 17.5:1 · 104 | 1.0:1 · 0 |
| `level-1` on `level-0` (surface step) | info | 1.1:1 · 0 | 1.1:1 · 0 | 1.0:1 · 0 | 1.0:1 · 0 |
| `level-2` on `level-1` (surface step) | info | 1.0:1 · 0 | 1.1:1 · 0 | 1.0:1 · 0 | 1.1:1 · 0 |
| `level-3` on `level-2` (surface step) | info | 1.0:1 · 0 | 1.1:1 · 0 | 1.0:1 · 0 | 1.1:1 · 0 |
| `level-4` on `level-3` (surface step) | info | 1.0:1 · 0 | 1.1:1 · 0 | 1.0:1 · 0 | 1.1:1 · 0 |
| `level-4` on `level-0` under scrim (dialog on the scrimmed page) | info | 2.7:1 · 58 | 1.4:1 · 0 | 2.6:1 · 55 | 1.4:1 · 0 |
| `accent` vs `warning-line` (must differ) | ΔE_OK 0.06 | ΔE 0.200 | ΔE 0.125 | ΔE 0.383 | ΔE 0.153 |
| `accent-text` vs `warning-fg` (must differ) | ΔE_OK 0.06 | ΔE 0.073 | ΔE 0.073 | ΔE 0.071 | ΔE 0.062 |
| `edge-selected` vs `warning-line` (must differ) | ΔE_OK 0.06 | ΔE 0.072 | ΔE 0.125 | ΔE 0.063 | ΔE 0.153 |

**Rendered check (2026-11-26):** every visible text node of home, case, Explorer, leaderboard, admin and sign-in in dark and HC dark × EN/HE × 1440/390, measured against its composited background: 3,460 small-text nodes, 52 below Lc 75 (before 2.0.0: 1,304 of 3,508, lowest Lc 58). All 52 are labels on the amber fill (primary buttons at Lc 64, admin tab and count badges), deviation D6.

Where the numbers stop short, and why:
- **`--on-accent` on `--accent` is Lc 64.** `#f5a524` has an APCA ceiling of about Lc 73 even with black text, so the amber fill only carries labels of 14px/600 or more (Lc 60 floor). No 12px badge text on the fill (deviation D6).
- **Light `--accent` against white is 2.0:1.** The fill is not what identifies a light button: its dark label and position do, as with any filled button. Where an amber fill must read as a boundary, add an `--edge-selected` edge.
- **Dark `--text-3` is Lc 61-63**, so it is for 16px/600+ or non-essential meta only; 12-14px secondary text uses `--text-2` (Lc 77-81). The `--text-muted` alias points at `--text-2` for that reason.
- **Dark `--code-bg` sits 1.1:1 against the canvas**: the terminal pane is framed by `--code-border` and its title bar, not by tone.

## Typography

- **Families (3.0.0):**
  - The interface uses the **system font**: `system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Noto Sans", Roboto, Arial, sans-serif`. That is SF Pro on Apple, Segoe UI on Windows and Noto elsewhere, which carries most of the Apple feel, and it costs no download.
  - Code and logs use IBM Plex Mono (400/600, OFL, self-hosted in `site/public/fonts/`, 30 KB, loaded by `unicode-range`), with a metric-matched `Plex Mono Fallback`.
  - Plex Sans and Plex Sans Hebrew were removed. The CSP still needs only `font-src 'self'`.
- **Tracking:** tightens as size grows: h1 −0.015em, h2 −0.01em, h3 −0.005em, 18px and up negative, 12–14px slightly positive. `:lang(he)` resets tracking to normal and never uppercases.
- **Mono means "you can copy this":** commands, code, IDs, log lines. Not labels, clocks or decoration (the sweeps remove those uses).

### Type roles

Each role is four tokens: `--type-<role>-size`, `-lh`, `-weight`, `-track`. Nothing renders below 12px.

| Role | Size | Line-height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| display | clamp(2rem, 1.6rem + 1.6vw, 2.5rem) | 1.1 | 600 | -0.02em | the home welcome only |
| page-title | clamp(1.75rem, 1.5rem + 1vw, 2rem) | 1.2 | 600 | -0.015em | every page `h1` |
| page-title-compact | 1.5rem (24) | 1.25 | 700 (set in `player.css`) | -0.02em | player page `h1` (case, stats, toolbox, author, leaderboard, sign-in) |
| headline | 1.375rem (22) | 1.3 | 600 | -0.01em | `h2`, stage question, section titles (sentence case) |
| title | 1.125rem (18) | 1.35 | 600 | -0.005em | `h3`, card, command and panel titles |
| prose | 1.0625rem (17) | 1.65 | 400 | 0 | case prompt, debrief, hints (max `--measure`) |
| body | 1rem (16) | 1.5 | 400 | 0 | `body`, UI copy, card blurbs, forms |
| small | 0.875rem (14) | 1.45 | 400 | 0 | meta, table cells, buttons, nav |
| label | 0.75rem (12) | 1.35 | 500 | 0 | labels and table headers, **sentence case** (`--label-case: none`), `--text-2` |
| kpi | 2rem (32) | 1.1 | 600 | -0.02em | player and admin stat values, `tabular-nums`, sans not mono |
| code | 0.875rem; inline 0.9em | 1.55 | 400 | 0 | code blocks and inline code |

- **Hebrew (`:root:lang(he)`):** tracking 0 on every role, no `text-transform` and no letter-spacing from any component (a global rule; the text-spacing setting keeps its 0.12em), looser leading (body 1.6, prose 1.75, small 1.55, headings 1.25-1.45) and a 13px label. Emphasis comes from weight, never italics or case.
- **Deprecated steps** map onto roles: `--step--2` label, `--step--1` small, `--step-0` prose, `--step-1` title, `--step-2` headline, `--step-3` page-title, `--step-4` display; `--leading-body` = body line-height, `--leading-tight` = headline line-height, `--track-display` = display tracking. `--track-label` (0.06em, 0 in Hebrew) is kept only for the invite code's spaced characters.
- Numbers that align use `font-variant-numeric: tabular-nums` (every pill does).

## Layout

- 4px spacing base, 8 steps (`--space-1…8`: 4, 8, 12, 16, 24, 32, 48, 64).
- **Spacing roles** (components pick a role, not a step; inside a group < between groups, at every level):

| Token | Value | Phone (< 600px) | Use |
|---|---|---|---|
| `--gap-tight` | 4 | 4 | label to its control, title to its meta, icon to text |
| `--gap-related` | 8 | 8 | items in one group: chips, meta rows, button clusters; space under a heading |
| `--gap-stack` | 16 | 16 | blocks inside a card or section, cards in a grid |
| `--gap-section` | 32 | 24 | between sections of a page (2-3× the space below its heading) |
| `--gap-region` | 48 | 32 | between page regions: hero to content, content to footer |
| `--pad-card` | 24 | 16 | every card, panel, tile and dialog body |
| `--pad-card-lg` | 32 | 20 | the one hero card of a page |
| `--gutter` | 16 / 24 / 32 | | page margin below 600 / 600-1055 / 1056+. **Owned by the shell**: views never add their own inline padding |

- **Widths:** pages **fill the content area** at every width (owner, 2026-11-26: a dashboard leaves no dead side space). `--page` and `--page-wide` no longer cap the frame; `--read` 760 (case stage and debrief column), `--measure` 68ch (every paragraph container). `--page-narrow` 900 is deprecated. Narrow content aligns to the page start edge rather than centring.
- No negative margins and no em spacing outside prose; hairlines are borders, not spacing.
- **Layers:** modals and popovers open in the top layer (ordered by open order). What stays in the page is ordered by tokens: `--z-sidebar` 30 (folded nav panel; the sticky sidebar itself needs no z-index) < `--z-sheet` 40 < `--z-dialog` 50 < `--z-popover` 55 < `--z-toast` 60; the skip link sits one above the toasts. Local sticky offsets inside a view (table headers, tab bars) stay small literals.
- **App frame (#97):** a 100dvh grid: the global nav (start column) beside a slim top bar over the content area. The frame never scrolls as a whole; the nav and the content area (`main.app-content`) scroll on their own. Regions separate by surface tone (nav on `--level-1`, content on the `--level-0` canvas); only the top bar keeps a hairline.
- **Global nav** (`src/shell/nav.ts`): `nav#app-nav[aria-label=Main]`, `--nav-size` 240px (component value). Items Home, Cases, Leaderboard, Classes (everyone, visitors included), My stats, Authoring and Platform console by role (#221; today's case lives in the status chip and on home, not in the nav), icon + label rows of `--control-sm` (44px on coarse pointers). The page on screen is `aria-current=page` with a soft `--fill-inset` fill and weight; the parent of nested items is `aria-current=true` (weight only). Views hang nested items under one item (`ViewResult.nav`): console sections (and the review queue, `#/admin/reviews`) under Platform console, a case's stages, Toolbox and Explorer under Cases. Collapsible to the `--rail-size` icon rail (labels visually hidden, `title` tooltips; `navCollapsed` in settings → `html[data-nav=collapsed]`, also set by `settings-boot.js`); the rail is forced at 641–1024px and the nav leaves the grid at ≤640px. At ≤1024px the top bar's menu button opens the same `<nav>` (moved, never cloned) in a start-edge Sheet. No forms or filters in the nav. The owner's area has one name: Platform console / קונסולת הפלטפורמה (nav, crumb, h1, title); in Hebrew, Authoring is כתיבת תיקים and class management ניהול הכיתה.
- **Top bar** (`src/shell/topbar.ts`): one row of `--control-sm` + `--space-4` (52px), translucent canvas with a backdrop blur and a hairline: menu button (≤1024px), breadcrumb (`nav[aria-label=Breadcrumb]`, last crumb only on phones; a crumb naming user content carries `dir=auto` so it clips at the end of its own text), the status chip (event clock, or today's case and the countdown; a link to the case), the connectivity chip (`role=status`) and **one account menu** (`src/shell/accountMenu.ts`, #220). Signed in, the avatar button (`aria-haspopup=dialog`, `aria-expanded`) opens a non-modal `popover()` panel: the identity header (a link to `#/settings/account`: name in `<bdi>`, role, the class role, global-board status), Create account first for a guest, My stats, Settings, Language and Theme as inline native radio fieldsets, one "Display options…" row (`#/settings/display`), Sign out last and not red, the accessibility statement. Signed out, a "Language and display" icon button beside Sign in opens the same panel without identity and session; that Sign in is a secondary button (a view's one primary is its own) and is hidden on `#/login` and `#/signup` (#223). At ≤640px the same content opens as a bottom Sheet (`openSheet({ side: "bottom" })`, 44px rows). Not `role=menu`: links, a button and radio groups, Tab through, Escape returns focus to the button.
- **Content area:** an optional compact announcement, the page header (`ViewResult.header`; at ≤1024px also the button that opens the page panel), then `.page-body` = optional page panel (`ViewResult.aside`, `--sidebar-size`, sticky with its own scroll above 1024px, a Sheet below) + `#app`. Full content-area width; only reading text (`--read`, `--measure`) is capped. `layout: "fit"` (dashboards) pins the page to the viewport above 640px so its panels scroll inside (`pageHeader()`, `panel({ scroll: true })` in `src/components/pagePanel.ts`); reading pages (briefing, debrief, toolbox) scroll the content area.

## Elevation & Depth

**Soft UI (3.0.0, after Liba):** surfaces separate by tone and a soft two-layer shadow, not by hairlines. Shadows use negative spread and are inked in our warm graphite (`--elevation-ink`: L 0.2, chroma 0.012, hue 65) in light and black in dark. In dark mode shadows barely show, so depth is lighter surfaces (`--level-1..4`) plus a 1px top highlight (`--elevation-edge`).

| Token | Used for | Light | Dark |
|---|---|---|---|
| `--surface-lift` | resting card, tile, panel, table shell | `0 1px 2px 0` ink/.08 + `0 4px 10px -2px` ink/.12 | black .30 / .35 + highlight |
| `--elevation-1` | top bar, tooltip, switch thumb | `0 1px 2px 0` + `0 1px 1px -1px` ink/.08 | black .30 + highlight |
| `--elevation-2` | menu, popover, select, toast; hovered action card | `0 4px 12px -2px` ink/.12 + `0 2px 4px -2px` ink/.08 | black .40 / .30 + highlight |
| `--elevation-3` | dialog, sheet | `0 12px 32px -4px` ink/.18 + `0 4px 8px -4px` ink/.12 | black .55 / .40 + highlight |
| `--shadow-edge` | sticky header divider (travels with the header) | `0 1px 0 0 var(--border)` | same |

- **Canvas versus card:** light canvas `--level-0` L 0.955 under near-white cards (`--level-1` L 0.993), so borderless cards read. Dark is 0.165 → 0.21 and up the levels.
- **Borders, almost none:**
  - no border on cards, tiles, panels, table shells, sidebar or the top bar;
  - 1px subtle `--border` only on floating surfaces (dialog, menu, popover, tooltip, toast);
  - `--edge-control` (3:1 or more) only on inputs, selects and checkboxes;
  - table rows use a faint rule;
  - empty states use a dashed edge.
- **Glass:**
  - top bar `.navbar` / `.surface-chrome`: surface at 92% with `blur(20px) saturate(140%)` and `--elevation-1`;
  - modal scrim: ink at 40% with `blur(12px) saturate(120%)`, never carrying text;
  - glass turns opaque under `prefers-reduced-transparency` and `[data-contrast=more]`.
- **Forced colours** remove shadows, so cards, tiles, buttons and every floating surface get a `CanvasText` border back.
- Old names map onto the ladder: `--elev-0..4` → none / surface-lift / elevation-1 / -2 / -3; `--shadow-sm` → surface-lift, `--shadow-md` → elevation-2, `--shadow-lg` → elevation-3, `--shadow` → surface-lift.

## Shapes

Radius is set by role, not by size (Soft UI 3.0.0, after Liba).

| Token | Value | Used by |
|---|---|---|
| `--radius-mark` | 4px | checkbox, tab trigger, close ×, progress rail |
| `--radius-control` | 8px | button, icon button (a square, not a circle), input, select, menu item, tooltip, skeleton |
| `--radius-card` | 12px | card, KPI tile, table shell, panel, empty state |
| `--radius-surface` | 16px | dialog (from 640px; square on phones), menu, popover, sheet edge |
| `--radius-pill` | full | avatar, account button, switch, badge, chip, status dot |

- **Nesting:** inner radius = outer − padding. A 16px menu with 4px padding holds 8px items (`--radius-inner-xl`).
- **Old names:** `-xs` → mark, `-sm` → 6px, `-md` → control, `-lg` → card, `-xl` → surface, `-full` → pill.

## Motion

Four durations and three curves, with no springs and no page transitions (after Liba).

| Token | Value | Used for |
|---|---|---|
| `--motion-tap` | 80ms | press |
| `--motion-settle` | 150ms | hover, focus, selection, tint |
| `--motion-enter` | 220ms | menu, popover, tooltip, toast |
| `--motion-surface` | 300ms | dialog, sheet |
| `--ease-standard` | `cubic-bezier(0.2,0,0,1)` | entering |
| `--ease-exit` | `cubic-bezier(0.4,0,1,1)` | leaving |
| `--ease-lift` | `cubic-bezier(0.2,0.9,0.3,1)` | lifts |

- **Popups:** fade plus `scale(var(--enter-scale))` 0.95 plus `--enter-travel` 8px from the trigger side. `lib/overlay.ts` sets `data-side` and `transform-origin` at the trigger's centre (`anchorOrigin()` in `overlay-logic.ts`).
- **Dialogs:** fade plus scale 0.95 over 300ms, leaving on `--ease-exit`. The scrim fades over 150ms. **Sheets:** slide fully from their edge.
- **Buttons:** `:active` scales to `--press-scale` 0.97 over 80ms. **Action cards:** lift by `--lift-raise` (−1px) to `--elevation-2` on hover.
- **Not animated:** routes, list stagger, tab indicators.
- **Reduced motion** (OS setting or `[data-motion=reduce]`): zero travel and scale (`--press-scale` 1, `--enter-scale` 1, `--enter-travel` 0, `--lift-raise` 0) and instant overlays. Colour and opacity changes stay. Old `--motion-dur-*` and `--motion-ease-*` names alias the new tokens.

## Voice & Content Strategy

- Terse and technical; numbers through `Intl`; code, commands, timestamps and IDs are LTR islands in Hebrew.

## Components

Token names in this table are the pre-2.0 names the components still use; each resolves through the alias layer (Stack mapping) until its sweep.

| Component | Classes | Tokens |
|---|---|---|
| Button | `.btn` + `-primary`, `-ghost`, `-danger`, `-sm`, `-lg`, `-copy`, `.link-btn` | heights from tokens only: `.btn` `--control-base` 40, `-sm` `--control-sm` 36, `-lg` `--control-md` 44, `-copy` and the "⋯" row menu `--control-xs` 28; on `pointer: coarse` xs, sm and base become 44 and every `.btn` is at least 44 wide; icon buttons and `.info-dot` get a 44px `::after` hit area; `--radius-control`; variants: filled amber primary (one per view), tinted secondary, outline (`--edge-control`), ghost, danger; `.link-btn` min 24px |
| Input | `.input`, `.admin-input`, `.ex-input`, `.ex-select` | `--level-1` fill, 1px `--edge-control` edge (3:1), `--radius-control`; `.input` `--control-base` 40 (16px text on phones, 14px from 768px), `.admin-input` `--control-sm` 36 beside `.btn-sm`, the calendar select 32; all 44 on `pointer: coarse`. Checkboxes keep a 16px box with a `--target-min` hit area (24, 44 on touch) |
| Pill | `.chip`, `.meter-item`, `.event-clock`, `.stuck-badge`, `.status-pill`, `.via-pill`, `.today-tag`, `.hardest-badge`, `.tab-badge`, `.count-badge`, `.ex-chip`, `.board-*-chip` | one base rule; tones set `--pill-fg/-bg/-line`: neutral, accent, success, warning, danger, info (`.pill-*` helpers) |
| Table header | `.stats-table thead th`, `.admin-table th`, `.prose thead th`, `.ex-table th` | label role (12px), sentence case (`--label-case: none`), `--text-2` on the muted header band; a 60% `--edge-subtle` underline; sticky headers separate with a shadow edge |
| Focus ring | global `:focus-visible` | `--focus-width` 2px solid `--focus-ring`, offset `--focus-offset` 2px; inset (-2px) only inside clipped scrollers (shell tabs, explorer rows); `Highlight` in forced colours; `--code-accent` inside the code island |
| Tabs | `.shell-tab[aria-selected]` | accent tint + 2–3px accent underline; Highlight fill/underline in forced colours |
| Frame nav | `mountNav()`, `showSubNav()`, `navSubLink()` / `navSubButton()` in `src/shell/nav.ts` → `.app-nav` > `.nav-head` (logo) + `.nav-scroll` > `.nav-list` > `.nav-item` > `.nav-link` (`.nav-icon` + `.nav-label`) + `.nav-sub` (`.nav-sub-title` + the view's `.nav-sub-list` of `.nav-sub-link`, `.nav-sub-badge`) + `.nav-foot` (a11y link, `.nav-collapse`) | rows `--radius-md`, hover `--hover-fill`, current `--fill-inset` + 600; nested rows indented `--space-3`; case stages as `.nav-steps` with the stepper's state glyphs in circles; forced colours: Highlight on the current row |
| Display settings | `displayGroups()`, `languageGroup()`, `themeGroup()` + `renderSettingGroup(group, namePrefix)` in `src/shell/settingsMenu.ts` → `fieldset.settings-group` > `.settings-options` > `.settings-option`; the account menu draws language and theme (`menu-set-*`, `sheet-set-*`), `#/settings/display` draws them all (`page-set-*`); one stored state (`src/shell/settings.ts`), so both stay in step | segmented track `--segment-track`, checked option `--segment-thumb` + `--surface-lift`; 44px options on coarse pointers and in the sheet. Applies `data-theme`, `data-text-scale`, `data-motion`, `data-contrast`, `data-spacing` on `<html>` (token overrides only) |
| Data table | `dataTable()` in `src/components/dataTable.ts` → `.dt-wrap.table-wrap` > `table.stats-table.data-table`; `.dt-sort` header buttons with `aria-sort`; `.dt-opt` columns; `.dt-stack` phone cards; `.dt-message`, `.dt-skeleton` | sticky `thead`; numbers `.num` end-aligned with tabular figures; missing values sort last both ways; `.dt-opt` hides below 640px; `.dt-stack` turns each row into a labelled card below 600px (`data-label` per cell); loading = skeleton rows + a `role=status` label; error = `role=alert` + retry. Dashboard options: keyed rows (`rowKey` + `rowSig`, focus survives polling), `detail` rows (`.dt-detail`), `columnPicker` (`.dt-picker` popover, hideable columns, remembered), `selection` (`.dt-select` checkboxes, select-all in the header or above the cards, `.is-selected` accent tint), `csv()`/`downloadCsv()` of the current view (UTF-8 BOM, formula-safe), `virtualize` above 200 rows (`.dt-virtual` scroller, spacer rows, `aria-rowcount`/`aria-rowindex`), `cards` (caller-built `.dt-cards` below a media query). Used by My stats, the leaderboard and every admin table (Accounts, Waiting for approval, Live, Recently deleted, Stats, Audit log) |
| Stat tile | `statTile()`, `statGrid()`, `statTileSkeleton()` in `src/components/statGrid.ts` → `.kpi-grid` > `.stat-tile.kpi` | label 12px/500 sentence case `--text-2`; value 20px/600 sans with tabular figures (not mono); context lines `.stat-sub` (`.is-up` success, `.is-down` danger); skeleton keeps the tile's footprint; the admin KPI rows (`.admin-tiles`) use it |
| Reading layout | `readingLayout()` in `src/components/readingLayout.ts` → `.reading` > `details.toc` + content | `--read` measure; "On this page" contents (`.toc-list`, h3 as `.toc-sub`) only with ≥3 h2/h3 headings; links scroll and focus the heading without touching the hash route; used by the debrief |
| Command row | `commandCard()`, `commandShellSwitch()` in `src/views/toolbox.ts` → `.tool-list` > `details.cmd[data-tool]` > `summary.cmd-sum` (`.cmd-title`, `bdi.cmd-line[dir=ltr]`, `.cmd-cost` or `.chip.cmd-tag`) + `.cmd-body`; `fieldset.cmd-shells` | a list, not cards (#214): `--edge-subtle` hairline between rows, 44px minimum summary, the free syntax on one ellipsised mono line (under the title below 641px); the body holds the full text, the explanation, Reveal (`.btn-reveal`) and Copy (`.btn-copy`). One shell switch per list (segmented radios on the stage, the page panel's radios on the Toolbox) updates every row in place; a row without that variant shows Bash with a note. Open rows stay open across redraws; after a reveal the row is open and its Copy button focused |
| Case workspace | `workbench()` in `src/views/caseWorkbench.ts` (`src/case.css`, pulled into `player.css` with `@import`) → `.case-work` > `.wb-tabrow` (`[role=tablist].wb-tabs` of `button.wb-tab[role=tab]` with a `.tab-badge` count, `.wb-keys` hint) + `.q-col` + `section.wb-pane` (commands, evidence, hints) | above 1024px a sticky `.q-col` card (340–420px: kicker, goal, prompt at `--measure`, `details.look-for` closed until opened, the answer form, the meter, `.need-help` with the hint and reveal buttons) beside the tabs Commands · Evidence · Hints (underline tabs, accent 3px); at 1024px and below one segmented row Question · Commands · Evidence (44px segments on `--segment-track`/`--segment-thumb`), the bought hints under the question. APG tabs, automatic activation, arrows mirror in RTL, Home/End; the pane is in the URL (`?pane=`, `replaceState`); G then Q/C/E/H switches panes unless "Shortcut keys" is off (WCAG 2.1.4). Not animated (frequent, keyboard-driven) |
| Answer form | `answerForm({ caseId, questionId, question, stage, index, cleanOpen, withBar?, onSolved, onWrong?, onServerProgress })` → `{ form, input, bar, dispose }` in `src/views/answerForm.ts` | owns the field (format placeholder and `inputmode`), the free format check, drafts per case and stage, the rate-limit cooldown, the submit and the phone `.answer-bar`; the host lays it out and calls `dispose()` on redraw. Built to dock in the Explorer and Toolbox too (#215) |
| Case status line | `statusLine()` in `src/views/case.ts`, `eventStatus()` in `src/components/classEventStatus.ts` → `header.case-status` > `.cs-line` (`h1.cs-title`, `.cs-item` stage, score · par, ⏱ clock, `.cs-event`, `.cs-costs` button) + `.cs-progress` hairline; `.costs-panel` popover | one sticky line, `--case-status-h` 44px + a 2px progress hairline, items separated by a decorative middle dot; the page's only h1 (visually hidden below 641px, where the top bar's crumb names the case); stage shortens to `n/6`; the class event (live, or starting within 12h, for classes that assigned this case) shows the class name, the event and its countdown or "Board frozen"; "Costs so far" is a `popover()` with every penalty. The phone stage dots sit under it, not in it. The content scroller gets `scroll-padding-block-start` for it (2.4.11) |
| Form field | `formField()`, `formSection()`, `formActions()` in `src/components/formLayout.ts` → `.field`, `.field-label`, `.field-help`, `.field-error`, `.form-section`, `.form-actions` | order: label, hint, error, control; hint + error in `aria-describedby`, error sets `aria-invalid`; `.form-section` = fieldset with legend, `--radius-lg` edge; `describedBy` keeps extra describers (a live preview, a shared note); used by sign-in/sign-up and the admin event, schedule and invite-code forms |
| Top bar, page panel | `mountTopbar()`, `setPageCrumb()` (`src/shell/topbar.ts`); `showPage()`, `openAsideDrawer()` (`src/shell/frame.ts`); views return `{ main, nav?: { under, label, content }, aside?: { label, trigger?, content }, header?, layout?: "scroll" \| "fit", start? }` (`src/shell/types.ts`; `sidebar` is a deprecated alias of `aside`) | `.topbar`, `.crumbs`, `.status-chip` (pill, `--info-fg` dot), `.net-status.is-down` (warning pill), `.icon-btn` (36px, `--radius-md`), `.account-btn` + `.avatar` (circles, `--radius-full`; `.account-btn.is-prefs` signed out), `.account-panel` popover / `.account-sheet` (phones); `.page-aside` (`--level-1`, `--shadow-sm`, `--radius-lg`), `.aside-trigger`; `.pg-head`, `.pnl`, `.pnl.is-scroll` |
| Filter button | `filterButton({ groups: [{ id, legend, type: "checkbox" \| "radio", options: [{ value, label }], defaultValue? }], value?, label?, onChange })` → `{ el, value(), set(), clear(), count() }` in `src/components/filterPopover.ts` | "Filter" button with a count badge (`aria-label` "Filter, n active"), anchored `popover()` (`.filter-panel[role=dialog]`): `fieldset.filter-group` per group, `.filter-option` rows (44px on touch), Clear all. Focus goes to the first checked (or first) option; Escape returns it to the button. Radio defaults do not count as active. Filters live here or in a page panel, never in the nav |
| Progress | `.progress-*`, `.meter-*`, `.bar*`, `.funnel-*`, `.cell.*` | fills on `--surface-3`/`--border`; forced colours: Canvas track + CanvasText edge + Highlight fill; revealed cells hatched |

### Overlays (`site/src/lib/overlay.ts`)

Every dialog, sheet, menu, popover, toast and banner comes from this module; views never build their own `<dialog>`, `popover` or toast host. Shared rules: modals use the native `<dialog>` with `showModal()` (the page behind is inert), Tab is trapped explicitly, Escape closes, `html.has-modal` locks page scroll with a stable gutter, and focus returns to the opener (or to `returnFocus()` when the opener was re-rendered, else `#app`). A modal opened from a modal (a confirm whose action shows the one-time password) inherits the first one's opener. Enter/exit transitions (`--motion-dur-medium`, `@starting-style`, `allow-discrete`) run only when `prefers-reduced-motion` and `[data-motion=reduce]` both allow them. RTL comes from logical properties; anchored placement mirrors `start`/`end` in script. The DOM-free rules (focus wrap, menu keys, typeahead, placement, modal stack, toast queue) live in `overlay-logic.ts` with unit tests (`npm run test:client`).

| Primitive | API | Anatomy | Tokens | States |
|---|---|---|---|---|
| Dialog | `openDialog({size, title, body, actions})` → `Promise<value \| null>`; `showDialog()` returns a handle (`el`, `body`, `close`, `result`) for dialogs that re-render (projector board) | `dialog.ov-dialog.is-{sm,md,lg,full}` > `header.ov-head` (`h2.ov-title`, optional `.ov-close` ×) + `.ov-body` + `footer.ov-actions` (`.btn` per action, `data-action=value`) | widths `--dialog-sm/md/lg` (30rem / 40rem / `--read`), `full` fills the viewport on `--canvas`; `--level-4`, 1px subtle edge, `--radius-surface` from 640px (square below), `--elevation-3`, `::backdrop` `--scrim`; `--z-dialog` | open, closing (fade + 8px rise), busy (`aria-busy`, actions disabled, busy label, Escape ignored); below 480px the actions stack full width, primary on top |
| Confirm | `confirm({title, body, confirmLabel, cancelLabel?, tone: "default" \| "danger", typedName?, note?, run?, busyLabel?})` → `Promise<boolean>` | an `sm` dialog, `role=alertdialog` described by its body; Cancel (ghost, focused first) + confirm (primary, or `.btn-danger` for `danger`); with `typedName`: label "Type `name` to confirm", `.ov-typed-input`, hint | as Dialog; `.ov-typed-name` mono on `--surface-2` | confirm disabled until the typed text equals `typedName` exactly; `run` keeps the dialog open and busy until it settles; a rejection closes it and rejects the promise |
| Sheet | `openSheet({side: "start" \| "end" \| "bottom", title, body})` → handle | `dialog.ov-sheet.is-{start,end,bottom}` with the Dialog parts; × always shown; a backdrop click closes it | `--sheet-size` 24rem (side), 85dvh max (bottom, `--radius-xl` top corners); `--z-sheet` | slides in from its edge (mirrored by `--dir`), fades with reduced motion off |
| Popover | `popover(anchor, panel, {align, onOpen})` | any panel + `.ov-popover`; anchor gets `aria-controls`/`aria-expanded` | `--level-3`, 1px subtle edge, `--radius-surface`, `--elevation-2`; `--z-popover` (fallback when the Popover API is missing) | top layer, light dismiss (outside click, Escape), closes when focus leaves it; placed under the anchor, inline-end aligned, flipped above near the bottom, 8px inside the viewport |
| Menu | `menu(anchor, items, {label})`; `MenuItem = {label, tone?: "danger", disabled?, run}` | one shared `#ov-menu.ov-menu[role=menu]` of `.ov-menu-item[role=menuitem]` buttons; anchor `aria-haspopup=menu` | min 12rem; items `--control-sm` tall, `--step--1`; danger items `--danger-fg` after a `--border` divider | APG menu button: Enter/Space/ArrowDown open on the first item, ArrowUp on the last; arrows wrap, Home/End, typeahead (repeat a letter to cycle); Escape closes and refocuses the anchor; Tab closes; choosing refocuses the anchor before the item runs |
| Toast | `toast({tone, text, action?, timeout?})` → `{dismiss}` | one polite `aria-live` `.toast-host` (bottom inline-end); `.toast[data-tone]` = icon + text (visually hidden tone word) + ×n count + optional action + × | `--toast-size` 22.5rem; `--surface`, 4px inline-start edge in the tone's `-fg`; `--shadow-lg`; `--z-toast` | success and info dismiss after 6s (paused on hover/focus); warning and error stay until dismissed; the same tone+text bumps "×n" instead of stacking; at most 3, the oldest goes first. A modal's top layer covers the host, so a toast raised during a modal is read and usable once it closes |
| Banner | `banner({tone, text, dismissible, label?, onDismiss?})` → `{el, update, show, hide}` | `.banner[data-tone]` = icon + live text + optional ×; `role=region` when labelled (the announcement) | tone `-bg` fill and `-fg` edge, `--radius-md`, `--step--1` | placed inline by the caller (announcement under the navbar, admin status under the tabs); `update()` changes text in place so it is announced; dismiss moves focus to `#app` |

Tones (toast and banner) map to the status roles: `success`, `info`, `warning`, `error` → `--success-*`, `--info-*`, `--warning-*`, `--danger-*`, always with an icon shape and a hidden tone word, never colour alone.

## Do's and Don'ts

- Do use roles and steps only; a missing value is a new token (version bump) or a Deviation row.
- Do use the 2.0.0 role names in new code (`--level-*`, `--text-1/2/3`, `--edge-*`, `--accent-text`, `--type-*`, `--gap-*`); the aliases in Stack mapping exist only until the sweeps.
- Do use logical properties (`inline-start`, `padding-inline`, `inset-inline`); a physical side needs a comment naming why (only the LTR code islands have them).
- Do put amber text in `--accent-text`; `--accent` is a fill.
- Don't use `--edge-subtle` as an input edge or as text, and don't put `--edge-control` on buttons or tags.
- Don't add uppercase or letter-spacing to labels; Hebrew blocks both globally anyway.
- Don't introduce a new pill, table header or focus-ring style; map onto the shared ones.
- Don't add `[dir=rtl]` mirror patches; fix the rule with a logical property (the `--dir` multiplier exists for inset box-shadow markers).

## Generator inputs

The colour roles (2.0.0, kept in 3.0.0) are hand-derived from the Night Shift direction (#92) and the palette in #93, re-derived in warm graphite, rather than generated by `theme.mjs`: the generator cannot hold one accent fill across themes while moving the text shade separately. The shipped values are the single source; `scripts/check-contrast.mts` is the check the generator used to provide.

| Input | Value |
|---|---|
| neutral hue / chroma | 65-80 / 0.005-0.014 (warm graphite) |
| accent | `#f5a524` = `oklch(0.7819 0.1585 72.33)`, the fill in every theme |
| contrast | text Lc 75, bold labels Lc 60, UI Lc 30; dark small text Lc 75+ |
| radius | by role (3.0.0): mark 4, control 8, card 12, surface 16, pill (see Shapes) |
| density | comfortable; compact admin density is a page override (admin sweep) |

Check: `node --experimental-strip-types scripts/check-contrast.mts [--markdown] [--all]` (exit 1 on any failure; part of `scripts/build-all.sh`).

## Stack mapping

- **Stack:** Vite + TypeScript SPA, vanilla CSS (`site/src/styles.css` global; `admin.css`, `explorer.css` and `player.css` lazy-loaded with their views; `case.css` is `@import`ed by `player.css`, so the case route chunk keeps no stylesheet of its own).
- **Token layer:** `styles.css` only, in this order: fonts; scales (spacing and its roles, radius, type roles, controls, focus, motion, layout, layers); responsive and Hebrew overrides; colour roles (`@tokens:base`, `@tokens:hc`, `@tokens:hc-attr`); display settings; elevation; the alias layer; then base, components, RTL, forced colours and print.
- **Old to new (2.0.0).** The deprecated names stay as aliases so every view renders until it is swept:

| Old token | New role | Note |
|---|---|---|
| `--canvas`, `--bg` | `--level-0` | |
| `--surface` | `--level-1` | overlays still read `--surface`; the overlay sweep moves them to `--level-3/4` |
| `--surface-2` | `--fill-inset` | inset fill, not elevation |
| `--surface-3` | `--fill-track` | |
| `--sunken` | `--fill-sunken` | |
| `--text` | `--text-1` | |
| `--text-muted`, `--muted` | `--text-2` | not `--text-3`: small meta must clear Lc 75 in dark |
| `--text-2` (old mix) | `--text-2` (role) | same name, now a real role |
| `--border` | `--edge-subtle` | |
| `--border-strong` | `--edge-control` | buttons and tags that use it move to fill + `--elev-1` / borderless in the sweeps |
| `--accent` (fill and text) | `--accent` (fill only) | text uses moved to `--accent-text` (links to `--text-1`), state edges to `--edge-selected`, in `styles.css`, `explorer.css` and `admin.css` |
| `--accent-strong` | `--accent-text` | |
| `--accent-line` | `--edge-selected` | |
| `--accent-ink` | `--on-accent` | |
| `--hover` | `--hover-fill` | |
| `--tint` | removed | status and accent fills are explicit roles now |
| `--ok`, `--ok-soft`, `--bad`, `--bad-soft` | `--success-fg/-bg`, `--danger-fg/-bg` | |
| `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow` | `--elev-1`, `--elev-2`, `--elev-3`, `--elev-2` | |
| `--radius-xs/sm/md/lg/xl` | aliases of the 3.0.0 roles: mark 4 / 6 / control 8 / card 12 / surface 16 | use the role names in new code (Shapes) |
| `--step--2 … --step-4` | `--type-label/small/prose/title/headline/page-title/display-size` | |
| `--leading-body`, `--leading-tight`, `--track-display` | `--type-body-lh`, `--type-headline-lh`, `--type-display-track` | |
| `--track-label` | 0.06em (0 in Hebrew) | only the invite code's spaced characters still use it |
| `--page` 1080, `--page-wide` 1280 | 1120, 1440 | no longer cap the frame: pages fill the content area (#116) |
| `--code-accent` as text | `--code-accent-text`; marks `--code-mark` | |
| `--sans`, `--mono` | `--font-sans`, `--font-mono` | |

## Page overrides

| Scope | Change | Reason |
|---|---|---|
| Leaderboard projector (`body.projector`, `.lb-page.is-projector`, admin board) | Display type in clamp() sizes, no chrome | Read across a room; the brief's projector modifier |
| Explorer (`.explorer`) | Code island surfaces, smaller controls (36px, 44 on touch) | Dense tool next to a dark log pane |
| Case stage at 1024px and below (`.answer-bar`, `src/player.css`) | A `[input][Check]` bar (`--surface`, `--radius-card`, `--elevation-2`) **fixed** to the bottom edge (clear of the nav rail at 641–1024px, `env(safe-area-inset-bottom)`) while the real answer field is off screen or in another pane (#132, #218); while it shows, `main.app-content` gets the same room as `padding-block-end` and `scroll-padding-block-end`, so focus never lands under it (2.4.11). The admin save bar keeps `position: sticky` and puts its scroll padding on the scroller (`main.app-content` or the fit tab panel), not on `html` | The answer field sat about 1170px down the stage at 390px; the sticky bar floated about 130px above the bottom |
| Home (`.home-dash`, `src/home.css`) | Signed out (#223, #225), the intro carries the h1 (title role), the value line and the proof line (cases, and players and stages solved from the cached public board once 5 or more players opted in; one line reserved so it never shifts), then the one primary "Play now, no sign-up" (a guest, straight into the start-here case, `lib/playNow.ts`), Create account as a secondary button, Sign in as a text link and "Free · No email · Nothing to install"; below 480px the actions stack full width. `site/index.html` paints the same markup before the app boots (both languages; `settings-boot.js` picks one and shows the loading card on other routes or for a signed-in visitor). First-timers (visitors, and players or guests with no progress) get a "Start here" card in the Continue slot (#224): a case tagged `tutorial`, else the easiest released case, then the shortest (`lib/startHere.ts`). `#/` is a dashboard: a visible h1 ("Home"; signed out the intro's value statement is the h1), "Continue" (start) and "Today's case" (end) cards of fixed height (only the Today card, full width at the start edge, when Continue would just repeat today's case, #125), the challenge row, then the five recommended cases in a `dataTable()` panel with "Browse all cases". `#/cases` (#221) is the catalog: h1 "Cases", every case, search, the Filter popover and Sort in the table toolbar, with state in the URL query (`#/cases?difficulty=hard`). Cards and panel have no border, only `--surface`, `--radius-card` and `--surface-lift`. On desktop the script caps the dashboard at the viewport so only the table scrolls (sticky header); no sidebar | The first question is "what is today's case, and where was I?"; a console home answers it in one screen, and the full list has its own address |
| Admin (`.admin`) | Fills the content area (no width cap); compact density (36px controls, about 40px rows); panels on `--surface-lift` without borders; one amber primary per view (#119) | Instructor dashboard with wide tables |
| Admin below 900px | `--control-xs`, `--control-sm` and `--target-min` set to 44px; Live and Accounts render as cards; checkboxes keep a 24px visible box inside a 44px hit area | The instructor walks the room with a phone or tablet; same values the `pointer: coarse` rule uses |
| About and Privacy (`src/pages.css`, #225) | `#/about` and `#/privacy`: static, bilingual reading pages at `--read` with prose type, linked from the nav foot beside the accessibility statement. About has the page's one primary (Play now for a visitor, Browse all cases signed in). No API calls | A stranger and an instructor need to know who runs this and what it stores before they sign a class up |
| Settings (`src/settings.css`, #219) | `#/settings/{account,security,privacy,display}`: one h1, the section's h2, then soft cards (`.settings-card`) in a `--read` column. The section list sits in the page panel above 1024px; up to 1024px it is a segmented row (`.settings-tabs`, 44px links) and the panel button is hidden | Four short links don't need a Sheet; the sections stay one tap apart on phones |
| Classes (`src/classes.css`) | `#/classes` is a "fit" dashboard: the class list card fills the height beside the join and "How classes work" cards; the class page is three cards (case of the day, event, assigned cases) over the embedded class board; Manage reuses the admin dashboard (`.admin`, manage panels) with its sections under Classes in the nav | A class night needs the same one-screen answers as home and admin: what to play, when it counts, who is ahead |
| Print (`@media print`) | Forced light roles, black on white; chrome, buttons, stepper and progress hidden; code blocks bordered and wrapped; collapsed `details` open; external links print their URL | The debrief and case pages are printed and shared |

## Deviations

| ID | What | Where | Why | Agreed | Revisit |
|---|---|---|---|---|---|
| D1 | Code island stays dark in the light theme (`--code-*`); trips the gate's DR-MIXED-THEME on the explorer | code blocks, answer code, explorer pane | Commands are copied into dark terminals; the log viewer is read like one. All `--code-*` text pairs meet Lc 75 on `--code-bg`. The Explorer sweep draws it as a terminal window (title bar, path) so it reads as designed | design-system audit (#39), #92 | if a light syntax theme is designed |
| D2 | The brand amber `#f5a524` is the fill in every theme, light included (2.0:1 against white) | `--accent` | The brand keeps one identity across themes (#92 problem 6); the fill is identified by its dark label and position, and state edges use `--edge-selected` | #97 | never, unless the brand changes |
| D3 | Prose role at 17px beside the 16px body | `--type-prose-*` | Long-form reading on the case and debrief pages | #39, #89 | — |
| D4 | Explorer viewport text fixed at 12px (`ds-allow D4`) | `.ex-viewport` | The virtual list renders fixed 20px rows (`ROW_H` in `views/explorer.ts`); rem text would clip at larger browser font settings | 1.0.0 | if the virtual list measures rows |
| D5 | Projector display sizes remain `clamp()` values outside the roles | `.is-projector`, `.admin-board-*` | Read across a room; page titles moved into `page-title` in 2.0.0 | 1.0.0 | projector redesign (#92 problem 10) |
| D6 | `--on-accent` on `--accent` reaches APCA Lc 64, below the Lc 75 body floor | primary buttons, skip link, badges on the fill | `#f5a524` has an APCA ceiling of about Lc 73 even with black text. Labels on the fill are 14px/600 or more (Lc 60 floor); no 12px text on the fill | #97 | if the brand fill changes |

## Accessibility floors

- WCAG 2.2 AA plus APCA: text Lc 75 (dark small text included), bold labels on fills and `--text-3` Lc 60, non-text Lc 30. Targets 24px everywhere, 44px on `pointer: coarse`.
  - Control heights come from the `--control-*` tokens, never px literals, so the coarse-pointer block lifts them all. Small text links (`.hit-link`, card footers, the "today" titles) keep their layout and grow a 44px-tall `::after` hit area on touch. Inline links inside prose are exempt (WCAG 2.5.8 inline exception).
  - The e2e axe scans run at 1280 and at 390 with touch, with the best-practice rules, and fail on moderate or worse.
- **Route focus:** a new route moves focus to its h1 (`tabindex=-1`; the ring shows only for `:focus-visible`, so a tap or click shows none); a language switch, a `?query` change or a view that focused a field keeps focus where it is, and the page title is announced politely instead when no h1 takes it (`src/shell/routeFocus.ts`).
- **Scroll regions:** `main.app-content` is `position: relative`, so visually hidden text inside it can never stretch the document; every sideways-scrolling table sits in a focusable `role=region` with a name that differs from the landmarks around it.
- **Stacked tables:** below 600px a `dataTable({ stackOnPhone })` header becomes a visible row of 44px sort pills (`.dt-stack thead`); a page with its own Sort control (home) hides it. Never clip focusable header controls to 1px.
- **Focus:** `:focus-visible` is a 2px `--focus-ring` outline at 2px offset over a 2px `--focus-halo` (the page colour), so it holds on any background; inside the code island both follow the pane (`--code-accent`, `--code-bg`); `Highlight` in forced colours.
- **Forced colours:** raised surfaces keep a `CanvasText` edge; progress, score and meter bars, admin progress cells, legend keys and funnel use `forced-color-adjust: none` with Canvas/CanvasText/Highlight; selected shell tabs, pressed language buttons and the current admin section in the rail use Highlight; pills and status markers get CanvasText borders.
- **Hebrew:** no uppercase, no letter-spacing and looser leading, by global rule (Typography).
- **Reflow:** no page-level horizontal scroll at 320px; wide tables scroll inside their wrappers. `body` no longer hides horizontal overflow, so a regression shows up instead of clipping text.
- **Print:** see Page overrides.
- An IS 5568 accessibility statement for the Hebrew UI is still owed (tracked in #39).

## Decision log

- **3.2.1 (2026-11-28): the first visit (#223, #224, #225).** Guest play is the landing's one primary action and lands in the start-here case; the case gate leads with play (h1, primary button) and puts sign-in below it, secondary and never autofocused (nor on any touch device); the top bar's Sign in is secondary. Stage 0 leads with the browser Explorer and offers the zip as the second path. The static hero in `index.html` is the first paint (no "Loading…" on home) and the app replaces it without a shift. New: the proof line, the Start-here card, the About and Privacy pages, `#/play`. No token changes.
- **3.2.0 (2026-11-28): case workspace (#213, #216, #218).** The case stage became a question column beside a tabbed workbench (Commands, Evidence, Hints), a segmented Question · Commands · Evidence control at 1024px and below, and a one-line sticky case status with the class event and a "Costs so far" popover. The answer form is its own module (`answerForm()`), the phone answer bar is fixed to the bottom edge with safe-area and scroll padding. New component values: `--case-status-h` 44px, `--case-sticky-top`, `--answer-bar-room`. Removed: the stacked case header (`.case-head-top`, `.case-head-title`, `.case-budget`, `.step-now`, the progress line), the meter's base and zero-penalty chips.
- **3.1.2 (2026-11-28): one account menu and a cleaner IA (#220, #221, #222).** EN | עב, the ⚙ panel and the avatar panel became one account menu (`src/shell/accountMenu.ts`); `.lang-toggle`, `.settings-btn`, `.settings-panel` and `createSettingsMenu()` are gone. Home and Cases split; the Today's case nav item went; Classes shows to visitors; the review queue moved to `#/admin/reviews`; the owner's area is "Platform console" everywhere. Every route has one visible h1 and its own title. No token changes.
- **3.1.1 (2026-11-27): accessibility foundations (#246, #247, #249).** New token `--control-base` (40px, 44px on `pointer: coarse`) for the Soft UI default button and input, which hard-coded 40px; the Soft UI layer, the admin inputs, row menus, segmented buttons and calendar selects now read the control tokens, so touch gets 44px everywhere as the profile promised. Rail count badges use the 12px label role (were 10px). Route changes focus the page h1; stacked phone tables show their sort controls as visible pills; the content scroller is a containing block.

- **3.1.0 (2026-11-26): app frame (#97).** The navbar, live strip, per-page sidebar and footer became one frame: a global nav with nested page items and a rail, a slim top bar (breadcrumb, status chip, account menu), and a 100dvh content area that scrolls on its own, with "fit" dashboards whose panels scroll inside. New: `filterButton()`, `pageHeader()`/`panel()`, `navCollapsed` setting. Removed: `src/shell/navbar.ts`, `sidebar.ts`, `liveStrip.ts`, `.navbar`, `.live-strip`, `#sidebar`, `.side-*` admin rail parts. Home's sidebar filters move to `filterButton()` (home view).
- **3.0.0 (2026-11-26): Soft UI design language (owner decision, after the Liba frontend).** Breaking for the look, not the API: the Night Shift colour roles stay (warm graphite, pager amber, APCA-verified text).
  - Geometry, depth, borders, type and motion change: radius by role (4/8/12/16/full), two-layer soft shadows, borderless cards, glass top bar and scrim, and the motion ladder above.
  - The interface font is now the **system font** (SF Pro, Segoe UI, Noto); Plex Sans and Plex Sans Hebrew were removed (−67 KB) and Plex Mono stays for code.
  - The light canvas is darker (L 0.955) so cards separate by tone, and the light danger and warning text darkened slightly to keep APCA Lc 75 on it.
  - This supersedes "hairline rules instead of cards" and the 4px radius from 2.0.0. The per-area sweeps apply the recipes (#97).
- **2.0.0 (2026-11-26): Night Shift foundation (#97, from audits #89 #92 #93 #96).** Breaking: role names and values change, with aliases for every old name (Stack mapping).
  - Colour: warm graphite neutrals; one `#f5a524` fill in every theme with dark text; `--accent-text` for rare amber text; links text-coloured with an amber underline; warning moved to orange; fg/bg/line per status; edge roles (subtle, control, strong, selected); two-colour focus ring; scrims 40%/50%; code and terminal roles. Each role written once with `light-dark()`; the eight pasted theme copies became one block plus one high-contrast block. Dark small text now clears Lc 75 (was 43% below).
  - Depth: five elevation levels with dark-mode tone steps, ≥30% black shadows and a top highlight; forced-colours edges on raised surfaces; radius from a 4px base with the nesting rule.
  - Layout and type: spacing roles, shell-owned gutter 16/24/32, `--page` 1120, `--page-wide` 1440, `--measure` 68ch; ten type roles; labels sentence case; Hebrew without case or tracking.
  - Fonts: IBM Plex Sans, Plex Sans Hebrew and Plex Mono replace Inter, Rubik and JetBrains Mono (96 KB, was 133 KB).
  - Verification: `scripts/check-contrast.mts` in `build-all.sh`. Pages are swept onto the roles in follow-up PRs (player pages, Explorer, admin, shell and overlays).
- **1.2.1 (2026-11-26):** admin tables moved onto `dataTable()` (#62), which gained keyed rows, detail rows, a column picker, selection, CSV, virtualization and caller-built cards; the admin's own `syncRows`, `.col-chooser` and hand-built tile markup are gone. Admin KPI tiles use `statTile()`, admin forms use `formField()`. No token changes.
- **1.2.0 (2026-11-26):** contextual sidebar (#60): new tokens `--sidebar-size` (264px) and `--rail-size` (64px); views return a `ViewResult` and the shell mounts their sidebar. The case stepper and score meter, the toolbox contents and filter (plus a Bash/PowerShell switch), the Explorer's file list and time converter, and new case filters on home moved into it. The Explorer's own `.ex-sidebar` and its "Files & time" toggle are gone.
- **1.1.0 (2026-11-26):** overlay system (#61): new tokens `--dialog-sm/md/lg`, `--sheet-size`, `--toast-size` and the layer scale `--z-sidebar/-sheet/-dialog/-popover/-toast`; one module for dialogs, confirms, sheets, popovers, menus, toasts and banners. Removed the inline two-step confirm (`confirmButton`, `.confirm-*`), `.admin-dialog`, `.row-menu`, the projector's `role=dialog` div and the `window.confirm` prompts. The announcement and the admin status line are banners; the announcement's warning tone moved from the danger fill to the warning fill.
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
