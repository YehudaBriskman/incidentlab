import { AppError } from "../domain/types.ts";
import type { RateLimitRepository } from "../repositories/repositories.ts";
import { sha256Hex } from "./crypto.ts";

export type RateLimitRule = { readonly bucket: string; readonly max: number; readonly windowMs: number; readonly message: string };

/** Sliding-window limiter persisted in the KV store (so it works across function instances). */
export class RateLimiter {
  private readonly repository: RateLimitRepository;
  private readonly now: () => Date;

  constructor(repository: RateLimitRepository, now: () => Date) {
    this.repository = repository;
    this.now = now;
  }

  private key(rule: RateLimitRule, subject: string): string {
    return `${rule.bucket}:${sha256Hex(subject || "unknown")}`;
  }

  private async recent(rule: RateLimitRule, subject: string): Promise<number[]> {
    const nowMs = this.now().getTime();
    return (await this.repository.getHits(this.key(rule, subject))).filter((t) => nowMs - t < rule.windowMs);
  }

  /** Throws 429 when the subject is already at the limit. Does not record a hit. */
  async assertAllowed(rule: RateLimitRule, subject: string): Promise<void> {
    const recent = await this.recent(rule, subject);
    const oldest = recent[0];
    if (recent.length >= rule.max && oldest !== undefined) {
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + rule.windowMs - this.now().getTime()) / 1000));
      throw new AppError(429, rule.message, { code: "rate-limited", retryAfterSeconds });
    }
  }

  async hit(rule: RateLimitRule, subject: string): Promise<void> {
    const recent = await this.recent(rule, subject);
    await this.repository.setHits(this.key(rule, subject), [...recent, this.now().getTime()].slice(-rule.max));
  }

  async clear(rule: RateLimitRule, subject: string): Promise<void> {
    await this.repository.setHits(this.key(rule, subject), []);
  }
}
