import "./styles.css";
import { getCase } from "./content/load";
import { h } from "./lib/dom";
import { isTab, renderCase, stopCaseTimers } from "./views/case";
import { renderHome } from "./views/home";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("#app root missing");
const appRoot: HTMLElement = root;

function notFound(message: string): void {
  document.title = "Not found · IncidentLab";
  appRoot.replaceChildren(
    h(
      "section",
      { class: "not-found" },
      h("p", { class: "mono accent" }, "404 · NO SUCH INCIDENT"),
      h("h1", {}, message),
      h("a", { class: "btn btn-primary", href: "#/" }, "Back to all cases"),
    ),
  );
}

let lastCaseId: string | null = null;

function route(): void {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  stopCaseTimers();

  if (parts.length === 0) {
    lastCaseId = null;
    renderHome(appRoot);
    window.scrollTo(0, 0);
    return;
  }
  if (parts[0] === "case" && parts[1] !== undefined) {
    const c = getCase(parts[1]);
    if (!c) {
      notFound(`Case "${parts[1]}" does not exist (yet).`);
      return;
    }
    const tabPart = parts[2] ?? "briefing";
    const tab = isTab(tabPart) ? tabPart : "briefing";
    const sameCase = lastCaseId === c.id;
    const scrollY = window.scrollY;
    renderCase(appRoot, c, tab);
    lastCaseId = c.id;
    if (sameCase) {
      // switching tabs: keep the header in view, move focus to the new panel
      const tabs = document.querySelector(".tabs");
      const top = tabs instanceof HTMLElement ? tabs.getBoundingClientRect().top + window.scrollY - 8 : 0;
      window.scrollTo(0, Math.min(scrollY, top));
      document.getElementById("panel")?.focus({ preventScroll: true });
    } else {
      window.scrollTo(0, 0);
    }
    return;
  }
  notFound("That page is not on the runbook.");
}

// The skip link must not touch the hash, or the router would treat it as a route.
document.querySelector(".skip-link")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  appRoot.focus();
});

window.addEventListener("hashchange", route);
route();
