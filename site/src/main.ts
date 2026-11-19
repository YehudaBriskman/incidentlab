import "./styles.css";
import { getCase } from "./content/load";
import { onConnectivity } from "./lib/api";
import { h, setChildren } from "./lib/dom";
import { renderCase, stopCaseTimers } from "./views/case";
import { renderHome } from "./views/home";
import { renderToolbox } from "./views/toolbox";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("#app root missing");
const appRoot: HTMLElement = root;

/* ---------- global safety net: never white-screen ---------- */
const toastHost = h("div", { class: "toast-host", "aria-live": "polite" });
document.body.append(toastHost);
function toast(message: string): void {
  const el = h("div", { class: "toast", role: "status" }, message);
  toastHost.append(el);
  window.setTimeout(() => el.remove(), 5000);
}
window.addEventListener("error", (ev) => {
  console.error(ev.error ?? ev.message);
  toast("Something went wrong. If the page looks stuck, reload it.");
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  toast("A request failed. Please try again.");
});

const banner = h("div", { class: "net-banner", role: "status", hidden: true });
document.body.prepend(banner);
onConnectivity((state) => {
  banner.hidden = state === "ok";
  banner.textContent = state === "retrying" ? "Server unreachable, retrying…" : "Can't reach the server. Your progress is safe; try again in a moment.";
});

function notFound(message: string): void {
  document.title = "Not found · IncidentLab";
  setChildren(
    appRoot,
    h("section", { class: "center-card" }, h("p", { class: "mono accent" }, "404"), h("h1", {}, message), h("a", { class: "btn btn-primary", href: "#/" }, "Back to all cases")),
  );
}

function loadingView(): void {
  setChildren(appRoot, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, "Loading…")));
}

function lazyView(load: () => Promise<(root: HTMLElement) => void>): void {
  loadingView();
  const token = routeToken;
  load()
    .then((render) => {
      if (token === routeToken) render(appRoot);
    })
    .catch((err: unknown) => {
      console.error(err);
      if (token === routeToken) notFound("This page failed to load. Try reloading.");
    });
}

let routeToken = 0;

function route(): void {
  routeToken++;
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  stopCaseTimers();
  window.scrollTo(0, 0);

  try {
    if (parts.length === 0) {
      renderHome(appRoot);
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      lazyView(() => import("./views/admin").then((m) => m.renderAdmin));
      return;
    }
    if (parts[0] === "case" && parts[1] !== undefined) {
      const c = getCase(parts[1]);
      if (!c) {
        notFound(`Case "${parts[1]}" does not exist (yet).`);
        return;
      }
      const sub = parts[2];
      if (sub === undefined) renderCase(appRoot, c);
      else if (sub === "toolbox") renderToolbox(appRoot, c);
      else if (sub === "explorer") lazyView(() => import("./views/explorer").then((m) => m.renderExplorer));
      else notFound("That page is not on the runbook.");
      return;
    }
    notFound("That page is not on the runbook.");
  } catch (err) {
    console.error(err);
    notFound("Something broke while loading this page.");
  }
}

// The skip link must not touch the hash, or the router would treat it as a route.
document.querySelector(".skip-link")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  appRoot.focus();
});

window.addEventListener("hashchange", route);
route();
