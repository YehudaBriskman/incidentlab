// Applies the saved display settings before first paint (no flash of the wrong theme or text size), and
// reserves the sidebar column on routes that have one (no layout shift when the sidebar mounts).
// A classic script loaded synchronously from <head>: the CSP (script-src 'self') blocks inline scripts.
// Same key, shape and attribute mapping as site/src/shell/settings.ts; keep the two in step.
(function () {
  "use strict";
  var root = document.documentElement;
  // Same route test as sidebarRoute() in site/src/main.ts: home, a case, its toolbox and its Explorer, and admin.
  var path = window.location.hash.replace(/^#\/?/, "").split("?")[0] || "";
  if (/^(admin\/?|case\/[^/]+(\/(toolbox|explorer))?\/?)$/.test(path)) root.setAttribute("data-sidebar-page", "");
  var raw = null;
  try {
    raw = window.localStorage.getItem("il.settings");
  } catch (e) {
    return; // storage blocked: defaults
  }
  if (raw === null) return;
  var s;
  try {
    s = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (typeof s !== "object" || s === null) return;
  if (s.theme === "light" || s.theme === "dark") root.setAttribute("data-theme", s.theme);
  if (s.textScale === 112.5 || s.textScale === 125) root.setAttribute("data-text-scale", String(s.textScale));
  if (s.reducedMotion === "reduce") root.setAttribute("data-motion", "reduce");
  if (s.highContrast === true) root.setAttribute("data-contrast", "more");
  if (s.spacing === "wide") root.setAttribute("data-spacing", "wide");
  if (s.sidebarCollapsed === true) root.setAttribute("data-sidebar", "collapsed");
})();
