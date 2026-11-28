// Applies the saved display settings before first paint (no flash of the wrong theme or text size), and
// reserves the page-panel column on routes that have one (no layout shift when the panel mounts).
// A classic script loaded synchronously from <head>: the CSP (script-src 'self') blocks inline scripts.
// Same key, shape and attribute mapping as site/src/shell/settings.ts; keep the two in step.
(function () {
  "use strict";
  var root = document.documentElement;
  // Same route test as asideRoute() in site/src/main.ts: a case's toolbox and its Explorer, and the settings
  // sections (#219, lib/settings-route.ts), have a page panel.
  var path = window.location.hash.replace(/^#\/?/, "").split("?")[0] || "";
  if (/^case\/[^/]+\/(toolbox|explorer)\/?$/.test(path) || /^settings\/(account|security|privacy|display)\/?$/.test(path)) {
    root.setAttribute("data-aside-page", "");
  }
  // The static first paint in index.html (#225, #279): its language before the app boots (same rule as getLang() in
  // src/i18n/i18n.ts), and the landing's hero only on the landing (#/), for everyone. A likely signed-in visitor
  // (the same hint as likelySignedIn() in src/lib/session.ts) gets the dashboard call to action (html[data-signed]).
  // Every other route shows the plain loading card instead.
  var lang = null;
  var signedIn = false;
  try {
    lang = window.localStorage.getItem("il.lang");
    signedIn = window.localStorage.getItem("il.signedIn") === "1";
  } catch (e) {
    /* storage blocked: browser language, signed out */
  }
  if (lang !== "he" && lang !== "en") lang = (navigator.language || "").toLowerCase().indexOf("he") === 0 ? "he" : "en";
  root.lang = lang;
  root.dir = lang === "he" ? "rtl" : "ltr";
  if (path !== "") root.setAttribute("data-boot", "app");
  if (signedIn) root.setAttribute("data-signed", "");
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
  if (s.navCollapsed === true) root.setAttribute("data-nav", "collapsed");
})();
