// One stroke icon set for the app frame (nav, top bar, rail). 24px grid, 1.75 stroke in currentColor, round
// joins, drawn at 18px. Decorative everywhere: the control next to or around the icon carries the name.
// Direction (RTL): only the panel and chevron icons point somewhere; the CSS mirrors those (DESIGN.md, Frame).

const svg = (paths: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  today: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
  cases: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  leaderboard: svg('<path d="M8 21V11H4v10"/><path d="M14 21V5h-4v16"/><path d="M20 21v-7h-4v7"/><path d="M3 21h18"/>'),
  stats: svg('<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  present: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/><path d="M10 8.5v3.5l3-1.75z"/>'),
  author: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  admin: svg('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  investigation: svg('<path d="M9 4h6"/><path d="M10 4v5L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2L14 9V4"/><path d="M7.5 15h9"/>'),
  toolbox: svg('<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>'),
  explorer: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M14 3l5 5v3"/><path d="M14 3v5h5"/><circle cx="17" cy="17" r="3"/><path d="M21 21l-1.8-1.8"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 10l-2 2 2 2"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  filter: svg('<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z"/>', 16),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 14),
  wifiOff: svg('<path d="M2 8.8a15 15 0 0 1 4.2-2.6"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M5 12.6a10 10 0 0 1 3-1.8"/><path d="M16.9 11.1a10 10 0 0 1 2.1 1.5"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="M3 3l18 18"/>', 14),
} as const;

export type IconName = keyof typeof ICONS;
