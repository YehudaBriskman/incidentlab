// Home's challenge row (#183): "Your classes" (each class's current or next event and its case of the day, linking
// to #/class/<id>), or a "Create or join a class" call to action, or for a guest the upgrade card; beside it "Your
// streak" with the closest locked achievement. Cost: GET /api/classes plus one GET /api/classes/:id per class shown
// (at most HOME_CLASS_LIMIT), once per page load. Nothing polls: the countdowns redraw on one shared 1 s tick.
import { ACHIEVEMENT_IDS, type ClassDetail, type ClassSummary, type TodayResponse, type UserStats } from "../../shared/contract";
import { caseSummary } from "../content/load";
import { classToday, fetchClass, fetchMyClasses } from "../lib/class-api";
import { homeClasses, needsDetail, nextAchievement } from "../lib/challenges";
import { eventStatus, everySecond } from "../components/classEventStatus";
import { h, type Child } from "../lib/dom";
import { nameNode } from "../lib/bidi";
import { serverNow } from "../lib/event";
import { getLang } from "../i18n/i18n";
import { TC } from "../i18n/strings-challenges";
import { achievementCountText } from "../i18n/strings-stats";
import { achievementInfo } from "../i18n/strings-game";
import { TGu } from "../i18n/strings-guest";
import { TH } from "../i18n/strings-home";
import { TO } from "../i18n/strings-onboard";

// The shared 1 s tick and the class event status live in components/classEventStatus.ts (the case page uses them too).
export { everySecond };

/* ================= loading the classes ================= */

export type ClassItem = { readonly summary: ClassSummary; readonly detail: ClassDetail | null; readonly failed: boolean };
export type ClassesState = { readonly kind: "loading" } | { readonly kind: "failed" } | { readonly kind: "ready"; readonly items: readonly ClassItem[]; readonly more: number };

/** The class list, then the detail of each class shown (active memberships only: pending requests get no detail). */
export function loadHomeClasses(): Promise<ClassesState> {
  return fetchMyClasses().then(
    async (all): Promise<ClassesState> => {
      const { shown, more } = homeClasses(all);
      const items = await Promise.all(
        shown.map(
          (summary): Promise<ClassItem> =>
            needsDetail(summary)
              ? fetchClass(summary.id).then(
                  (detail) => ({ summary, detail, failed: false }),
                  () => ({ summary, detail: null, failed: true }),
                )
              : Promise.resolve({ summary, detail: null, failed: false }),
        ),
      );
      return { kind: "ready", items, more };
    },
    (): ClassesState => ({ kind: "failed" }),
  );
}

/* ================= shared bits ================= */

function cardHead(id: string, title: string, aside: Child = null): HTMLElement {
  return h("header", { class: "home-card-head" }, h("h2", { id, class: "home-card-title" }, title), aside);
}

function skeleton(n: number): HTMLElement {
  return h("ul", { class: "home-rows", "aria-hidden": "true" }, Array.from({ length: n }, () => h("li", {}, h("span", { class: "home-row is-skeleton" }, h("span", { class: "dt-skeleton" })))));
}

const caseTitle = (id: string): string => caseSummary(id)?.title ?? id;

/* ================= Your classes ================= */

function classRow(item: ClassItem): HTMLElement {
  const { summary, detail } = item;
  const body = ((): Child[] => {
    if (summary.membership?.status !== "active") return [h("span", { class: "home-class-note" }, TC().classPending), h("span", {})];
    if (detail === null) return [h("span", { class: "home-class-note" }, TC().classDetailFailed), h("span", {})];
    const caseId = classToday(detail.schedule, serverNow())?.caseId ?? null;
    return [
      eventStatus(detail.event),
      h(
        "span",
        { class: "home-class-case" },
        caseId === null
          ? h("span", { class: "home-class-note" }, TC().noCaseToday)
          : [h("span", { class: "home-class-case-label" }, TC().caseToday), " ", nameNode(caseTitle(caseId), "home-class-case-title")],
      ),
    ];
  })();
  return h(
    "li",
    {},
    h(
      "a",
      { class: "home-row home-class-row", href: `#/class/${encodeURIComponent(summary.id)}`, "data-class": summary.id },
      h("bdi", { class: "home-row-name home-class-name" }, summary.name),
      body,
      h("span", { class: "home-row-go", "aria-hidden": "true" }, "›"),
    ),
  );
}

/** Three short facts under a call to action, side by side on wide cards. */
function points(items: readonly string[]): HTMLElement {
  return h("ul", { class: "home-points" }, items.map((text) => h("li", {}, h("span", { class: "home-point-mark", "aria-hidden": "true" }, "✓"), h("span", {}, text))));
}

/** No classes yet: one compact call to action into #/classes. */
function classesCta(): HTMLElement {
  return h(
    "section",
    { class: "home-card home-chal-card home-classes is-cta", "aria-labelledby": "home-classes-h" },
    cardHead("home-classes-h", TC().ctaTitle),
    h(
      "div",
      { class: "home-card-body home-cta-body" },
      h("p", { class: "home-cta-text" }, TC().ctaBody),
      points([TC().ctaPoint1, TC().ctaPoint2, TC().ctaPoint3]),
      h("a", { class: "btn btn-sm", href: "#/classes" }, TC().ctaAction),
    ),
  );
}

export function classesCard(state: ClassesState, retry: () => void): HTMLElement {
  if (state.kind === "ready" && state.items.length === 0) return classesCta();
  const body = ((): Child => {
    if (state.kind === "loading") return skeleton(3);
    if (state.kind === "failed") {
      return h("div", { class: "home-card-note", role: "alert" }, h("p", {}, TC().classesFailed), h("button", { type: "button", class: "btn btn-sm", onclick: retry }, TH().retry));
    }
    return [
      h("ul", { class: "home-rows", "aria-labelledby": "home-classes-h" }, state.items.map(classRow)),
      state.more > 0 ? h("p", { class: "home-card-more" }, h("a", { href: "#/classes" }, TC().moreClasses(state.more))) : null,
    ];
  })();
  return h(
    "section",
    { class: "home-card home-chal-card home-classes", "aria-labelledby": "home-classes-h", "aria-busy": state.kind === "loading" ? "true" : null },
    cardHead("home-classes-h", TC().classesTitle, h("a", { class: "home-card-link", href: "#/classes" }, TC().allClasses)),
    h("div", { class: "home-card-body" }, body),
  );
}

/* ================= guest ================= */

/** A guest's quiet upgrade card: the same upgrade dialog as the guest banner (views/guest.ts). */
export function guestCard(): HTMLElement {
  return h(
    "section",
    { class: "home-card home-chal-card home-guest", "aria-labelledby": "home-guest-h" },
    cardHead("home-guest-h", TC().guestTitle),
    h(
      "div",
      { class: "home-card-body home-cta-body" },
      h("p", { class: "home-cta-text" }, TC().guestBody),
      points([TC().guestPoint1, TC().guestPoint2, TC().guestPoint3]),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => void import("./guest").then((m) => m.openUpgradeDialog()) }, TGu().createAccount),
    ),
  );
}

/* ================= Your streak ================= */

export type StreakState = { readonly kind: "loading" } | { readonly kind: "failed" } | { readonly kind: "ready"; readonly stats: UserStats; readonly today: TodayResponse | null };

/** Whether today's case was finished today (in the schedule's time zone): that is what keeps the streak. */

function nextAchievementBlock(stats: UserStats): HTMLElement {
  const next = nextAchievement(stats, ACHIEVEMENT_IDS);
  if (next === null) return h("p", { class: "home-next-none" }, TC().allEarned);
  const info = achievementInfo(getLang(), next.id);
  const count = next.have === null ? null : achievementCountText(next.id, next.have, next.need);
  const pct = next.have === null ? 0 : Math.round((next.have / next.need) * 100);
  return h(
    "div",
    { class: "home-next" },
    h("p", { class: "home-next-label" }, TC().nextTitle),
    h("p", { class: "home-next-name" }, h("strong", {}, info.label), count === null ? null : h("span", { class: "home-next-count" }, count)),
    count === null
      ? h("p", { class: "home-next-desc" }, info.description)
      : h("span", { class: "home-next-bar", "aria-hidden": "true" }, h("span", { class: "home-next-fill", style: `inline-size:${pct}%` })),
  );
}

export function streakCard(state: StreakState): HTMLElement {
  const body = ((): Child => {
    if (state.kind === "loading") return [h("span", { class: "dt-skeleton home-skel-title" }), h("span", { class: "dt-skeleton" }), h("span", { class: "dt-skeleton" })];
    if (state.kind === "failed") return h("p", { class: "home-card-note", role: "alert" }, TC().streakFailed);
    const { stats } = state;
    const current = stats.streak.current;
    const note = stats.streak.activeToday ? TC().streakSafe : current > 0 ? TC().streakKeep : TC().streakStart;
    return [
      h(
        "p",
        { class: "home-streak-value" },
        h("strong", { class: "home-streak-days" }, TO().streakDays(current)),
        h("span", { class: "home-streak-best" }, TC().streakBest(TO().streakDays(stats.streak.best))),
      ),
      note === null ? null : h("p", { class: "home-streak-note" }, note),
      nextAchievementBlock(stats),
    ];
  })();
  return h(
    "section",
    { class: "home-card home-chal-card home-streak", "aria-labelledby": "home-streak-h", "aria-busy": state.kind === "loading" ? "true" : null },
    cardHead("home-streak-h", TC().streakTitle, h("a", { class: "home-card-link", href: "#/me" }, TC().achievementsLink)),
    h("div", { class: "home-card-body" }, body),
  );
}
