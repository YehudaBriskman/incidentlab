// DOM-free rules behind lib/overlay.ts: focus wrapping, menu keys and typeahead, anchored placement, the
// modal stack and the toast queue. Kept apart so node:test can check them without a browser
// (overlay-logic.test.ts).

/* ---------- focus trap ---------- */

/**
 * Where Tab should go inside a trap of `count` tabbable elements, given the index of the focused one
 * (-1 when focus is outside the list or on the container itself). Returns null when the browser's own
 * move is already right (somewhere in the middle of the list).
 */
export function trapTarget(active: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (active < 0) return shift ? count - 1 : 0;
  if (shift && active === 0) return count - 1;
  if (!shift && active === count - 1) return 0;
  return null;
}

/* ---------- APG menu keys ---------- */

/** Index of the item a navigation key moves to (wrapping), or null when the key does not navigate. */
export function menuKeyTarget(key: string, active: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return active < 0 ? 0 : (active + 1) % count;
    case "ArrowUp":
      return active < 0 ? count - 1 : (active - 1 + count) % count;
    case "Home":
    case "PageUp":
      return 0;
    case "End":
    case "PageDown":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Typeahead: the next label (after `active`, wrapping) that starts with `query`, case-insensitively.
 * A query of one repeated character ("dd") cycles through the items starting with that character.
 * Returns -1 when nothing matches.
 */
export function typeaheadMatch(labels: readonly string[], query: string, active: number): number {
  if (labels.length === 0 || query.length === 0) return -1;
  const q = query.toLocaleLowerCase();
  const repeated = [...q].every((ch) => ch === q[0]);
  const needle = repeated ? q.slice(0, 1) : q;
  // A fresh single character starts after the active item; a longer query may still match the active one.
  const startOffset = needle.length === 1 ? 1 : 0;
  for (let step = 0; step < labels.length; step++) {
    const i = (Math.max(active, 0) + startOffset + step) % labels.length;
    const label = labels[i];
    if (label !== undefined && label.trim().toLocaleLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/* ---------- anchored placement ---------- */

export type Rect = { top: number; bottom: number; left: number; right: number };
export type Size = { width: number; height: number };

/**
 * Viewport coordinates for a panel under its anchor. `align: "end"` lines the panel's inline-end edge up with
 * the anchor's (it grows away from the screen edge the anchor usually sits at); "start" lines up the
 * inline-start edges. RTL swaps which physical side is "end". The panel flips above the anchor when it
 * would leave the viewport below, and is clamped `margin` px inside the viewport on every side.
 */
export function placeAnchored(
  anchor: Rect,
  panel: Size,
  viewport: Size,
  opts: { align: "start" | "end"; rtl: boolean; gap?: number; margin?: number },
): { left: number; top: number } {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 8;
  const alignRight = (opts.align === "end") !== opts.rtl; // the panel's right edge on the anchor's right edge
  const rawLeft = alignRight ? anchor.right - panel.width : anchor.left;
  const maxLeft = Math.max(margin, viewport.width - panel.width - margin);
  const left = Math.min(Math.max(margin, rawLeft), maxLeft);
  const fitsBelow = anchor.bottom + gap + panel.height <= viewport.height - margin;
  const fitsAbove = anchor.top - gap - panel.height >= margin;
  const top = fitsBelow || !fitsAbove ? Math.min(anchor.bottom + gap, Math.max(margin, viewport.height - panel.height - margin)) : anchor.top - gap - panel.height;
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)) };
}

/* ---------- modal stack ---------- */

/**
 * Open modals, bottom to top. Only the top one owns focus. Closing the top one returns focus to its opener;
 * closing one lower down (a confirm whose action opened a second dialog) hands its opener to the modal
 * directly above, so focus still ends on the original trigger when that one closes.
 */
export class ModalStack<T extends { opener: unknown }> {
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  top(): T | undefined {
    return this.items[this.items.length - 1];
  }

  push(item: T): void {
    this.items.push(item);
  }

  /** Removes `item`. Returns true when it was the top one (the caller restores focus to its opener). */
  remove(item: T, openerInside: (opener: T["opener"], closing: T) => boolean): boolean {
    const i = this.items.indexOf(item);
    if (i < 0) return false;
    const wasTop = i === this.items.length - 1;
    const above = this.items[i + 1];
    if (above !== undefined && openerInside(above.opener, item)) above.opener = item.opener;
    this.items.splice(i, 1);
    return wasTop;
  }

  all(): readonly T[] {
    return [...this.items];
  }
}

/* ---------- toast queue ---------- */

/** One toast per key (tone + text): a repeat bumps its count. At most `max` stay; the oldest goes first. */
export class ToastQueue<T> {
  private readonly entries = new Map<string, { value: T; count: number }>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Adds or bumps `key`. Returns the new count and the keys pushed out to stay within `max`. */
  add(key: string, make: () => T): { value: T; count: number; isNew: boolean; evicted: Array<{ key: string; value: T }> } {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.count++;
      return { value: existing.value, count: existing.count, isNew: false, evicted: [] };
    }
    const entry = { value: make(), count: 1 };
    this.entries.set(key, entry);
    const evicted: Array<{ key: string; value: T }> = [];
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const value = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (value !== undefined) evicted.push({ key: oldest.value, value: value.value });
    }
    return { value: entry.value, count: 1, isNew: true, evicted };
  }

  get(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
