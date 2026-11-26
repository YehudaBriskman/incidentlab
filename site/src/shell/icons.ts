// One stroke icon set for the app (frame, stage results, achievements). 24px grid, 1.75 stroke in currentColor,
// round joins, drawn at 18px unless a size is given. Decorative everywhere: the control or the text next to the
// icon carries the name (aria-hidden, focusable=false).
// Direction (RTL): only the panel and chevron icons point somewhere; the CSS mirrors those (DESIGN.md, Frame).

const svg = (paths: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths}</svg>`;

/** The path data per icon, and the size it is drawn at by default. */
const PATHS = {
  home: ['<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>', 18],
  today: ['<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>', 18],
  cases: ['<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 18],
  leaderboard: ['<path d="M8 21V11H4v10"/><path d="M14 21V5h-4v16"/><path d="M20 21v-7h-4v7"/><path d="M3 21h18"/>', 18],
  stats: ['<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>', 18],
  present: ['<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/><path d="M10 8.5v3.5l3-1.75z"/>', 18],
  author: ['<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', 18],
  admin: ['<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="M9 12l2 2 4-4"/>', 18],
  investigation: ['<path d="M9 4h6"/><path d="M10 4v5L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2L14 9V4"/><path d="M7.5 15h9"/>', 18],
  toolbox: ['<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>', 18],
  explorer: ['<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M14 3l5 5v3"/><path d="M14 3v5h5"/><circle cx="17" cy="17" r="3"/><path d="M21 21l-1.8-1.8"/>', 18],
  panel: ['<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 10l-2 2 2 2"/>', 18],
  menu: ['<path d="M4 6h16M4 12h16M4 18h16"/>', 18],
  filter: ['<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z"/>', 16],
  chevron: ['<path d="M9 6l6 6-6 6"/>', 14],
  wifiOff: ['<path d="M2 8.8a15 15 0 0 1 4.2-2.6"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M5 12.6a10 10 0 0 1 3-1.8"/><path d="M16.9 11.1a10 10 0 0 1 2.1 1.5"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="M3 3l18 18"/>', 14],
  // stage results and the score breakdown (#137)
  eye: ['<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>', 16],
  drop: ['<path d="M12 3.5S6.5 9.6 6.5 14a5.5 5.5 0 0 0 11 0C17.5 9.6 12 3.5 12 3.5z"/>', 16],
  // achievements (#137), drawn larger in their tiles
  sparkle: ['<path d="M11 3.5 12.7 9.3 18.5 11l-5.8 1.7L11 18.5l-1.7-5.8L3.5 11l5.8-1.7z"/><path d="M18.5 3v4M16.5 5h4"/>', 18],
  bolt: ['<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>', 18],
  bulb: ['<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.2 1.4 1.2 2.3h5c0-.9.5-1.7 1.2-2.3A6 6 0 0 0 12 3z"/>', 18],
  trophy: ['<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a3 3 0 0 0 3.2 4"/><path d="M17 6h2.5a3 3 0 0 1-3.2 4"/><path d="M12 14v3.5"/><path d="M8 21h8"/><path d="M9.5 21l.5-3.5h4l.5 3.5"/>', 18],
  flame: ['<path d="M12 3c.6 3.4 5 5.4 5 10.5a5 5 0 0 1-10 0c0-2.1 1-3.6 2.1-4.6.2 1.6 1 2.7 2 3.1-.2-3.6-.3-6.2.9-9z"/>', 18],
  calendar: ['<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/><path d="M9.5 15l1.8 1.8 3.4-3.4"/>', 18],
  medal: ['<circle cx="12" cy="15" r="5"/><path d="M8.5 3 12 10l3.5-7"/><path d="M12 13v4"/>', 18],
  lock: ['<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 18],
} as const satisfies Record<string, readonly [string, number]>;

export type IconName = keyof typeof PATHS;

/** An icon's markup at another size (achievement tiles draw theirs at 22px). Trusted, static SVG. */
export const iconSvg = (name: IconName, size?: number): string => svg(PATHS[name][0], size ?? PATHS[name][1]);

export const ICONS = Object.fromEntries(Object.keys(PATHS).map((name) => [name, iconSvg(name as IconName)])) as Readonly<Record<IconName, string>>;
