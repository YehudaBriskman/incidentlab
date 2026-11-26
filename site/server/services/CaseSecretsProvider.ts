// The answer keys and paid content the game reads: the bundled generated/secrets.json, overlaid with every case
// published in the DB (#64/#66). A DB case wins over a bundled case with the same id. Services read it
// synchronously (`.cases`, the same shape as `Secrets`); the router calls `refresh()` before each request, which
// reloads from the DB at most once per TTL and keeps the last good copy when the DB can't be read.
import type { CaseSecrets, Secrets } from "../domain/types.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";

/** What the provider needs from the case store: the published ids and their sealed parts. */
export type PublishedSealedSource = {
  publishedIds(): Promise<string[]>;
  getSealed(id: string): Promise<CaseSecrets | null>;
};

export const SECRETS_REFRESH_MS = 60_000;

export class CaseSecretsProvider implements Secrets {
  private readonly bundled: Readonly<Record<string, CaseSecrets>>;
  private readonly source: PublishedSealedSource | null;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private merged: Record<string, CaseSecrets>;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(deps: { bundled: Secrets; source: PublishedSealedSource | null; now: () => Date; ttlMs?: number }) {
    this.bundled = deps.bundled.cases;
    this.source = deps.source;
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? SECRETS_REFRESH_MS;
    this.merged = { ...this.bundled };
  }

  get cases(): Record<string, CaseSecrets> {
    return this.merged;
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
      const ids = await source.publishedIds();
      const sealed = await mapWithConcurrency(ids, async (id) => [id, await source.getSealed(id)] as const);
      const fromDb: Record<string, CaseSecrets> = {};
      for (const [id, value] of sealed) if (value !== null) fromDb[id] = value;
      this.merged = { ...this.bundled, ...fromDb };
      this.loadedAt = this.now().getTime();
    } catch (error) {
      // Keep serving the last good copy; the next request retries.
      console.error("[incidentlab-api] could not load DB case secrets", error);
    }
  }
}
