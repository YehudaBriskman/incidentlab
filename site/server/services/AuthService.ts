// Accounts, passwords and sessions. Sessions live server-side; the browser only holds an opaque
// token in an HttpOnly cookie, and the store keeps sha256(token), never the token itself.
// Signing in as `admin` with the ADMIN_KEY creates an admin session (no account record behind it).
import { ADMIN_USERNAME, RESERVED_USERNAMES, usernameKey } from "../../shared/contract.ts";
import type { AccountView } from "../../shared/contract.ts";
import { ACCOUNT_SCHEMA_VERSION, AppError } from "../domain/types.ts";
import type { AccountRecord, SessionRecord } from "../domain/types.ts";
import type { SettingsRepository } from "../repositories/config-repositories.ts";
import type { Repositories } from "../repositories/repositories.ts";
import {
  generateAccountId,
  generateSessionToken,
  getDummyPasswordHash,
  hashPassword,
  isWellFormedSessionToken,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from "./crypto.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_REFRESH_BELOW_MS = 15 * 24 * 60 * 60 * 1000; // renew player sessions when less than 15 days remain
const LAST_SEEN_RESOLUTION_MS = 60_000;
const MIN_ADMIN_KEY_LENGTH = 16;

// Classrooms share one NAT IP, so IP limits only stop scripted floods, not a full class.
export const REGISTER_LIMIT: RateLimitRule = { bucket: "register-ip", max: 100, windowMs: 60 * 60_000, message: "too many sign-ups from this address" };
const LOGIN_IP_LIMIT: RateLimitRule = { bucket: "login-ip", max: 60, windowMs: 15 * 60_000, message: "too many failed logins from this address" };
export const LOGIN_USER_LIMIT: RateLimitRule = { bucket: "login-user", max: 8, windowMs: 15 * 60_000, message: "too many failed logins for this username, wait a bit" };

export type Session = { readonly token: string; readonly maxAgeSeconds: number };
export type AuthResult = { readonly account: AccountView; readonly session: Session };
export type CredentialsInput = { readonly username: string; readonly password: string; readonly ip: string };
export type RegisterInput = CredentialsInput & { readonly inviteCode?: string | undefined };

/** Who is behind a session cookie. */
export type Principal = { readonly kind: "player"; readonly account: AccountRecord } | { readonly kind: "admin" };

export const ADMIN_VIEW = (createdAt: string): AccountView => ({
  id: "admin",
  username: ADMIN_USERNAME,
  status: "approved",
  createdAt,
  role: "admin",
  mustChangePassword: false,
});

export const toAccountView = (account: AccountRecord): AccountView => ({
  id: account.id,
  username: account.username,
  status: account.status,
  createdAt: account.createdAt,
  role: account.role,
  mustChangePassword: account.mustChangePassword,
});

export const adminKeyFingerprint = (adminKey: string): string => sha256Hex(adminKey).slice(0, 16);

export class AuthService {
  private readonly repos: Repositories;
  private readonly settings: SettingsRepository;
  private readonly limiter: RateLimiter;
  private readonly adminKey: () => string | undefined;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; settings: SettingsRepository; limiter: RateLimiter; adminKey: () => string | undefined; now: () => Date }) {
    this.repos = deps.repos;
    this.settings = deps.settings;
    this.limiter = deps.limiter;
    this.adminKey = deps.adminKey;
    this.now = deps.now;
  }

  async register(input: RegisterInput): Promise<AuthResult> {
    await this.limiter.assertAllowed(REGISTER_LIMIT, input.ip);
    const key = usernameKey(input.username);
    if (RESERVED_USERNAMES.includes(key)) throw new AppError(409, "that username is reserved", { code: "reserved" });
    const hashedKey = sha256Hex(key);
    if (await this.repos.usernames.lookup(hashedKey)) throw new AppError(409, "that username is taken", { code: "username-taken" });

    const { inviteCode } = await this.settings.get();
    const hasValidCode =
      inviteCode !== null && input.inviteCode !== undefined && input.inviteCode.trim().length > 0 && safeEqual(input.inviteCode.trim().toLowerCase(), inviteCode.toLowerCase());
    if (input.inviteCode !== undefined && input.inviteCode.trim().length > 0 && !hasValidCode) {
      throw new AppError(400, "that class code isn't valid", { code: "bad-invite-code" });
    }

    const nowIso = this.now().toISOString();
    const account: AccountRecord = {
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
      id: generateAccountId(),
      username: input.username.trim(),
      usernameKey: key,
      passwordHash: await hashPassword(input.password),
      status: hasValidCode ? "approved" : "pending",
      sessionEpoch: 0,
      createdAt: nowIso,
      decidedAt: hasValidCode ? nowIso : null,
      lastSeenAt: nowIso,
      lastLoginAt: nowIso,
      mustChangePassword: false,
      role: "player",
    };
    // Claim the name first: the conditional write makes uniqueness race-free.
    if (!(await this.repos.usernames.claim(hashedKey, account.id))) throw new AppError(409, "that username is taken", { code: "username-taken" });
    if (!(await this.repos.accounts.saveIfMatch(account, null))) {
      await this.repos.usernames.release(hashedKey);
      throw new AppError(409, "id collision, retry");
    }
    await this.limiter.hit(REGISTER_LIMIT, input.ip);
    return { account: toAccountView(account), session: await this.createSession({ role: "player", account }) };
  }

  async login(input: CredentialsInput): Promise<AuthResult> {
    const key = usernameKey(input.username);
    await this.limiter.assertAllowed(LOGIN_IP_LIMIT, input.ip);
    await this.limiter.assertAllowed(LOGIN_USER_LIMIT, key);
    if (key === ADMIN_USERNAME) return this.adminLogin(input, key);

    const accountId = await this.repos.usernames.lookup(sha256Hex(key));
    const found = accountId ? await this.repos.accounts.get(accountId) : null;
    // Always run scrypt so response time doesn't reveal whether the username exists.
    const isValid = await verifyPassword(input.password, found?.data.passwordHash ?? (await getDummyPasswordHash()));
    if (!found || !isValid) {
      await this.failLogin(input.ip, key);
      throw new AppError(401, "wrong username or password", { code: "bad-credentials" });
    }
    const account = found.data;
    if (account.status === "rejected") throw new AppError(403, "this account was not approved", { code: "rejected" });
    await this.limiter.clear(LOGIN_USER_LIMIT, key);
    const updated = { ...account, lastLoginAt: this.now().toISOString(), lastSeenAt: this.now().toISOString() };
    await this.repos.accounts.saveIfMatch(updated, found.etag); // best effort
    return { account: toAccountView(updated), session: await this.createSession({ role: "player", account }) };
  }

  async logout(token: string | null): Promise<void> {
    if (token && isWellFormedSessionToken(token)) await this.repos.sessions.delete(sha256Hex(token));
  }

  /** Resolves the session cookie. Throws 401 when missing, unknown, expired or revoked. */
  async authenticate(token: string | null): Promise<{ principal: Principal; view: AccountView; renewed: Session | null }> {
    const signedOut = (): AppError => new AppError(401, "session expired, sign in again", { code: "signed-out" });
    if (!token || !isWellFormedSessionToken(token)) throw new AppError(401, "sign in required", { code: "signed-out" });
    const tokenHash = sha256Hex(token);
    const session = await this.repos.sessions.get(tokenHash);
    const nowMs = this.now().getTime();
    if (!session || Date.parse(session.expiresAt) <= nowMs) throw signedOut();

    if (session.role === "admin") {
      const adminKey = this.adminKey();
      if (!adminKey || adminKey.length < MIN_ADMIN_KEY_LENGTH || session.adminKeyFingerprint !== adminKeyFingerprint(adminKey)) {
        await this.repos.sessions.delete(tokenHash);
        throw signedOut();
      }
      return { principal: { kind: "admin" }, view: ADMIN_VIEW(session.createdAt), renewed: null };
    }

    const found = await this.repos.accounts.get(session.accountId);
    if (!found || found.data.sessionEpoch !== session.epoch) {
      await this.repos.sessions.delete(tokenHash);
      throw signedOut();
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
    return { principal: { kind: "player", account }, view: toAccountView(account), renewed };
  }

  /** True when the cookie belongs to a live admin session. Never throws. */
  async isAdminSession(token: string | null): Promise<boolean> {
    try {
      return (await this.authenticate(token)).principal.kind === "admin";
    } catch {
      return false;
    }
  }

  /** authenticate() + must be an approved player account that isn't waiting on a forced password change. */
  async requirePlayer(token: string | null): Promise<AccountRecord> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin account can't play; sign in as a player", { code: "admin" });
    const account = principal.account;
    if (account.status === "pending") throw new AppError(403, "waiting for the instructor to approve your account", { code: "pending" });
    if (account.status === "rejected") throw new AppError(403, "this account was not approved", { code: "rejected" });
    if (account.mustChangePassword) throw new AppError(403, "set a new password first", { code: "password-change-required" });
    return account;
  }

  /**
   * Who may manage case content: the admin session, or an approved author account (not waiting on a forced
   * password change). Case routes then check ownership for authors (`createdBy`).
   */
  async requireAuthor(token: string | null): Promise<Principal> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") return principal;
    const account = principal.account;
    if (account.role !== "author") throw new AppError(403, "only authors and the instructor can manage cases", { code: "not-author" });
    if (account.status !== "approved") throw new AppError(403, "this account is not approved", { code: account.status });
    if (account.mustChangePassword) throw new AppError(403, "set a new password first", { code: "password-change-required" });
    return principal;
  }

  /** A player changes their own password. Other sessions of the account are signed out; this one stays. */
  async changePassword(token: string | null, input: { currentPassword: string; newPassword: string }): Promise<AuthResult> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin password is the ADMIN_KEY", { code: "admin" });
    const found = await this.repos.accounts.get(principal.account.id);
    if (!found) throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
    if (!(await verifyPassword(input.currentPassword, found.data.passwordHash))) {
      throw new AppError(400, "your current password is wrong", { code: "bad-credentials" });
    }
    const account: AccountRecord = {
      ...found.data,
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      sessionEpoch: found.data.sessionEpoch + 1,
    };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    if (token) await this.repos.sessions.delete(sha256Hex(token));
    return { account: toAccountView(account), session: await this.createSession({ role: "player", account }) };
  }

  private async adminLogin(input: CredentialsInput, key: string): Promise<AuthResult> {
    const adminKey = this.adminKey();
    if (!adminKey || adminKey.length < MIN_ADMIN_KEY_LENGTH) throw new AppError(503, "admin disabled");
    // Fixed-length digests so timingSafeEqual never sees different lengths.
    if (!safeEqual(sha256Hex(input.password), sha256Hex(adminKey))) {
      await this.failLogin(input.ip, key);
      throw new AppError(401, "wrong username or password", { code: "bad-credentials" });
    }
    await this.limiter.clear(LOGIN_USER_LIMIT, key);
    const nowIso = this.now().toISOString();
    return { account: ADMIN_VIEW(nowIso), session: await this.createSession({ role: "admin", adminKey }) };
  }

  private async failLogin(ip: string, key: string): Promise<void> {
    await this.limiter.hit(LOGIN_IP_LIMIT, ip);
    await this.limiter.hit(LOGIN_USER_LIMIT, key);
  }

  private async createSession(owner: { role: "player"; account: AccountRecord } | { role: "admin"; adminKey: string }): Promise<Session> {
    const token = generateSessionToken();
    const now = this.now();
    const ttl = owner.role === "admin" ? ADMIN_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS;
    const record: SessionRecord =
      owner.role === "admin"
        ? { role: "admin", adminKeyFingerprint: adminKeyFingerprint(owner.adminKey), accountId: "admin", epoch: 0, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() }
        : { role: "player", accountId: owner.account.id, epoch: owner.account.sessionEpoch, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
    await this.repos.sessions.save(sha256Hex(token), record);
    return { token, maxAgeSeconds: ttl };
  }
}
