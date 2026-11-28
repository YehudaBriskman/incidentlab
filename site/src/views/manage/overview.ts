// The owner console's Overview section (#235), the console's default: what waits on the owner, how the site grows,
// and the function-call budget of the legacy Free plan (docs/DATA.md). One GET /api/admin/overview when the section
// opens or the owner presses Refresh; never on a timer. Once it has shown data it keeps it on screen while a refresh
// runs ("Updating…"), and a failed refresh leaves the last good numbers with an error line and Retry.
//
// The sign-up chart is a stacked bar per day (users, then guests) in neutrals: the accent never encodes data, and
// the two series differ by fill and pattern, not by hue alone. It has a takeaway title, a one-line summary, a legend
// and a table view (WCAG 1.1.1, dataviz rules); the bars themselves are hidden from screen readers.
import { TOw } from "../../i18n/strings-owner";
import { getLang } from "../../i18n/i18n";
import { h, setChildren, type Child } from "../../lib/dom";
import { tooltip } from "../../lib/overlay";
import { dataTable } from "../../components/dataTable";
import { statGrid, statTile, statTileSkeleton } from "../../components/statGrid";
import type { AdminOverview, OverviewUsage } from "../../../shared/contract";
import { fmtInt, formatDateTime, formatPct, locale, relativeAgo } from "./format";
import type { ManageHost } from "./host";

export type OverviewOptions = {
  host: ManageHost;
  api: { load(): Promise<AdminOverview> };
  /** where each queue is worked (the console's sections and the review page) */
  links: { reviews: string; accounts: string };
};

export type OverviewPanel = {
  mount(panel: HTMLElement): void;
  load(): Promise<void>;
  render(): void;
};

/** Share of the allowance at which the budget warns (the same line as `scripts/data.ts usage`). */
const WARN_SHARE = 0.7;
const USAGE_COMMAND = "node --experimental-strip-types scripts/data.ts usage";
const DAY_MS = 24 * 60 * 60 * 1000;

type Day = AdminOverview["signups"][number];

const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

const formatBytes = (bytes: number): string =>
  `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)} GB`;

/** Sum of sign-ups over a slice of days. */
const total = (days: readonly Day[]): { users: number; guests: number; all: number } => {
  const users = days.reduce((n, d) => n + d.users, 0);
  const guests = days.reduce((n, d) => n + d.guests, 0);
  return { users, guests, all: users + guests };
};

/** The period's end-of-month value at the current pace, or null before a day of data. Pure. */
export function projectedCalls(usage: OverviewUsage, nowMs: number): number | null {
  if (usage.functionCalls === null || usage.periodStart === null || usage.periodEnd === null) return null;
  const start = Date.parse(usage.periodStart);
  const end = Date.parse(usage.periodEnd);
  const elapsed = Math.min(nowMs, end) - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || elapsed < DAY_MS || end <= start) return null;
  return Math.round((usage.functionCalls * (end - start)) / elapsed);
}

export function createOverviewPanel(opts: OverviewOptions): OverviewPanel {
  const { host } = opts;
  let data: AdminOverview | null = null;
  let error: string | null = null;
  let loading = false;
  let sig = "";

  const statusEl = h("p", { class: "small ov-status", role: "status" });
  const tilesEl = h("div", { class: "ov-tiles" });
  const chartEl = h("section", { class: "panel admin-panel ov-chart-panel", "aria-labelledby": "ov-chart-title" });
  const queuesEl = h("section", { class: "panel admin-panel ov-queues", "aria-labelledby": "ov-queues-title" });
  const budgetEl = h("section", { class: "panel admin-panel ov-budget", "aria-labelledby": "ov-budget-title" });

  function mount(panel: HTMLElement): void {
    setChildren(
      panel,
      h("p", { class: "muted ov-lead" }, TOw().ovLead),
      statusEl,
      tilesEl,
      h("div", { class: "ov-grid" }, chartEl, h("div", { class: "ov-side" }, queuesEl, budgetEl)),
    );
    render();
  }

  // ---- tiles ----------------------------------------------------------------------------

  function tiles(o: AdminOverview): HTMLElement {
    const last7 = total(o.signups.slice(-7));
    const prev7 = total(o.signups.slice(-14, -7));
    const diff = last7.all - prev7.all;
    const waiting = o.queues.reviews + o.queues.authorRequests + o.queues.resetRequests + o.queues.pendingSignups;
    const usage = o.usage;
    const callsValue: Child =
      usage.status === "ok" && usage.functionCalls !== null ? fmtInt(usage.functionCalls)
      : usage.status === "not-configured" ? TOw().callsNotConfigured
      : usage.status === "not-reported" ? TOw().callsNotReported
      : TOw().callsError;
    const share = usage.status === "ok" && usage.functionCalls !== null && usage.limit > 0 ? usage.functionCalls / usage.limit : null;
    return statGrid(
      [
        statTile({
          label: TOw().tileSignups,
          value: fmtInt(last7.all),
          subs: [TOw().signupsDelta(diff, prev7.all), TOw().signupsSplit(last7.users, last7.guests)],
          // More sign-ups is good: the colour follows desirability, the sign says the direction (text, not colour).
          trend: diff > 0 ? "up" : diff < 0 ? "down" : null,
        }),
        statTile({ label: TOw().tileActive, value: fmtInt(o.active.d7), subs: [TOw().activeSub(o.active.d1, o.active.d30), TOw().activeBasis] }),
        statTile({ label: TOw().tileClasses, value: fmtInt(o.classes.active), subs: [TOw().classesSub(o.classes.liveEvents, o.classes.archived)] }),
        statTile({ label: TOw().tileWaiting, value: fmtInt(waiting), subs: [TOw().waitingSub], className: waiting > 0 ? "ov-tile-waiting" : "" }),
        statTile({
          label: TOw().tileCalls,
          value: callsValue,
          subs: [TOw().callsOf(usage.limit), share === null ? null : TOw().callsShare(formatPct(share))],
          className: `ov-tile-calls${share !== null && share >= WARN_SHARE ? " is-warning" : ""}${usage.status === "ok" ? "" : " is-text"}`,
        }),
      ],
      "kpi-grid ov-kpis",
    );
  }

  function skeletonTiles(): HTMLElement {
    return statGrid([TOw().tileSignups, TOw().tileActive, TOw().tileClasses, TOw().tileWaiting, TOw().tileCalls].map(statTileSkeleton), "kpi-grid ov-kpis");
  }

  // ---- sign-up chart ------------------------------------------------------------------------

  const tableDetails = h("details", { class: "ov-table" });
  let tableOpen = false;
  tableDetails.addEventListener("toggle", () => (tableOpen = tableDetails.open));
  const signupTable = dataTable<Day>({
    columns: [
      { id: "day", header: TOw().colDay, rowHeader: true, cell: (d) => dayLabel(d.date), sortValue: (d) => d.date, sortFirst: "desc" },
      { id: "users", header: TOw().colUsers, numeric: true, cell: (d) => fmtInt(d.users), sortValue: (d) => d.users, sortFirst: "desc" },
      { id: "guests", header: TOw().colGuests, numeric: true, cell: (d) => fmtInt(d.guests), sortValue: (d) => d.guests, sortFirst: "desc" },
      { id: "total", header: TOw().colTotal, numeric: true, cell: (d) => fmtInt(d.users + d.guests), sortValue: (d) => d.users + d.guests, sortFirst: "desc" },
    ],
    rows: [],
    rowKey: (d) => d.date,
    rowSig: (d) => JSON.stringify([getLang(), d]),
    initialSort: { id: "day", dir: "desc" },
    className: "admin-table",
    wrapClass: "admin-dt",
    labelledBy: "ov-chart-title",
  });

  function chart(o: AdminOverview): Child[] {
    const all = total(o.signups);
    const peak = o.signups.reduce<Day | null>((best, d) => (best === null || d.users + d.guests > best.users + best.guests ? d : best), null);
    const peakTotal = peak === null ? 0 : peak.users + peak.guests;
    const max = Math.max(1, peakTotal);
    const pct = (n: number): string => `${((n / max) * 100).toFixed(2)}%`;
    const cols = o.signups.map((d) => {
      const col = h(
        "div",
        { class: "ov-col" },
        // Column-reverse in CSS: users sit on the baseline, guests on top; empty segments take no space.
        d.users > 0 ? h("span", { class: "ov-seg is-users", style: `block-size:${pct(d.users)}` }) : null,
        d.guests > 0 ? h("span", { class: "ov-seg is-guests", style: `block-size:${pct(d.guests)}` }) : null,
      );
      tooltip(col, () => TOw().chartTip(dayLabel(d.date), d.users, d.guests));
      return col;
    });
    const first = o.signups[0];
    const last = o.signups.at(-1);
    tableDetails.open = tableOpen;
    signupTable.update(o.signups);
    setChildren(tableDetails, h("summary", {}, TOw().showTable), signupTable.element);
    return [
      h("h2", { class: "admin-h2", id: "ov-chart-title" }, TOw().chartTitle(all.all)),
      h("p", { class: "muted small", id: "ov-chart-summary" }, TOw().chartSummary(peak === null ? "" : dayLabel(peak.date), peakTotal, all.users, all.guests), " ", TOw().chartTz(o.timezone)),
      h(
        "ul",
        { class: "ov-legend", "aria-label": TOw().chartLegend },
        h("li", {}, h("span", { class: "ov-key is-users", "aria-hidden": "true" }), TOw().legendUsers),
        h("li", {}, h("span", { class: "ov-key is-guests", "aria-hidden": "true" }), TOw().legendGuests),
      ),
      h(
        "div",
        { class: "ov-plot", "aria-hidden": "true" },
        h("div", { class: "ov-yaxis" }, h("span", {}, fmtInt(max)), h("span", {}, fmtInt(0))),
        h("div", { class: "ov-bars" }, cols),
      ),
      h("div", { class: "ov-xaxis", "aria-hidden": "true" }, h("span", {}, first ? dayLabel(first.date) : ""), h("span", {}, last ? dayLabel(last.date) : "")),
      tableDetails,
    ];
  }

  // ---- queues ----------------------------------------------------------------------------

  function queues(o: AdminOverview): Child[] {
    const rows: Array<{ label: string; n: number; href: string; id: string }> = [
      { id: "reviews", label: TOw().qReviews, n: o.queues.reviews, href: opts.links.reviews },
      { id: "author", label: TOw().qAuthor, n: o.queues.authorRequests, href: opts.links.reviews },
      { id: "resets", label: TOw().qResets, n: o.queues.resetRequests, href: opts.links.accounts },
      { id: "signups", label: TOw().qSignups, n: o.queues.pendingSignups, href: opts.links.accounts },
    ];
    const open = rows.filter((r) => r.n > 0);
    return [
      h("h2", { class: "admin-h2", id: "ov-queues-title" }, TOw().queuesTitle),
      open.length === 0 ? h("p", { class: "muted admin-empty-small" }, TOw().qNone) : null,
      h(
        "ul",
        { class: "ov-queue-list" },
        rows.map((r) =>
          h(
            "li",
            { class: `ov-queue${r.n > 0 ? " is-waiting" : ""}`, "data-queue": r.id },
            h("a", { href: r.href, class: "ov-queue-link" }, h("span", { class: "ov-queue-label" }, r.label), h("span", { class: `count-badge ${r.n > 0 ? "is-warn" : "is-zero"}` }, fmtInt(r.n))),
          ),
        ),
      ),
      h("h3", { class: "ov-h3" }, TOw().accountsTitle),
      h("p", { class: "muted small" }, TOw().accountsLine(o.accounts.users, o.accounts.guests, o.accounts.authors, o.accounts.banned, o.accounts.hidden)),
    ];
  }

  // ---- budget ----------------------------------------------------------------------------

  function budget(o: AdminOverview): Child[] {
    const u = o.usage;
    const nowMs = Date.parse(o.generatedAt);
    const hint = (lead: string): Child => h("p", { class: "muted small ov-hint" }, lead, " ", h("code", { class: "ov-cmd", dir: "ltr" }, USAGE_COMMAND));
    const checked = u.fetchedAt === null ? null : h("p", { class: "muted small", title: formatDateTime(u.fetchedAt) }, TOw().callsChecked(relativeAgo(u.fetchedAt, nowMs)));
    const bandwidth = u.bandwidthBytes !== null && u.bandwidthLimitBytes !== null ? h("p", { class: "muted small" }, TOw().bandwidth(formatBytes(u.bandwidthBytes), formatBytes(u.bandwidthLimitBytes))) : null;
    const head = h("h2", { class: "admin-h2", id: "ov-budget-title" }, TOw().budgetTitle);
    if (u.status !== "ok" || u.functionCalls === null) {
      const lead = u.status === "not-configured" ? TOw().callsNotConfiguredHelp : u.status === "not-reported" ? TOw().callsNotReportedHelp : TOw().callsErrorHelp(u.error ?? "");
      return [head, h("p", { class: "ov-budget-state" }, u.status === "not-configured" ? TOw().callsNotConfigured : u.status === "not-reported" ? TOw().callsNotReported : TOw().callsError), hint(lead), bandwidth, checked];
    }
    const share = u.limit > 0 ? u.functionCalls / u.limit : 0;
    const projected = projectedCalls(u, nowMs);
    const clamp = (r: number): string => `${(Math.min(1, Math.max(0, r)) * 100).toFixed(2)}%`;
    const warn = share >= WARN_SHARE;
    // A bullet graph (value vs target), not a gauge: the bar is the value, the tick the 70% line, the outline the pace.
    const bar = h(
      "div",
      { class: `ov-bullet${warn ? " is-warning" : ""}`, role: "img", "aria-label": TOw().budgetBarLabel(fmtInt(u.functionCalls), fmtInt(u.limit)) },
      h("span", { class: "ov-bullet-fill", style: `inline-size:${clamp(share)}` }),
      projected === null ? null : h("span", { class: "ov-bullet-pace", style: `inline-size:${clamp(projected / u.limit)}` }),
      h("span", { class: "ov-bullet-mark", style: `inset-inline-start:${clamp(WARN_SHARE)}`, title: TOw().budgetWarnMark }),
    );
    return [
      head,
      h("p", { class: "ov-budget-value" }, h("strong", {}, fmtInt(u.functionCalls)), " ", TOw().callsOf(u.limit)),
      bar,
      h("p", { class: `small${warn ? " ov-warn" : " muted"}` }, warn ? [h("span", { "aria-hidden": "true" }, "⚠ "), TOw().callsWarn] : TOw().callsShare(formatPct(share))),
      projected === null ? null : h("p", { class: "muted small" }, TOw().callsProjected(projected)),
      bandwidth,
      checked,
    ];
  }

  // ---- render ----------------------------------------------------------------------------

  function render(): void {
    statusEl.textContent = error !== null ? error : loading && data !== null ? TOw().ovUpdating : "";
    statusEl.classList.toggle("is-error", error !== null);
    statusEl.hidden = statusEl.textContent === "";
    if (data === null) {
      if (error !== null) {
        setChildren(tilesEl, h("button", { type: "button", class: "btn", onclick: () => void load() }, TOw().ovRetry));
        setChildren(chartEl);
        setChildren(queuesEl);
        setChildren(budgetEl);
        chartEl.hidden = queuesEl.hidden = budgetEl.hidden = true;
        return;
      }
      setChildren(tilesEl, skeletonTiles());
      setChildren(chartEl, h("h2", { class: "admin-h2", id: "ov-chart-title" }, TOw().ovLoading), h("div", { class: "dt-skeleton ov-chart-skeleton" }));
      chartEl.hidden = false;
      queuesEl.hidden = budgetEl.hidden = true;
      return;
    }
    chartEl.hidden = queuesEl.hidden = budgetEl.hidden = false;
    const next = JSON.stringify([getLang(), data]);
    if (next === sig) return; // unchanged: keep focus and the open table where they are
    sig = next;
    setChildren(tilesEl, tiles(data));
    setChildren(chartEl, chart(data));
    setChildren(queuesEl, queues(data));
    setChildren(budgetEl, budget(data));
  }

  async function load(): Promise<void> {
    loading = true;
    render();
    try {
      data = await opts.api.load();
      error = null;
    } catch (err: unknown) {
      if (host.handleAuthError(err)) return;
      error = TOw().ovFailed(err instanceof Error ? err.message : String(err));
    } finally {
      loading = false;
    }
    if (!host.disposed()) render();
  }

  return { mount, load, render };
}
