// Recently visited places (a case, its toolbox, an Explorer file), kept in localStorage for the home page's
// "Continue" card. One entry per place kind and case (the Explorer keeps its last file), newest first, at most
// RECENT_MAX. Every read is validated: a corrupt or foreign value reads as an empty list.
import { z } from "zod";

const KEY = "il.recent";
export const RECENT_MAX = 6;

export const VisitSchema = z.object({
  kind: z.enum(["case", "toolbox", "explorer"]),
  caseId: z.string().min(1).max(80),
  /** the Explorer file (evidence path), null for case and toolbox visits */
  file: z.string().max(300).nullable().default(null),
  /** ms since the epoch */
  at: z.number().int().nonnegative(),
});
export type Visit = z.infer<typeof VisitSchema>;
export type VisitInput = { readonly kind: Visit["kind"]; readonly caseId: string; readonly file?: string | null };

/** Parses a stored list, dropping any entry that doesn't validate. */
export function parseVisits(raw: string | null): Visit[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) => {
      const result = VisitSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

const sameSlot = (a: Pick<Visit, "kind" | "caseId">, b: Pick<Visit, "kind" | "caseId">): boolean => a.kind === b.kind && a.caseId === b.caseId;

/** The list with `visit` first, its older entry for the same place removed, capped at `max`. */
export function pushVisit(list: readonly Visit[], visit: Visit, max: number = RECENT_MAX): Visit[] {
  return [visit, ...list.filter((v) => !sameSlot(v, visit))].slice(0, max);
}

/** The route of a visit. */
export function visitHref(v: Pick<Visit, "kind" | "caseId" | "file">): string {
  const base = `#/case/${encodeURIComponent(v.caseId)}`;
  if (v.kind === "toolbox") return `${base}/toolbox`;
  if (v.kind === "explorer") return v.file === null ? `${base}/explorer` : `${base}/explorer?${new URLSearchParams({ f: v.file }).toString()}`;
  return base;
}

export function recentVisits(): Visit[] {
  try {
    return parseVisits(localStorage.getItem(KEY));
  } catch {
    return []; // storage blocked
  }
}

/** Notes a visit (called by the case, toolbox and Explorer views). */
export function recordVisit(input: VisitInput, now: number = Date.now()): void {
  const visit = VisitSchema.safeParse({ kind: input.kind, caseId: input.caseId, file: input.kind === "explorer" ? (input.file ?? null) : null, at: now });
  if (!visit.success) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(pushVisit(recentVisits(), visit.data)));
  } catch {
    /* storage blocked or full: the list is a convenience only */
  }
}
