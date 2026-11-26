// Applies the saved display settings before first paint (no flash of the wrong theme or text size).
// A classic script loaded synchronously from <head>: the CSP (script-src 'self') blocks inline scripts.
// Same key, shape and attribute mapping as site/src/shell/settings.ts; keep the two in step.
(function () {
  "use strict";
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
  var root = document.documentElement;
  if (s.theme === "light" || s.theme === "dark") root.setAttribute("data-theme", s.theme);
  if (s.textScale === 112.5 || s.textScale === 125) root.setAttribute("data-text-scale", String(s.textScale));
  if (s.reducedMotion === "reduce") root.setAttribute("data-motion", "reduce");
  if (s.highContrast === true) root.setAttribute("data-contrast", "more");
  if (s.spacing === "wide") root.setAttribute("data-spacing", "wide");
})();
