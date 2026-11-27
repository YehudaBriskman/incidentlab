// Teacher-vouched password reset (#254), for a player who lost both the password and the recovery code.
//
// Security model: no class admin ever sets, resets or sees a password. Classes are open (anyone can make one and
// get someone to join), so a class admin who could reset a member's password could take the account over.
// Instead three parties take part:
// 1. anyone files a request by username (public, rate-limited, and the answer never says whether the name exists);
// 2. an active admin of an active class the player is an active member of vouches ("I know this student");
// 3. the site owner approves a request with at least one vouch that still holds, and gets a one-time temporary
//    password (AccountAdminService.resetPassword: every session ends and the next sign-in must set a new password,
//    which issues a new recovery code). The temporary password is returned once and never stored or logged.
import { RESET_REQUEST_TTL_DAYS, usernameKey } from "../../shared/contract.ts";
import type { AdminPasswordResetRequest, ClassResetRequest, ResetVouchView } from "../../shared/contract.ts";
import { isLiveRequest, RESET_REQUEST_SCHEMA_VERSION } from "../domain/reset-requests.ts";
import type { ResetRequestRecord, ResetVouch } from "../domain/reset-requests.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { AccountAdminService } from "./AccountAdminService.ts";
import type { ClassActor, ClassService } from "./ClassService.ts";
import { ACCOUNT_ID_PATTERN, sha256Hex } from "./crypto.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Every request counts (not just failures): a class sharing one NAT address can still file a few an hour. */
export const RESET_REQUEST_IP_LIMIT: RateLimitRule = { bucket: "resetreq-ip", max: 20, windowMs: 60 * 60_000, message: "too many reset requests from this address" };
export const RESET_REQUEST_USER_LIMIT: RateLimitRule = { bucket: "resetreq-user", max: 5, windowMs: 60 * 60_000, message: "too many reset requests for this username, wait a bit" };

export type ResetRequestInput = { readonly username: string; readonly website?: string | undefined; readonly ip: string };

const noRequest = (): AppError => new AppError(404, "no open reset request for that player", { code: "no-reset-request" });

export class PasswordResetService {
  private readonly repos: Repositories;
  private readonly classes: Pick<ClassService, "requireClassAdmin">;
  private readonly accounts: Pick<AccountAdminService, "resetPassword">;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;

  constructor(deps: {
    repos: Repositories;
    classes: Pick<ClassService, "requireClassAdmin">;
    accounts: Pick<AccountAdminService, "resetPassword">;
    limiter: RateLimiter;
    now: () => Date;
  }) {
    this.repos = deps.repos;
    this.classes = deps.classes;
    this.accounts = deps.accounts;
    this.limiter = deps.limiter;
    this.now = deps.now;
  }

  /**
   * Opens (or refreshes) a request. Returns the account id when one was written, for the audit, and null otherwise;
   * the controller answers the same 202 either way. Unknown names, guests, rejected accounts, the admin name and a
   * filled honeypot all do nothing.
   */
  async request(input: ResetRequestInput): Promise<string | null> {
    const key = usernameKey(input.username);
    await this.limiter.assertAllowed(RESET_REQUEST_IP_LIMIT, input.ip);
    await this.limiter.assertAllowed(RESET_REQUEST_USER_LIMIT, key);
    await this.limiter.hit(RESET_REQUEST_IP_LIMIT, input.ip);
    await this.limiter.hit(RESET_REQUEST_USER_LIMIT, key);
    if (input.website !== undefined && input.website.length > 0) return null;
    const accountId = await this.repos.usernames.lookup(sha256Hex(key));
    const found = accountId === null ? null : await this.repos.accounts.get(accountId);
    if (!found || found.data.kind !== "user" || found.data.status === "rejected") return null;

    const now = this.now();
    const expiresAt = new Date(now.getTime() + RESET_REQUEST_TTL_DAYS * DAY_MS).toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.repos.resetRequests.get(found.data.id);
      // A live request keeps its vouches and gets a new expiry; anything else (done, rejected, expired) starts over.
      const next: ResetRequestRecord =
        current && isLiveRequest(current.data, now.getTime())
          ? { ...current.data, expiresAt }
          : { schemaVersion: RESET_REQUEST_SCHEMA_VERSION, accountId: found.data.id, status: "open", createdAt: now.toISOString(), expiresAt, vouches: [], decidedAt: null };
      if (await this.repos.resetRequests.saveIfMatch(next, current?.etag ?? null)) return found.data.id;
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  // ---- class admins --------------------------------------------------------------

  /** Open requests of the class's active members (one key listing; reads only the members that have one). */
  async forClass(actor: ClassActor, classId: string): Promise<ClassResetRequest[]> {
    await this.classes.requireClassAdmin(actor, classId);
    const nowMs = this.now().getTime();
    const ids = await this.repos.resetRequests.listAccountIds();
    const rows = await mapWithConcurrency(ids, async (accountId) => {
      const member = await this.repos.classes.getMember(classId, accountId);
      if (member?.data.status !== "active") return null;
      const request = await this.repos.resetRequests.get(accountId);
      if (!request || !isLiveRequest(request.data, nowMs)) return null;
      const account = await this.repos.accounts.get(accountId);
      if (!account) return null;
      return this.toClassView(request.data, account.data.username, actor);
    });
    return rows.filter((r): r is ClassResetRequest => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * A class admin vouches for an active member's open request. 404 when the class, the membership or the request
   * isn't there (an admin of an unrelated class learns nothing), 403 for plain members. Only player accounts vouch:
   * the site owner approves, so their vouch would skip the second person. A vouch changes no credential.
   */
  async vouch(actor: ClassActor, classId: string, accountId: string): Promise<ClassResetRequest> {
    if (actor.kind !== "player") throw new AppError(403, "the site owner approves requests; a class admin vouches", { code: "not-class-admin" });
    const record = await this.classes.requireClassAdmin(actor, classId);
    if (record.status !== "active") throw new AppError(409, "this class is archived", { code: "class-archived" });
    if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId === actor.account.id) throw noRequest();
    const member = await this.repos.classes.getMember(classId, accountId);
    if (member?.data.status !== "active") throw noRequest();
    const account = await this.repos.accounts.get(accountId);
    if (!account) throw noRequest();
    const nowIso = this.now().toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await this.repos.resetRequests.get(accountId);
      if (!found || !isLiveRequest(found.data, Date.parse(nowIso))) throw noRequest();
      const already = found.data.vouches.some((v) => v.classId === classId && v.byAccountId === actor.account.id);
      if (already) return this.toClassView(found.data, account.data.username, actor);
      const vouch: ResetVouch = { classId, byAccountId: actor.account.id, at: nowIso };
      const next: ResetRequestRecord = { ...found.data, vouches: [...found.data.vouches, vouch] };
      if (await this.repos.resetRequests.saveIfMatch(next, found.etag)) return this.toClassView(next, account.data.username, actor);
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  private toClassView(request: ResetRequestRecord, username: string, actor: ClassActor): ClassResetRequest {
    const me = actor.kind === "player" ? actor.account.id : null;
    return { accountId: request.accountId, username, createdAt: request.createdAt, expiresAt: request.expiresAt, vouchedByMe: request.vouches.some((v) => v.byAccountId === me) };
  }

  // ---- site owner ----------------------------------------------------------------

  /** Live requests with at least one vouch that still holds, oldest first. */
  async forOwner(): Promise<AdminPasswordResetRequest[]> {
    const nowMs = this.now().getTime();
    const rows = await mapWithConcurrency(await this.repos.resetRequests.list(), async (request) => {
      if (!isLiveRequest(request, nowMs)) return null;
      const account = await this.repos.accounts.get(request.accountId);
      if (!account) return null;
      const vouches = await this.validVouches(request);
      return vouches.length === 0 ? null : { accountId: request.accountId, username: account.data.username, createdAt: request.createdAt, expiresAt: request.expiresAt, vouches };
    });
    return rows.filter((r): r is AdminPasswordResetRequest => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Approves: claims the request (done) with a conditional write, so two approvals can't both reset, then sets the
   * temporary password. Returns it and the vouchers for the audit. 409 "no-vouch" without a valid vouch.
   */
  async approve(accountId: string): Promise<{ temporaryPassword: string; username: string; vouchedBy: string[] }> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw noRequest();
    const found = await this.repos.resetRequests.get(accountId);
    if (!found || !isLiveRequest(found.data, this.now().getTime())) throw noRequest();
    const vouches = await this.validVouches(found.data);
    if (vouches.length === 0) throw new AppError(409, "no class admin has vouched for this request", { code: "no-vouch" });
    const done: ResetRequestRecord = { ...found.data, status: "done", decidedAt: this.now().toISOString() };
    if (!(await this.repos.resetRequests.saveIfMatch(done, found.etag))) throw new AppError(409, "concurrent update, please retry");
    let temporaryPassword: string;
    try {
      temporaryPassword = await this.accounts.resetPassword(accountId);
    } catch (error: unknown) {
      const now = await this.repos.resetRequests.get(accountId);
      if (now) await this.repos.resetRequests.saveIfMatch(found.data, now.etag); // best effort: reopen it
      throw error;
    }
    const username = (await this.repos.accounts.get(accountId))?.data.username ?? accountId;
    return { temporaryPassword, username, vouchedBy: [...new Set(vouches.map((v) => v.byUsername))] };
  }

  async reject(accountId: string): Promise<void> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw noRequest();
    const found = await this.repos.resetRequests.get(accountId);
    if (!found || found.data.status !== "open") throw noRequest();
    const rejected: ResetRequestRecord = { ...found.data, status: "rejected", decidedAt: this.now().toISOString() };
    if (!(await this.repos.resetRequests.saveIfMatch(rejected, found.etag))) throw new AppError(409, "concurrent update, please retry");
  }

  /**
   * The vouches that still count: the class is active, the voucher is still one of its active admins, and the
   * player still an active member. A teacher who was demoted or left, or a student removed, no longer vouches.
   */
  private async validVouches(request: ResetRequestRecord): Promise<ResetVouchView[]> {
    const rows = await mapWithConcurrency(request.vouches, async (v): Promise<ResetVouchView | null> => {
      const [klass, voucher, member, voucherAccount] = await Promise.all([
        this.repos.classes.get(v.classId),
        this.repos.classes.getMember(v.classId, v.byAccountId),
        this.repos.classes.getMember(v.classId, request.accountId),
        this.repos.accounts.get(v.byAccountId),
      ]);
      if (klass?.data.status !== "active" || !voucherAccount || !isUsableVoucher(voucherAccount.data)) return null;
      if (voucher?.data.status !== "active" || voucher.data.role !== "admin" || member?.data.status !== "active") return null;
      return { classId: v.classId, className: klass.data.name, byAccountId: v.byAccountId, byUsername: voucherAccount.data.username, at: v.at, memberSince: member.data.joinedAt };
    });
    return rows.filter((r): r is ResetVouchView => r !== null);
  }
}

/** A voucher whose own account is banned or mid forced reset doesn't count. */
const isUsableVoucher = (account: AccountRecord): boolean => account.kind === "user" && account.status === "approved" && !account.mustChangePassword;
