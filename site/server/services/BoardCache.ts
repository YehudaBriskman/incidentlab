// A short in-instance memo of the global board's players (#185). The opted-in set is read by the public
// leaderboard on every CDN miss (one per ?caseId= variant) and by every /api/me/stats for the player's rank:
// at public-site scale that is a read of every opted-in account and summary per call. The memo shares one read
// for BOARD_MEMO_MS. Every write on this instance that can change the board (a score summary, an opt-in or out,
// a ban or unban, a delete) clears it, so a single instance always answers from current data; another instance
// may lag by at most BOARD_MEMO_MS, on top of the CDN's own 10 s. /api/me/stats puts the player's own fresh
// summary into the rows, so a player's own solve shows in their rank at once.

export const BOARD_MEMO_MS = 10_000;

export class BoardCache<T> {
  private entry: { at: number; value: Promise<T>; generation: number } | null = null;
  private generation = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** The memoized value, or a fresh one from `load` when there is none or it is older than BOARD_MEMO_MS. */
  get(load: () => Promise<T>): Promise<T> {
    const at = this.now();
    const entry = this.entry;
    if (entry && at - entry.at < BOARD_MEMO_MS && at >= entry.at) return entry.value;
    const generation = this.generation;
    const value = load();
    const next = { at, value, generation };
    this.entry = next;
    // A failed read is never served again; a read that raced a clear() is dropped once it settles.
    value.then(
      () => {
        if (this.entry === next && next.generation !== this.generation) this.entry = null;
      },
      () => {
        if (this.entry === next) this.entry = null;
      },
    );
    return value;
  }

  /** Something on the board changed: the next read loads again. */
  clear(): void {
    this.generation += 1;
    this.entry = null;
  }
}
