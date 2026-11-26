// A case's nested items in the global nav, under Cases with the case title as the heading: the stages (on the
// case page, with their status) or an "Investigation" link back to them (on the toolbox and Explorer pages),
// then Toolbox and Explorer. The case, toolbox and Explorer views share it so the nav stays put between them.
import type { Case } from "../../shared/case";
import { TS } from "../i18n/strings-shell";
import { h, setChildren } from "../lib/dom";
import { cachedAccount, isAdmin } from "../lib/session";
import { TR } from "../i18n/strings-present";
import { navSubLink, refreshNav } from "../shell/nav";
import type { NavSection } from "../shell/types";

export type CasePage = "case" | "toolbox" | "explorer" | "present";

export interface CaseNav {
  section: NavSection;
  /** Shows the stage list (the case page, once progress has loaded) in place of the Investigation link. */
  setStages: (stages: HTMLElement | null) => void;
}

export function createCaseNav(c: Case, page: CasePage): CaseNav {
  const base = `#/case/${encodeURIComponent(c.id)}`;
  const investigation = navSubLink(base, { label: TS().caseInvestigation, icon: "investigation", current: page === "case" ? "page" : null });
  const first = h("li", { class: "nav-sub-first" }, investigation);
  const content = h(
    "ul",
    { class: "nav-sub-list" },
    first,
    h("li", {}, navSubLink(`${base}/toolbox`, { label: TS().sideToolbox, icon: "toolbox", current: page === "toolbox" ? "page" : null })),
    h("li", {}, navSubLink(`${base}/explorer`, { label: TS().sideExplorer, icon: "explorer", current: page === "explorer" ? "page" : null })),
    // the instructor presents the case to the class (views/present.ts)
    isAdmin(cachedAccount()) ? h("li", {}, navSubLink(`${base}/present`, { label: TR().present, icon: "present", current: page === "present" ? "page" : null })) : null,
  );
  return {
    section: { under: "cases", label: c.title, content },
    setStages: (stages) => {
      if (stages === null) setChildren(first, investigation);
      else setChildren(first, stages);
      refreshNav();
    },
  };
}
