// Guest play (#176): a signed-out visitor can start a case without an account, and later upgrade the guest to
// a full account. The upgrade keeps the account id, so every `progress:<case>:<id>` record stays theirs.
//
// A guest is a normal AccountRecord with kind "guest", status "approved" and role "player", so the game routes
// treat it like any player. It has no password (an empty hash never verifies) and its generated username
// `guest-<id>` is never claimed in the `username:` index, so nobody can sign in as a guest.
// Guests are on no leaderboard; idle guests are soft-deleted by the hygiene job (AccountHygieneService).
import { GUEST_USERNAME_PREFIX, RESERVED_USERNAMES, usernameKey } from "../../shared/contract.ts";
import type { AccountView } from "../../shared/contract.ts";
import { ACCOUNT_SCHEMA_VERSION, AppError } from "../domain/types.ts";
import type { AccountRecord, SessionRecord } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { REGISTER_LIMIT, SESSION_TTL_SECONDS, issueRecoveryCode, toAccountView } from "./AuthService.ts";
import type { AuthService, Session, SignInResult } from "./AuthService.ts";
import { generateAccountId, generateSessionToken, hashPassword, isWellFormedSessionToken, sha256Hex } from "./crypto.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

/** One classroom NAT may start a guest per student; this only stops scripted floods. */
export const GUEST_LIMIT: RateLimitRule = { bucket: "guest-ip", max: 30, windowMs: 60 * 60_000, message: "too many guest sessions from this address" };

export type GuestStart = { readonly account: AccountView; readonly created: boolean; readonly session: Session | null };
export type UpgradeInput = { readonly username: string; readonly password: string; readonly ip: string };

export class GuestService {
  private readonly repos: Repositories;
  private readonly auth: AuthService;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; auth: AuthService; limiter: RateLimiter; now: () => Date }) {
    this.repos = deps.repos;
    this.auth = deps.auth;
    this.limiter = deps.limiter;
    this.now = deps.now;
  }

  /**
   * Creates a guest and its session, unless the cookie already holds a live session: then that account is
   * returned (a double click or a second tab never makes a second guest). `session` is the cookie to set:
   * the new session, a renewed one, or null to leave the cookie alone.
   */
  async start(token: string | null, ip: string): Promise<GuestStart> {
    const existing = await this.currentSession(token);
    if (existing !== null) return { account: existing.view, created: false, session: existing.renewed };

    await this.limiter.assertAllowed(GUEST_LIMIT, ip);
    const nowIso = this.now().toISOString();
    const id = generateAccountId();
    const username = `${GUEST_USERNAME_PREFIX}${id}`;
    const account: AccountRecord = {
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
      id,
      username,
      usernameKey: usernameKey(username),
      passwordHash: "", // never verifies: a guest can't sign in, only keep its session or upgrade
      status: "approved",
      sessionEpoch: 0,
      createdAt: nowIso,
      decidedAt: nowIso,
      lastSeenAt: nowIso,
      lastLoginAt: nowIso,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      role: "player",
      kind: "guest",
      showOnGlobalBoard: false,
      recoveryCodeHash: null,
      classLimit: null,
    };
    if (!(await this.repos.accounts.saveIfMatch(account, null))) throw new AppError(409, "id collision, retry");
    await this.limiter.hit(GUEST_LIMIT, ip);
    return { account: toAccountView(account), created: true, session: await this.issueSession(account) };
  }

  /**
   * Turns the signed-in guest into a user with the same id. The username is claimed first with a conditional
   * write (race-free, like register); the account is then saved with its etag, and the claim is released if
   * that save loses a race. Other sessions of the guest end (the epoch moves); this one is replaced.
   */
  async upgrade(token: string | null, input: UpgradeInput): Promise<SignInResult> {
    const { principal } = await this.auth.authenticate(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin account can't be upgraded", { code: "admin" });
    if (principal.account.kind !== "guest") throw new AppError(409, "this account already has a username", { code: "not-guest" });
    await this.limiter.assertAllowed(REGISTER_LIMIT, input.ip);

    const key = usernameKey(input.username);
    if (RESERVED_USERNAMES.includes(key) || key.startsWith(GUEST_USERNAME_PREFIX)) {
      throw new AppError(409, "that username is reserved", { code: "reserved" });
    }
    const hashedKey = sha256Hex(key);
    if (await this.repos.usernames.lookup(hashedKey)) throw new AppError(409, "that username is taken", { code: "username-taken" });
    const passwordHash = await hashPassword(input.password);
    const recovery = await issueRecoveryCode(); // the new account's one-time code (#174), as on sign-up

    if (!(await this.repos.usernames.claim(hashedKey, principal.account.id))) throw new AppError(409, "that username is taken", { code: "username-taken" });
    const found = await this.repos.accounts.get(principal.account.id);
    if (!found || found.data.kind !== "guest") {
      await this.repos.usernames.release(hashedKey);
      throw new AppError(409, "this account already has a username", { code: "not-guest" });
    }
    const nowIso = this.now().toISOString();
    const account: AccountRecord = {
      ...found.data,
      username: input.username.trim(),
      usernameKey: key,
      passwordHash,
      recoveryCodeHash: recovery.hash,
      kind: "user",
      sessionEpoch: found.data.sessionEpoch + 1,
      lastSeenAt: nowIso,
      lastLoginAt: nowIso,
    };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) {
      await this.repos.usernames.release(hashedKey);
      throw new AppError(409, "concurrent update, please retry");
    }
    await this.limiter.hit(REGISTER_LIMIT, input.ip);
    if (token !== null && isWellFormedSessionToken(token)) await this.repos.sessions.delete(sha256Hex(token));
    return { account: toAccountView(account), session: await this.issueSession(account), recoveryCode: recovery.code };
  }

  /** The live session behind the cookie, or null when there is none (missing, expired, revoked). */
  private async currentSession(token: string | null): Promise<{ view: AccountView; renewed: Session | null } | null> {
    if (token === null) return null;
    try {
      const { view, renewed } = await this.auth.authenticate(token);
      return { view, renewed };
    } catch (error: unknown) {
      if (error instanceof AppError && error.status === 401) return null;
      throw error;
    }
  }

  /** A player session, stored like AuthService's: only sha256(token) is kept. */
  private async issueSession(account: AccountRecord): Promise<Session> {
    const token = generateSessionToken();
    const now = this.now();
    const record: SessionRecord = {
      role: "player",
      accountId: account.id,
      epoch: account.sessionEpoch,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    };
    await this.repos.sessions.save(sha256Hex(token), record);
    return { token, maxAgeSeconds: SESSION_TTL_SECONDS };
  }
}
