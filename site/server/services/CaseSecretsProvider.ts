// The answer keys and paid content the game reads: every case published in the DB (#64/#66/#68). `bundled`
// is a fixed base layer that only tests pass (createApp's `staticSecrets`); production passes an empty one,
// so released case ids and answers come from the DB alone. A DB case wins over a base case with the same id. Services read it
// synchronously (`.cases`, the same shape as `Secrets`); the router calls `refresh()` before each request, which
// reloads from the DB at most once per TTL and keeps the last good copy when the DB can't be read.
//
// Private cases (#184) are kept apart: `.cases` (the released cases: schedule, today, boards, stats, class
// assignment) holds public cases only. `playable` adds the private ones for GameService, whose controller
// lets only the author, the site admin and members of an assigned class reach them (CaseAccessService).
import type { CaseMeta } from "../../shared/case-records.ts";
import type { CaseSecrets, Secrets } from "../domain/types.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";

/** What the provider needs from the case store: the published ids and their sealed parts. */
export type PublishedSealedSource = {
  /** the published public cases */
  publishedIds(): Promise<string[]>;
  /** the live private cases (#184); a source without it has none */
  privateMetas?(): Promise<CaseMeta[]>;
  getSealed(id: string): Promise<CaseSecrets | null>;
};

/** What the provider remembers about a private case, to answer "may this account see any?" without reads. */
export type PrivateCaseRef = { readonly id: string; readonly createdBy: string; readonly classIds: readonly string[] };

export const SECRETS_REFRESH_MS = 60_000;

/** A read-only Secrets view over a map that is swapped on every reload. */
class SecretsView implements Secrets {
  private readonly read: () => Record<string, CaseSecrets>;
  constructor(read: () => Record<string, CaseSecrets>) {
    this.read = read;
  }
  get cases(): Record<string, CaseSecrets> {
    return this.read();
  }
}

export class CaseSecretsProvider implements Secrets {
  private readonly bundled: Readonly<Record<string, CaseSecrets>>;
  private readonly source: PublishedSealedSource | null;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private merged: Record<string, CaseSecrets>;
  private privateSealed: Record<string, CaseSecrets> = {};
  private privateList: PrivateCaseRef[] = [];
  private withPrivate: Record<string, CaseSecrets>;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(deps: { bundled: Secrets; source: PublishedSealedSource | null; now: () => Date; ttlMs?: number }) {
    this.bundled = deps.bundled.cases;
    this.source = deps.source;
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? SECRETS_REFRESH_MS;
    this.merged = { ...this.bundled };
    this.withPrivate = this.merged;
  }

  /** The released (public) cases. */
  get cases(): Record<string, CaseSecrets> {
    return this.merged;
  }

  /** Public and private cases together, for GameService only (access is checked before it is called). */
  readonly playable: Secrets = new SecretsView(() => this.withPrivate);

  /** The private cases' ids, for leaving them out of public totals (the global board). */
  privateCaseIds(): string[] {
    return this.privateList.map((c) => c.id);
  }

  /** Who owns each private case and which classes may play it, as of the last load (at most one TTL old). */
  privateCases(): readonly PrivateCaseRef[] {
    return this.privateList;
  }

  /** Reloads DB cases when the copy is older than the TTL (or always with `force`). Never throws. */
  async refresh(force = false): Promise<void> {
    if (this.source === null) return;
    if (!force && this.now().getTime() - this.loadedAt < this.ttlMs) return;
    this.inFlight ??= this.load(this.source).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async load(source: PublishedSealedSource): Promise<void> {
    try {
      const [ids, privateMetas] = await Promise.all([source.publishedIds(), source.privateMetas ? source.privateMetas() : Promise.resolve([])]);
      const sealed = await mapWithConcurrency(ids, async (id) => [id, await source.getSealed(id)] as const);
      const fromDb: Record<string, CaseSecrets> = {};
      for (const [id, value] of sealed) if (value !== null) fromDb[id] = value;
      const privateRows = await mapWithConcurrency(privateMetas, async (meta) => [meta, await source.getSealed(meta.id)] as const);
      const privateSealed: Record<string, CaseSecrets> = {};
      const privateList: PrivateCaseRef[] = [];
      for (const [meta, value] of privateRows) {
        if (value === null || meta.id in fromDb || meta.id in this.bundled) continue;
        privateSealed[meta.id] = value;
        privateList.push({ id: meta.id, createdBy: meta.createdBy, classIds: [...meta.classIds] });
      }
      this.merged = { ...this.bundled, ...fromDb };
      this.privateSealed = privateSealed;
      this.privateList = privateList;
      this.withPrivate = { ...this.merged, ...this.privateSealed };
      this.loadedAt = this.now().getTime();
    } catch (error) {
      // Keep serving the last good copy; the next request retries.
      console.error("[incidentlab-api] could not load DB case secrets", error);
    }
  }
}
