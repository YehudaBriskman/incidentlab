// Accounts, passwords and sessions. Sessions live server-side; the browser only holds an opaque
// token in an HttpOnly cookie, and the store keeps sha256(token), never the token itself.
// Signing in as `admin` with the ADMIN_KEY creates an admin session (no account record behind it).
import { ADMIN_USERNAME, MIN_SIGNUP_FORM_MS, normalizeRecoveryCode, RESERVED_USERNAMES, usernameKey } from "../../shared/contract.ts";
import type { AccountView, ClassSummary } from "../../shared/contract.ts";
import { ACCOUNT_SCHEMA_VERSION, AppError } from "../domain/types.ts";
import type { AccountRecord, SessionRecord } from "../domain/types.ts";
import type { SettingsRepository } from "../repositories/config-repositories.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { ClassService } from "./ClassService.ts";
import {
  generateAccountId,
  generateRecoveryCode,
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

// Sign-up is open (#173), so the IP limit is tighter than in the classroom days. A class sharing one NAT IP
// can still sign up 20 an hour; more than that is a script.
export const REGISTER_LIMIT: RateLimitRule = { bucket: "register-ip", max: 20, windowMs: 60 * 60_000, message: "too many sign-ups from this address" };
const LOGIN_IP_LIMIT: RateLimitRule = { bucket: "login-ip", max: 60, windowMs: 15 * 60_000, message: "too many failed logins from this address" };
export const LOGIN_USER_LIMIT: RateLimitRule = { bucket: "login-user", max: 8, windowMs: 15 * 60_000, message: "too many failed logins for this username, wait a bit" };
// Recovery (#174) is limited like login, in its own buckets so failed recoveries and failed logins don't add up.
const RECOVER_IP_LIMIT: RateLimitRule = { bucket: "recover-ip", max: 60, windowMs: 15 * 60_000, message: "too many failed recoveries from this address" };
export const RECOVER_USER_LIMIT: RateLimitRule = { bucket: "recover-user", max: 8, windowMs: 15 * 60_000, message: "too many failed recoveries for this username, wait a bit" };

export type Session = { readonly token: string; readonly maxAgeSeconds: number };
export type AuthResult = { readonly account: AccountView; readonly session: Session };
/** Register and login: `recoveryCode` is the plain code when this call issued one (it is never stored). */
export type SignInResult = AuthResult & { readonly recoveryCode: string | null };
/** Register: `joinedClass` is the class the sign-up's class code joined (or asked to join), if any (#204). */
export type RegisterResult = SignInResult & { readonly joinedClass: ClassSummary | null };
/** What sign-up needs from classes: check a code before the account exists, then join with it. */
export type SignupClasses = Pick<ClassService, "checkSignupCode" | "countWrongSignupCode" | "join">;
export type CredentialsInput = { readonly username: string; readonly password: string; readonly ip: string };
export type RegisterInput = CredentialsInput & {
  readonly inviteCode?: string | undefined;
  /** the hidden honeypot field: people leave it empty */
  readonly website?: string | undefined;
  /** how long the form was open before submit */
  readonly elapsedMs?: number | undefined;
};
export type RecoverInput = { readonly username: string; readonly recoveryCode: string; readonly newPassword: string; readonly ip: string };

/** Who is behind a session cookie. */
export type Principal = { readonly kind: "player"; readonly account: AccountRecord } | { readonly kind: "admin" };

export const ADMIN_VIEW = (createdAt: string): AccountView => ({
  id: "admin",
  username: ADMIN_USERNAME,
  status: "approved",
  createdAt,
  role: "admin",
  mustChangePassword: false,
  kind: "user",
  showOnGlobalBoard: false,
  banReason: null,
});

export const toAccountView = (account: AccountRecord): AccountView => ({
  id: account.id,
  username: account.username,
  status: account.status,
  createdAt: account.createdAt,
  role: account.role,
  mustChangePassword: account.mustChangePassword,
  kind: account.kind,
  showOnGlobalBoard: account.showOnGlobalBoard,
  // Only the banned player sees the reason (#236); every other view carries null.
  banReason: account.status === "rejected" ? account.banReason : null,
});

/** Recovery codes are stored like passwords (scrypt), over their normalized form. */
const hashRecoveryCode = (code: string): Promise<string> => hashPassword(normalizeRecoveryCode(code));

/**
 * A new recovery code (#174): `code` goes to the player once, `hash` into `AccountRecord.recoveryCodeHash`.
 * Every flow that gives an account a code uses this (sign-up, first sign-in, recovery, regeneration, and a guest
 * upgrading to an account), so they all store the same normalized scrypt hash.
 */
export const issueRecoveryCode = async (): Promise<{ code: string; hash: string }> => {
  const code = generateRecoveryCode();
  return { code, hash: await hashRecoveryCode(code) };
};

/**
 * A session waiting on a forced password change (#254, an owner reset) may only change the password, read
 * GET /api/me and /api/session, and sign out. Every other signed-in route answers this 403.
 */
export const passwordChangeRequired = (): AppError => new AppError(403, "set a new password first", { code: "password-change-required" });

/** The 403 a banned account gets once it proved who it is (#236): with the owner's reason, when there is one. */
const bannedError = (account: AccountRecord): AppError =>
  new AppError(403, "this account was not approved", { code: "rejected", ...(account.banReason === null ? {} : { banReason: account.banReason }) });

export const adminKeyFingerprint = (adminKey: string): string => sha256Hex(adminKey).slice(0, 16);

export class AuthService {
  private readonly repos: Repositories;
  private readonly settings: SettingsRepository;
  private readonly limiter: RateLimiter;
  private readonly adminKey: () => string | undefined;
  private readonly now: () => Date;
  private readonly classes: SignupClasses | null;

  constructor(deps: {
    repos: Repositories;
    settings: SettingsRepository;
    limiter: RateLimiter;
    adminKey: () => string | undefined;
    now: () => Date;
    /** class codes at sign-up (#204); without it only the legacy site invite code is accepted */
    classes?: SignupClasses | undefined;
  }) {
    this.classes = deps.classes ?? null;
    this.repos = deps.repos;
    this.settings = deps.settings;
    this.limiter = deps.limiter;
    this.adminKey = deps.adminKey;
    this.now = deps.now;
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    await this.limiter.assertAllowed(REGISTER_LIMIT, input.ip);
    // Bot checks (#173): a filled honeypot or a form sent faster than a person types. The answer is deliberately
    // generic, and still counts against the IP limit, so a script learns nothing and can't retry for free.
    const filledHoneypot = input.website !== undefined && input.website.length > 0;
    const tooFast = input.elapsedMs !== undefined && input.elapsedMs < MIN_SIGNUP_FORM_MS;
    if (filledHoneypot || tooFast) {
      await this.limiter.hit(REGISTER_LIMIT, input.ip);
      throw new AppError(400, "couldn't create the account, please try again", { code: "signup-refused" });
    }
    const key = usernameKey(input.username);
    if (RESERVED_USERNAMES.includes(key)) throw new AppError(409, "that username is reserved", { code: "reserved" });
    const hashedKey = sha256Hex(key);
    if (await this.repos.usernames.lookup(hashedKey)) throw new AppError(409, "that username is taken", { code: "username-taken" });

    // An optional code (#204) is a class join code; the old site-wide invite code (config:settings.inviteCode,
    // replaced by classes) still passes while it is set. Both are checked before anything is written, so a wrong
    // code creates no account. The code never decides site approval: sign-up is open.
    const typedCode = input.inviteCode?.trim() ?? "";
    const opensClass = typedCode.length > 0 && this.classes !== null && (await this.classes.checkSignupCode(typedCode, input.ip));
    if (typedCode.length > 0 && !opensClass) {
      const { inviteCode } = await this.settings.get();
      if (inviteCode === null || !safeEqual(typedCode.toLowerCase(), inviteCode.toLowerCase())) {
        await this.classes?.countWrongSignupCode(input.ip);
        throw new AppError(400, "no class has that code", { code: "bad-class-code" });
      }
    }

    const nowIso = this.now().toISOString();
    const recovery = await issueRecoveryCode();
    const account: AccountRecord = {
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
      id: generateAccountId(),
      username: input.username.trim(),
      usernameKey: key,
      passwordHash: await hashPassword(input.password),
      status: "approved",
      sessionEpoch: 0,
      createdAt: nowIso,
      decidedAt: nowIso,
      lastSeenAt: nowIso,
      lastLoginAt: nowIso,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      role: "player",
      kind: "user",
      showOnGlobalBoard: false,
      recoveryCodeHash: recovery.hash,
      classLimit: null,
      hiddenFromBoards: false,
      banReason: null,
    };
    // Claim the name first: the conditional write makes uniqueness race-free.
    if (!(await this.repos.usernames.claim(hashedKey, account.id))) throw new AppError(409, "that username is taken", { code: "username-taken" });
    if (!(await this.repos.accounts.saveIfMatch(account, null))) {
      await this.repos.usernames.release(hashedKey);
      throw new AppError(409, "id collision, retry");
    }
    await this.limiter.hit(REGISTER_LIMIT, input.ip);
    const session = await this.createSession({ role: "player", account });
    const joinedClass = opensClass ? await this.joinAfterSignup(account, typedCode, input.ip) : null;
    return { account: toAccountView(account), session, recoveryCode: recovery.code, joinedClass };
  }

  /**
   * Joins (or asks to join, by the class's approval mode) the class the sign-up code opened. The account exists by
   * now, so a join that fails anyway (the class filled up or was archived meanwhile) doesn't fail the sign-up: the
   * player keeps the account and can join from the class page later.
   */
  private async joinAfterSignup(account: AccountRecord, code: string, ip: string): Promise<ClassSummary | null> {
    if (this.classes === null) return null;
    try {
      return await this.classes.join({ kind: "player", account }, code, ip);
    } catch (err: unknown) {
      if (err instanceof AppError) return null;
      throw err;
    }
  }

  async login(input: CredentialsInput): Promise<SignInResult> {
    const key = usernameKey(input.username);
    await this.limiter.assertAllowed(LOGIN_IP_LIMIT, input.ip);
    await this.limiter.assertAllowed(LOGIN_USER_LIMIT, key);
    if (key === ADMIN_USERNAME) return { ...(await this.adminLogin(input, key)), recoveryCode: null };

    const accountId = await this.repos.usernames.lookup(sha256Hex(key));
    const found = accountId ? await this.repos.accounts.get(accountId) : null;
    // Always run scrypt so response time doesn't reveal whether the username exists.
    const isValid = await verifyPassword(input.password, found?.data.passwordHash ?? (await getDummyPasswordHash()));
    if (!found || !isValid || found.data.kind === "guest") { // guests have no password (#176)
      await this.failLogin(input.ip, key);
      throw new AppError(401, "wrong username or password", { code: "bad-credentials" });
    }
    const account = found.data;
    // The password was right, so the player may read the owner's ban reason (#236).
    if (account.status === "rejected") throw bannedError(account);
    // An unused temporary password stops working after 48 hours (#254): ask for a new reset.
    const expiresAt = account.mustChangePassword ? account.temporaryPasswordExpiresAt : null;
    if (expiresAt !== null && Date.parse(expiresAt) <= this.now().getTime()) {
      throw new AppError(401, "this temporary password has expired; ask for a new reset", { code: "temporary-password-expired" });
    }
    await this.limiter.clear(LOGIN_USER_LIMIT, key);
    // Accounts from before #174 get their first recovery code here, shown once by the client.
    const recovery = account.recoveryCodeHash === null ? await issueRecoveryCode() : null;
    const updated: AccountRecord = {
      ...account,
      lastLoginAt: this.now().toISOString(),
      lastSeenAt: this.now().toISOString(),
      ...(recovery === null ? {} : { recoveryCodeHash: recovery.hash }),
    };
    const saved = await this.repos.accounts.saveIfMatch(updated, found.etag); // best effort
    return {
      account: toAccountView(updated),
      session: await this.createSession({ role: "player", account }),
      // A code that wasn't saved would not work: say nothing, and the next sign-in issues one.
      recoveryCode: saved && recovery !== null ? recovery.code : null,
    };
  }

  /**
   * Forgotten password (#174): the recovery code sets a new one. Every session of the account ends, a forced
   * password change is cleared, and the spent code is replaced by a new one, returned once. No session is made:
   * the player signs in with the new password. Failures look and take the same whether or not the name exists.
   */
  async recover(input: RecoverInput): Promise<{ recoveryCode: string }> {
    const key = usernameKey(input.username);
    await this.limiter.assertAllowed(RECOVER_IP_LIMIT, input.ip);
    await this.limiter.assertAllowed(RECOVER_USER_LIMIT, key);
    const accountId = key === ADMIN_USERNAME ? null : await this.repos.usernames.lookup(sha256Hex(key));
    const found = accountId ? await this.repos.accounts.get(accountId) : null;
    const stored = found?.data.recoveryCodeHash ?? null;
    // Always run scrypt, like login: an unknown name or an account without a code costs the same time.
    const isValid = await verifyPassword(normalizeRecoveryCode(input.recoveryCode), stored ?? (await getDummyPasswordHash()));
    if (!found || stored === null || !isValid) {
      await this.limiter.hit(RECOVER_IP_LIMIT, input.ip);
      await this.limiter.hit(RECOVER_USER_LIMIT, key);
      throw new AppError(401, "wrong username or recovery code", { code: "bad-recovery-code" });
    }
    if (found.data.status === "rejected") throw bannedError(found.data);
    const recovery = await issueRecoveryCode();
    const account: AccountRecord = {
      ...found.data,
      passwordHash: await hashPassword(input.newPassword),
      recoveryCodeHash: recovery.hash,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      sessionEpoch: found.data.sessionEpoch + 1,
    };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    await this.limiter.clear(RECOVER_USER_LIMIT, key);
    await this.limiter.clear(LOGIN_USER_LIMIT, key); // the owner is back: lift a lockout their guesses caused
    return { recoveryCode: recovery.code };
  }

  /** A signed-in player replaces their recovery code (the old one stops working). Needs the current password. */
  async regenerateRecoveryCode(token: string | null, input: { currentPassword: string }): Promise<{ recoveryCode: string }> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin account has no recovery code", { code: "admin" });
    const found = await this.repos.accounts.get(principal.account.id);
    if (!found) throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
    // A forced change comes first (#254): it issues the new code itself.
    if (found.data.mustChangePassword) throw passwordChangeRequired();
    // Password guesses from a stolen session count against the same per-username budget as sign-in.
    await this.limiter.assertAllowed(LOGIN_USER_LIMIT, found.data.usernameKey);
    if (!(await verifyPassword(input.currentPassword, found.data.passwordHash))) {
      await this.limiter.hit(LOGIN_USER_LIMIT, found.data.usernameKey);
      throw new AppError(400, "your current password is wrong", { code: "bad-credentials" });
    }
    const recovery = await issueRecoveryCode();
    const account: AccountRecord = { ...found.data, recoveryCodeHash: recovery.hash };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    return { recoveryCode: recovery.code };
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
    const principal = await this.requirePlayerOrAdmin(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin account can't play; sign in as a player", { code: "admin" });
    return principal.account;
  }

  /** The admin session, or a player that passes requirePlayer's checks (class routes accept both, #179). */
  async requirePlayerOrAdmin(token: string | null): Promise<Principal> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") return principal;
    const account = principal.account;
    if (account.status === "pending") throw new AppError(403, "this account is waiting for approval", { code: "pending" });
    if (account.status === "rejected") throw new AppError(403, "this account was not approved", { code: "rejected" });
    if (account.mustChangePassword) throw passwordChangeRequired();
    return principal;
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
    if (account.mustChangePassword) throw passwordChangeRequired();
    return principal;
  }

  /**
   * A player changes their own password. Other sessions of the account are signed out; this one stays. After an
   * owner reset (`mustChangePassword`, #254) the player has lost their recovery code too, so the change also issues
   * a new one, returned once like at sign-up.
   */
  async changePassword(token: string | null, input: { currentPassword: string; newPassword: string }): Promise<SignInResult> {
    const { principal } = await this.authenticate(token);
    if (principal.kind === "admin") throw new AppError(403, "the admin password is the ADMIN_KEY", { code: "admin" });
    const found = await this.repos.accounts.get(principal.account.id);
    if (!found) throw new AppError(401, "session expired, sign in again", { code: "signed-out" });
    if (!(await verifyPassword(input.currentPassword, found.data.passwordHash))) {
      throw new AppError(400, "your current password is wrong", { code: "bad-credentials" });
    }
    const recovery = found.data.mustChangePassword ? await issueRecoveryCode() : null;
    const account: AccountRecord = {
      ...found.data,
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      sessionEpoch: found.data.sessionEpoch + 1,
      ...(recovery === null ? {} : { recoveryCodeHash: recovery.hash }),
    };
    if (!(await this.repos.accounts.saveIfMatch(account, found.etag))) throw new AppError(409, "concurrent update, please retry");
    if (token) await this.repos.sessions.delete(sha256Hex(token));
    return { account: toAccountView(account), session: await this.createSession({ role: "player", account }), recoveryCode: recovery?.code ?? null };
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
