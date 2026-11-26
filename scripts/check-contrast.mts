#!/usr/bin/env node
// Verifies every text and UI colour pair of the design tokens in site/src/styles.css, in light, dark and both
// high-contrast themes, with WCAG 2 contrast ratios and APCA-W3 (0.0.98G-4g) Lc. DESIGN.md records the output.
//
// Usage: node --experimental-strip-types scripts/check-contrast.mts [--markdown] [--all]
//   --markdown  print the pair table as Markdown (for DESIGN.md and PR bodies)
//   --all       also print the passing pairs in the plain report
// Exit code 1 when a pair is below its floor, a colour is outside the sRGB gamut, a dark surface step does
// not rise, or the two high-contrast copies (media query and [data-contrast]) differ.
//
// It reads the token rules marked with "@tokens:<name>" comments, so it checks exactly what ships:
//   @tokens:base   the :root colour roles, each `light-dark(<light>, <dark>)` or a single colour
//   @tokens:hc     the high-contrast overrides inside @media (prefers-contrast: more)
//   @tokens:hc-attr the same overrides on :root[data-contrast="more"] (the ⚙ setting)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CSS = readFileSync(join(ROOT, "site/src/styles.css"), "utf8");
const args = new Set(process.argv.slice(2));

// ---------- parsing ----------
type Decls = Map<string, string>;

/** The declarations of the first rule after a `@tokens:<name>` marker (nested at most one @media deep). */
function block(name: string): Decls {
  const at = CSS.indexOf(`@tokens:${name} `);
  if (at < 0) throw new Error(`marker @tokens:${name} not found in styles.css`);
  const rest = CSS.slice(CSS.indexOf("*/", at) + 2);
  const open = rest.indexOf("{");
  let start = open + 1;
  // `@media (...) { :root { ... } }`: step into the inner rule.
  if (rest.slice(0, open).trim().startsWith("@media")) start = rest.indexOf("{", start) + 1;
  const end = rest.indexOf("}", start);
  const body = rest.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decls = new Map();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim().replace(/\s+/g, " "));
  return out;
}

/** Splits `light-dark(a, b)` into its sides; anything else is the same on both. */
function sides(value: string): [string, string] {
  const m = /^light-dark\((.*)\)$/.exec(value);
  if (!m) return [value, value];
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return [m[1].slice(0, i).trim(), m[1].slice(i + 1).trim()];
  }
  throw new Error(`bad light-dark(): ${value}`);
}

type Theme = "light" | "dark" | "hc-light" | "hc-dark";
const THEMES: readonly Theme[] = ["light", "dark", "hc-light", "hc-dark"];

const base = block("base");
const hc = block("hc");
const hcAttr = block("hc-attr");

function themeDecls(theme: Theme): Map<string, string> {
  const merged = new Map(base);
  if (theme.startsWith("hc")) for (const [k, v] of hc) merged.set(k, v);
  const side = theme.endsWith("light") ? 0 : 1;
  const out = new Map<string, string>();
  for (const [k, v] of merged) out.set(k, sides(v)[side]);
  return out;
}

// ---------- colour maths ----------
type RGBA = { r: number; g: number; b: number; a: number; inGamut: boolean };

function oklchToRgb(l: number, c: number, hDeg: number, a: number): RGBA {
  const h = (hDeg * Math.PI) / 180;
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const eps = 0.0005;
  const inGamut = lin.every((v) => v >= -eps && v <= 1 + eps);
  const enc = (v: number): number => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a, inGamut };
}

function parseColor(raw: string): RGBA {
  const s = raw.trim();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0, inGamut: true };
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1, inGamut: true };
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (ok) {
    const alpha = ok[4] === undefined ? 1 : ok[4].endsWith("%") ? Number.parseFloat(ok[4]) / 100 : Number.parseFloat(ok[4]);
    return oklchToRgb(Number.parseFloat(ok[1]), Number.parseFloat(ok[2]), Number.parseFloat(ok[3]), alpha);
  }
  throw new Error(`unsupported colour "${s}" (use oklch(), #rrggbb or transparent in checked roles)`);
}

/** Resolves a role to a colour, following var() inside the same theme. */
function resolve(decls: Map<string, string>, role: string, seen: string[] = []): string {
  const v = decls.get(role);
  if (v === undefined) throw new Error(`role ${role} is not defined`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (!ref) return v;
  if (seen.includes(ref[1])) throw new Error(`var() cycle at ${role}`);
  return resolve(decls, ref[1], [...seen, role]);
}

const over = (fg: RGBA, bg: RGBA): RGBA => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
  inGamut: fg.inGamut && bg.inGamut,
});

function wcagLum(c: RGBA): number {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
function wcagRatio(a: RGBA, b: RGBA): number {
  const [x, y] = [wcagLum(a), wcagLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** APCA-W3 0.0.98G-4g, text on background, signed Lc (positive = dark text on light). */
function apca(txt: RGBA, bg: RGBA): number {
  const y = (c: RGBA): number => 0.2126729 * c.r ** 2.4 + 0.7151522 * c.g ** 2.4 + 0.072175 * c.b ** 2.4;
  const clamp = (v: number): number => (v > 0.022 ? v : v + (0.022 - v) ** 1.414);
  const yt = clamp(y(txt));
  const yb = clamp(y(bg));
  if (Math.abs(yb - yt) < 0.0005) return 0;
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

// ---------- the pairs ----------
// text: body and small text (WCAG 4.5:1, APCA Lc 75) · bold: labels of 14px/600 or more on fills (4.5:1, Lc 60)
// large: text-3, only for 16px/600+ or non-essential meta (4.5:1, Lc 60) · ui: boundaries, focus, state (3:1, Lc 30)
// info: reported, no floor (decorative dividers, surface steps)
type Kind = "text" | "bold" | "large" | "ui" | "info";
const FLOOR: Record<Kind, { ratio: number; lc: number }> = {
  text: { ratio: 4.5, lc: 75 },
  bold: { ratio: 4.5, lc: 60 },
  large: { ratio: 4.5, lc: 60 },
  ui: { ratio: 3, lc: 30 },
  info: { ratio: 0, lc: 0 },
};
type Pair = { fg: string; bg: string; kind: Kind; under?: string; note?: string };

const LEVELS = ["--level-0", "--level-1", "--level-2", "--level-3", "--level-4"];
const READ_BGS = [...LEVELS, "--fill-inset"];
const pairs: Pair[] = [];
const add = (fgs: string[], bgs: string[], kind: Kind, note?: string): void => {
  for (const fg of fgs) for (const bg of bgs) pairs.push({ fg, bg, kind, note });
};
add(["--text-1", "--text-2"], READ_BGS, "text");
add(["--text-1"], ["--accent-soft", "--selection-bg", "--hover-fill"], "text");
add(["--text-3"], ["--level-0", "--level-1", "--level-2", "--fill-inset"], "large", "16px/600+ or non-essential only");
add(["--accent-text"], ["--level-0", "--level-1", "--level-3", "--fill-inset", "--accent-soft"], "text");
add(["--on-accent"], ["--accent", "--accent-hover"], "bold", "button labels 14px/600+");
add(["--on-danger"], ["--danger-fg"], "bold", ".btn-danger label");
for (const s of ["danger", "warning", "success", "info"]) {
  add([`--${s}-fg`], [`--${s}-bg`, "--level-1", "--level-0"], "text");
  add([`--${s}-line`], ["--level-1", `--${s}-bg`], "ui");
}
add(["--edge-control"], [...LEVELS, "--fill-inset"], "ui", "inputs and selects only");
add(["--edge-strong"], ["--level-1", "--fill-inset"], "ui");
add(["--edge-selected"], ["--level-0", "--level-1", "--accent-soft"], "ui");
add(["--focus-ring"], [...LEVELS, "--fill-inset", "--accent-soft", "--focus-halo"], "ui");
add(["--accent"], ["--level-1"], "info", "fill only; light buttons are identified by label and fill");
add(["--link-underline"], ["--level-0", "--level-1"], "ui");
add(["--scrollbar-thumb"], ["--scrollbar-track"], "ui");
add(["--edge-subtle"], ["--level-1", "--level-0"], "info", "decorative");
add(["--code-text", "--code-muted", "--code-accent-text", "--code-danger"], ["--code-bg", "--code-surface"], "text");
add(["--code-warn-fg"], ["--code-warn-bg"], "text");
add(["--code-on-accent"], ["--code-mark"], "text", "highlighted match");
add(["--code-on-accent"], ["--code-accent"], "bold", "primary button inside the pane");
add(["--code-accent"], ["--code-bg"], "ui", "focus ring and cursor inside the code island");
add(["--code-border"], ["--code-bg"], "info", "decorative");
add(["--code-bg"], ["--level-0"], "info", "terminal pane edge");
for (let i = 1; i < LEVELS.length; i++) pairs.push({ fg: LEVELS[i], bg: LEVELS[i - 1], kind: "info", note: "surface step" });
pairs.push({ fg: "--level-4", bg: "--level-0", under: "--scrim", kind: "info", note: "dialog on the scrimmed page" });

const DISTINCT: ReadonlyArray<[string, string]> = [
  ["--accent", "--warning-line"],
  ["--accent-text", "--warning-fg"],
  ["--edge-selected", "--warning-line"],
];
function deltaOk(a: string, b: string): number {
  const lab = (s: string): [number, number, number] => {
    const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
    if (!m) throw new Error(`ΔE needs oklch(): ${s}`);
    const h = (Number.parseFloat(m[3]) * Math.PI) / 180;
    const c = Number.parseFloat(m[2]);
    return [Number.parseFloat(m[1]), c * Math.cos(h), c * Math.sin(h)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const distinct: { theme: Theme; x: string; y: string; d: number }[] = [];

// ---------- run ----------
type Row = { theme: Theme; pair: Pair; ratio: number; lc: number; ok: boolean };
const rows: Row[] = [];
const problems: string[] = [];

for (const theme of THEMES) {
  const decls = themeDecls(theme);
  const page = parseColor(resolve(decls, "--level-0"));
  const color = (role: string): RGBA => {
    const c = parseColor(resolve(decls, role));
    if (!c.inGamut) problems.push(`${theme}: ${role} ${resolve(decls, role)} is outside sRGB`);
    return c.a < 1 ? over(c, page) : c;
  };
  for (const pair of pairs) {
    let bg = color(pair.bg);
    if (pair.under) bg = over(parseColor(resolve(decls, pair.under)), bg);
    const fg = color(pair.fg);
    const ratio = wcagRatio(fg, bg);
    const lc = Math.abs(apca(fg, bg));
    const floor = FLOOR[pair.kind];
    const ok = ratio >= floor.ratio - 1e-9 && lc >= floor.lc;
    rows.push({ theme, pair, ratio, lc, ok });
    if (!ok) problems.push(`${theme}: ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1 · Lc ${lc.toFixed(1)} (needs ${floor.ratio}:1 · Lc ${floor.lc})`);
  }
  // Dark elevation must rise with every level (tone carries depth where shadows fade).
  if (theme.endsWith("dark")) {
    const lum = LEVELS.map((l) => wcagLum(color(l)));
    for (let i = 1; i < lum.length; i++) if (!(lum[i] > lum[i - 1])) problems.push(`${theme}: ${LEVELS[i]} is not lighter than ${LEVELS[i - 1]}`);
  }
  // Brand and warning must not be confused (#93 S1): ΔE in OKLab of at least 0.06 (about three JNDs).
  for (const [x, y] of DISTINCT) {
    const d = deltaOk(resolve(decls, x), resolve(decls, y));
    distinct.push({ theme, x, y, d });
    if (d < 0.06) problems.push(`${theme}: ${x} and ${y} are too close (ΔE_OK ${d.toFixed(3)}, needs 0.06)`);
  }
}

// The two high-contrast copies must be identical.
for (const k of new Set([...hc.keys(), ...hcAttr.keys()])) {
  if (hc.get(k) !== hcAttr.get(k)) problems.push(`high-contrast copies differ at ${k}: "${hc.get(k)}" vs "${hcAttr.get(k)}"`);
}

const fmt = (r: Row): string => `${r.ratio.toFixed(1)}:1 · ${r.lc.toFixed(0)}`;
if (args.has("--markdown")) {
  console.log("| Pair (fg on bg) | Floor | Light | Dark | HC light | HC dark |");
  console.log("|---|---|---|---|---|---|");
  for (const pair of pairs) {
    const cells = THEMES.map((t) => {
      const r = rows.find((x) => x.theme === t && x.pair === pair);
      return r ? (r.ok ? fmt(r) : `**${fmt(r)}** ✗`) : "";
    });
    const f = FLOOR[pair.kind];
    const floor = pair.kind === "info" ? "info" : `${f.ratio}:1 · Lc ${f.lc}`;
    const label = `\`${pair.fg.slice(2)}\` on \`${pair.bg.slice(2)}\`${pair.under ? " under scrim" : ""}`;
    console.log(`| ${label}${pair.note ? ` (${pair.note})` : ""} | ${floor} | ${cells.join(" | ")} |`);
  }
  for (const [x, y] of DISTINCT) {
    const cells = THEMES.map((t) => `ΔE ${distinct.find((r) => r.theme === t && r.x === x && r.y === y)?.d.toFixed(3) ?? ""}`);
    console.log(`| \`${x.slice(2)}\` vs \`${y.slice(2)}\` (must differ) | ΔE_OK 0.06 | ${cells.join(" | ")} |`);
  }
} else {
  for (const theme of THEMES) {
    const mine = rows.filter((r) => r.theme === theme && r.pair.kind !== "info");
    const pass = mine.filter((r) => r.ok).length;
    const minLc = Math.min(...mine.filter((r) => r.pair.kind === "text").map((r) => r.lc));
    console.log(`${theme.padEnd(8)} ${pass}/${mine.length} pairs pass · lowest text Lc ${minLc.toFixed(1)}`);
    if (args.has("--all")) for (const r of rows.filter((x) => x.theme === theme)) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.pair.fg} on ${r.pair.bg}: ${fmt(r)}`);
  }
}
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.error(`contrast: all ${rows.filter((r) => r.pair.kind !== "info").length} checked pairs pass in ${THEMES.length} themes`);
