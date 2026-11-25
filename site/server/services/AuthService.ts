// Accounts, passwords and sessions. Sessions live server-side; the browser only holds an opaque
// token in an HttpOnly cookie, and the store keeps sha256(token), never the token itself.
import { usernameKey } from "../../shared/contract.ts";
import type { AccountView } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import {
  generateAccountId,
  generateSessionToken,
  getDummyPasswordHash,
  hashPassword,
  isWellFormedSessionToken,
  sha256Hex,
  verifyPassword,
} from "./crypto.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REFRESH_BELOW_MS = 15 * 24 * 60 * 60 * 1000; // renew when less than 15 days remain
const LAST_SEEN_RESOLUTION_MS = 60_000;

// Classrooms share one NAT IP, so IP limits only stop scripted floods, not a full class.
export const REGISTER_LIMIT: RateLimitRule = { bucket: "register-ip", max: 100, windowMs: 60 * 60_000, message: "too many sign-ups from this address" };
const LOGIN_IP_LIMIT: RateLimitRule = { bucket: "login-ip", max: 60, windowMs: 15 * 60_000, message: "too many failed logins from this address" };
export const LOGIN_USER_LIMIT: RateLimitRule = { bucket: "login-user", max: 8, windowMs: 15 * 60_000, message: "too many failed logins for this username, wait a bit" };

export type Session = { readonly token: string; readonly maxAgeSeconds: number };
export type AuthResult = { readonly account: AccountView; readonly session: Session };
export type CredentialsInput = { readonly username: string; readonly password: string; readonly ip: string };

export const toAccountView = (account: AccountRecord): AccountView => ({
  id: account.id,
  username: account.username,
  status: account.status,
  createdAt: account.createdAt,
});

export class AuthService {
  private readonly repos: Repositories;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; limiter: RateLimiter; now: () => Date }) {
    this.repos = deps.repos;
    this.limiter = deps.limiter;
    this.now = deps.now;
  }

  async register(input: CredentialsInput): Promise<AuthResult> {
    await this.limiter.assertAllowed(REGISTER_LIMIT, input.ip);
    const key = usernameKey(input.username);
    const hashedKey = sha256Hex(key);
    if (await this.repos.usernames.lookup(hashedKey)) throw new AppError(409, "that username is taken", { code: "username-taken" });

    const nowIso = this.now().toISOString();
    const account: AccountRecord = {
      id: generateAccountId(),
      username: input.username.trim(),
      usernameKey: key,
      passwordHash: await hashPassword(input.password),
      status: "pending",
      sessionEpoch: 0,
      createdAt: nowIso,
      decidedAt: null,
      lastSeenAt: nowIso,
      lastLoginAt: nowIso,
    };
    // Claim the name first: the conditional write makes uniqueness race-free.
    if (!(await this.repos.usernames.claim(hashedKey, account.id))) throw new AppError(409, "that username is taken", { code: "username-taken" });
    if (!(await this.repos.accounts.saveIfMatch(account, null))) {
      await this.repos.usernames.release(hashedKey);
      throw new AppError(409, "id collision, retry");
    }
    await this.limiter.hit(REGISTER_LIMIT, input.ip);
    return { account: toAccountView(account), session: await this.createSession(account) };
  }

  async login(input: CredentialsInput): Promise<AuthResult> {
    const key = usernameKey(input.username);
    await this.limiter.assertAllowed(LOGIN_IP_LIMIT, input.ip);
    await this.limiter.assertAllowed(LOGIN_USER_LIMIT, key);

    const accountId = await this.repos.usernames.lookup(sha256Hex(key));
    const found = accountId ? await this.repos.accounts.get(accountId) : null;
    // Always run scrypt so response time doesn't reveal whether the username exists.
    const isValid = await verifyPassword(input.password, found?.data.passwordHash ?? (await getDummyPasswordHash()));
    if (!found || !isValid) {
      await this.limiter.hit(LOGIN_IP_LIMIT, input.ip);
      await this.limiter.hit(LOGIN_USER_LIMIT, key);
      throw new AppError(401, "wrong username or password", { code: "bad-credentials" });
    }
    const account = found.data;
    if (account.status === "rejected") throw new AppError(403, "this account was not approved", { code: "rejected" });
    await this.limiter.clear(LOGIN_USER_LIMIT, key);
    const updated = { ...account, lastLoginAt: this.now().toISOString(), lastSeenAt: this.now().toISOString() };
    await this.repos.accounts.saveIfMatch(updated, found.etag); // best effort
    return { account: toAccountView(updated), session: await this.createSession(account) };
  }

  async logout(token: string | null): Promise<void> {
    if (token && isWellFormedSessionToken(token)) await this.repos.sessions.delete(sha256Hex(token));
  }

  /** Resolves the session cookie to an account. Throws 401 when missing, unknown, expired or revoked. */
  async authenticate(token: string | null): Promise<{ account: AccountRecord; renewed: Session | null }> {
    if (!token || !isWellFormedSessionToken(token)) throw new AppError(401, "sign in required", { code: "signed-out" });
    const tokenHash = sha256Hex(token);
    const session = await this.repos.sessions.get(tokenHash);
    const nowMs = this.now().getTime();
    if (!session || Date.parse(session.expiresAt) <= nowMs) throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
    const found = await this.repos.accounts.get(session.accountId);
    if (!found || found.data.sessionEpoch !== session.epoch) {
      await this.repos.sessions.delete(tokenHash);
      throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
    }

    let renewed: Session | null = null;
    if (Date.parse(session.expiresAt) - nowMs < SESSION_REFRESH_BELOW_MS) {
      await this.repos.sessions.save(tokenHash, { ...session, expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString() });
      renewed = { token, maxAgeSeconds: SESSION_TTL_SECONDS };
    }
    const account = found.data;
    if (account.lastSeenAt === null || nowMs - Date.parse(account.lastSeenAt) >= LAST_SEEN_RESOLUTION_MS) {
      account.lastSeenAt = this.now().toISOString();
      await this.repos.accounts.saveIfMatch(account, found.etag); // best effort: a lost race is harmless
    }
    return { account, renewed };
  }

  /** authenticate() + the account must be approved. */
  async requireApproved(token: string | null): Promise<AccountRecord> {
    const { account } = await this.authenticate(token);
    if (account.status === "pending") throw new AppError(403, "waiting for the instructor to approve your account", { code: "pending" });
    if (account.status === "rejected") throw new AppError(403, "this account was not approved", { code: "rejected" });
    return account;
  }

  private async createSession(account: AccountRecord): Promise<Session> {
    const token = generateSessionToken();
    const now = this.now();
    await this.repos.sessions.save(sha256Hex(token), {
      accountId: account.id,
      epoch: account.sessionEpoch,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    });
    return { token, maxAgeSeconds: SESSION_TTL_SECONDS };
  }
}
