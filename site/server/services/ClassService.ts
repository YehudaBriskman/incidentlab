// Classes (#179): create, edit, archive, join by code or request, members, co-admins, leave.
//
// Permissions (docs/API.md, "Classes"): non-members get 404 on every class route, so a class id reveals nothing.
// The site admin (ADMIN_KEY) passes every check without being a member. Class admins never see more of an
// account than its username, and can never reset a password: that would let them take over accounts.
//
// Caps without transactions: a join (or a create) writes its record first, then counts. Whoever sees the count
// over the limit after its own write removes its own record again. The last writer always sees every kept record,
// so the cap can't be exceeded; at worst two racing joiners both back off and one retries.
import { randomBytes, randomInt } from "node:crypto";
import { CLASS_CODE_GROUPS, CLASS_DEFAULTS, normalizeClassCode, RECOVERY_CODE_ALPHABET, RECOVERY_CODE_GROUP_LENGTH } from "../../shared/contract.ts";
import type { AuditEntry, ClassDetail, ClassMember, ClassMembership, ClassRole, ClassSchedule, ClassSummary, UpdateClassRequest } from "../../shared/contract.ts";
import { CLASS_SCHEMA_VERSION, DEFAULT_CLASS_EVENT, DEFAULT_CLASS_SCHEDULE, reverseOf, sameReverse, SITE_OWNER_ID } from "../domain/classes.ts";
import type { ClassMemberRecord, ClassRecord } from "../domain/classes.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { ClassRepository } from "../repositories/class-repository.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { ACCOUNT_ID_PATTERN, generateAccountId, sha256Hex } from "./crypto.ts";
import { assertEventWindow } from "./EventService.ts";
import { classBoardTag, noopCachePurger } from "./CachePurger.ts";
import type { CachePurger } from "./CachePurger.ts";
import type { RateLimitRule, RateLimiter } from "./RateLimiter.ts";
import { isValidTimeZone, localDate } from "./ScheduleService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WRITE_RETRIES = 3;
const CLASS_ID_PATTERN = ACCOUNT_ID_PATTERN; // the same 12 base62 characters

export const CLASS_CREATE_LIMIT: RateLimitRule = { bucket: "class-create", max: 10, windowMs: DAY_MS, message: "too many classes created today, try again tomorrow" };
// Only failed joins count (an unknown code): a whole class behind one NAT joining with the right code is never
// slowed down, while guessing a 10-character code at 30 tries an hour per address is hopeless.
export const CLASS_JOIN_IP_LIMIT: RateLimitRule = { bucket: "class-join-ip", max: 30, windowMs: 60 * 60_000, message: "too many wrong class codes from this address" };
export const CLASS_JOIN_ACCOUNT_LIMIT: RateLimitRule = { bucket: "class-join-account", max: 10, windowMs: 60 * 60_000, message: "too many wrong class codes, wait a bit" };

/** Who is calling a class route: the site admin (ADMIN_KEY) or an approved player. */
export type ClassActor = { readonly kind: "site-admin"; readonly via: AuditEntry["via"] } | { readonly kind: "player"; readonly account: AccountRecord };

type Access = {
  readonly found: Versioned<ClassRecord>;
  /** null for the site admin */
  readonly member: ClassMemberRecord | null;
  readonly isAdmin: boolean;
  readonly isOwner: boolean;
};

export const generateJoinCode = (): string =>
  Array.from({ length: CLASS_CODE_GROUPS }, () =>
    Array.from({ length: RECOVERY_CODE_GROUP_LENGTH }, () => RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)]).join(""),
  ).join("-");
export const joinCodeHash = (code: string): string => sha256Hex(normalizeClassCode(code));
/** `<classId>.<192 random bits>`: the board route (#181) reads the class from the token and compares the rest. */
export const generateBoardToken = (classId: string): string => `${classId}.${randomBytes(24).toString("base64url")}`;

const membershipOf = (member: ClassMemberRecord | null): ClassMembership | null =>
  member === null ? null : { role: member.role, status: member.status, isOwner: member.isOwner };

export const toClassSummary = (record: ClassRecord, member: ClassMemberRecord | null): ClassSummary => ({
  id: record.id,
  name: record.name,
  status: record.status,
  membership: membershipOf(member),
});

const notFound = (): AppError => new AppError(404, "class not found");
const guestRefused = (): AppError => new AppError(403, "guests can't use classes; create an account first", { code: "guest" });

export class ClassService {
  private readonly classes: ClassRepository;
  private readonly repos: Repositories;
  private readonly limiter: RateLimiter;
  private readonly releasedCaseIds: () => readonly string[];
  private readonly now: () => Date;
  private readonly purger: CachePurger;

  constructor(deps: { repos: Repositories; limiter: RateLimiter; releasedCaseIds: () => readonly string[]; now: () => Date; purger?: CachePurger | undefined }) {
    this.repos = deps.repos;
    this.classes = deps.repos.classes;
    this.limiter = deps.limiter;
    this.releasedCaseIds = deps.releasedCaseIds;
    this.now = deps.now;
    this.purger = deps.purger ?? noopCachePurger;
  }

  // ---- create and list ------------------------------------------------------

  async create(actor: ClassActor, name: string): Promise<ClassDetail> {
    if (actor.kind === "player" && actor.account.kind === "guest") throw guestRefused();
    const ownerId = actor.kind === "player" ? actor.account.id : SITE_OWNER_ID;
    const limit = actor.kind === "player" ? (actor.account.classLimit ?? CLASS_DEFAULTS.OWNED_LIMIT) : Number.POSITIVE_INFINITY;
    if (actor.kind === "player") {
      await this.limiter.assertAllowed(CLASS_CREATE_LIMIT, actor.account.id);
      if ((await this.ownedActive(ownerId)) >= limit) throw this.classLimitError(limit);
    }

    const nowIso = this.now().toISOString();
    const id = generateAccountId();
    const joinCode = await this.claimNewCode(id);
    const record: ClassRecord = {
      schemaVersion: CLASS_SCHEMA_VERSION,
      id,
      name,
      ownerId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: "active",
      joinMode: "code",
      memberLimit: CLASS_DEFAULTS.MEMBER_LIMIT,
      boardToken: generateBoardToken(id),
      joinCode,
      schedule: { ...DEFAULT_CLASS_SCHEDULE, days: {} },
      event: { ...DEFAULT_CLASS_EVENT },
      caseIds: [],
    };
    if (!(await this.classes.saveIfMatch(record, null))) {
      await this.classes.releaseCode(joinCodeHash(joinCode));
      throw new AppError(409, "id collision, retry");
    }
    if (actor.kind === "player") {
      const owner: ClassMemberRecord = { role: "admin", status: "active", isOwner: true, joinedAt: nowIso, decidedAt: nowIso };
      await this.classes.saveMemberIfMatch(id, ownerId, owner, null);
      await this.classes.saveMemberOf(ownerId, id, reverseOf(owner));
      // Write, then count: two creates racing past the check above can't both stay.
      if ((await this.ownedActive(ownerId)) > limit) {
        await this.classes.deleteMember(id, ownerId);
        await this.classes.deleteMemberOf(ownerId, id);
        await this.classes.deleteUnused(id);
        await this.classes.releaseCode(joinCodeHash(joinCode));
        throw this.classLimitError(limit);
      }
      await this.limiter.hit(CLASS_CREATE_LIMIT, actor.account.id);
      return this.toDetail(record, owner, true);
    }
    return this.toDetail(record, null, true);
  }

  /** My classes, from the reverse index. Repairs it on the way: stale rows go, rows that differ are rewritten. */
  async mine(actor: ClassActor): Promise<ClassSummary[]> {
    if (actor.kind === "site-admin") return [];
    const accountId = actor.account.id;
    const rows = await mapWithConcurrency(await this.classes.listMemberOf(accountId), async ({ classId, entry }) => {
      const [found, member] = await Promise.all([this.classes.get(classId), this.classes.getMember(classId, accountId)]);
      if (!found || !member) {
        await this.classes.deleteMemberOf(accountId, classId);
        return null;
      }
      if (entry === null || !sameReverse(entry, reverseOf(member.data))) await this.classes.saveMemberOf(accountId, classId, reverseOf(member.data));
      return toClassSummary(found.data, member.data);
    });
    return rows.filter((r): r is ClassSummary => r !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async detail(actor: ClassActor, classId: string): Promise<ClassDetail> {
    const access = await this.access(actor, classId);
    return this.toDetail(access.found.data, access.member, access.isAdmin);
  }

  /** The class record, for class admins and the site admin only (404 for non-members, 403 for plain members). */
  async requireClassAdmin(actor: ClassActor, classId: string): Promise<ClassRecord> {
    const access = await this.access(actor, classId);
    if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    return access.found.data;
  }

  // ---- settings (class admins) ---------------------------------------------

  async update(actor: ClassActor, classId: string, patch: UpdateClassRequest): Promise<ClassDetail> {
    const schedule = patch.schedule === undefined ? undefined : this.cleanSchedule(patch.schedule);
    if (patch.event !== undefined) assertEventWindow(patch.event);
    if (patch.caseIds !== undefined) this.assertReleased(patch.caseIds);
    const caseIds = patch.caseIds === undefined ? undefined : [...new Set(patch.caseIds)];
    return this.mutate(actor, classId, "admin", (record) => ({
      ...record,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.joinMode === undefined ? {} : { joinMode: patch.joinMode }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(patch.event === undefined ? {} : { event: patch.event }),
      ...(caseIds === undefined ? {} : { caseIds }),
    }));
  }

  /** Archiving is the soft delete: every record stays, joins and edits stop, and the owner can restore it any time. */
  archive(actor: ClassActor, classId: string): Promise<ClassDetail> {
    return this.mutate(actor, classId, "owner", (record) => ({ ...record, status: "archived" }), { allowArchived: true });
  }

  async restore(actor: ClassActor, classId: string): Promise<ClassDetail> {
    const access = await this.access(actor, classId);
    if (!access.isOwner) throw new AppError(403, "only the class owner can restore it", { code: "not-class-owner" });
    const record = access.found.data;
    if (record.status === "active") return this.toDetail(record, access.member, true);
    // A restored class counts toward its owner's limit again; the site admin may go past it.
    if (actor.kind === "player") {
      const limit = actor.account.classLimit ?? CLASS_DEFAULTS.OWNED_LIMIT;
      if ((await this.ownedActive(record.ownerId)) >= limit) throw this.classLimitError(limit);
    }
    return this.mutate(actor, classId, "owner", (r) => ({ ...r, status: "active" }), { allowArchived: true });
  }

  /** A new join code: the new index entry first, then the class, then the old entry goes (it stops working at once). */
  async rotateJoinCode(actor: ClassActor, classId: string): Promise<ClassDetail> {
    const before = await this.access(actor, classId);
    if (!before.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    const joinCode = await this.claimNewCode(classId);
    let oldCode = before.found.data.joinCode;
    try {
      const detail = await this.mutate(actor, classId, "admin", (record) => {
        oldCode = record.joinCode;
        return { ...record, joinCode };
      });
      await this.classes.releaseCode(joinCodeHash(oldCode));
      return detail;
    } catch (error) {
      await this.classes.releaseCode(joinCodeHash(joinCode));
      throw error;
    }
  }

  rotateBoardToken(actor: ClassActor, classId: string): Promise<ClassDetail> {
    return this.mutate(actor, classId, "admin", (record) => ({ ...record, boardToken: generateBoardToken(record.id) }));
  }

  // ---- joining and leaving ----------------------------------------------------

  async join(actor: ClassActor, code: string, ip: string): Promise<ClassSummary> {
    if (actor.kind === "site-admin") throw new AppError(403, "the admin passes every class check and doesn't join classes", { code: "admin" });
    const account = actor.account;
    if (account.kind === "guest") throw guestRefused();
    await this.limiter.assertAllowed(CLASS_JOIN_IP_LIMIT, ip);
    await this.limiter.assertAllowed(CLASS_JOIN_ACCOUNT_LIMIT, account.id);

    const found = await this.findByCode(code);
    if (!found) {
      await this.limiter.hit(CLASS_JOIN_IP_LIMIT, ip);
      await this.limiter.hit(CLASS_JOIN_ACCOUNT_LIMIT, account.id);
      throw new AppError(404, "no class has that code");
    }
    const record = found.data;
    const existing = await this.classes.getMember(record.id, account.id);
    if (existing) {
      await this.repairReverse(account.id, record.id, existing.data); // idempotent: a retried join repairs the index
      return toClassSummary(record, existing.data);
    }
    if ((await this.classes.countMembers(record.id)) >= record.memberLimit) throw this.fullError();

    const nowIso = this.now().toISOString();
    const isOpen = record.joinMode === "code";
    const member: ClassMemberRecord = { role: "member", status: isOpen ? "active" : "pending", isOwner: false, joinedAt: nowIso, decidedAt: isOpen ? nowIso : null };
    if (!(await this.classes.saveMemberIfMatch(record.id, account.id, member, null))) {
      // The same account joined in a parallel request: answer like the retry it is.
      const now = await this.classes.getMember(record.id, account.id);
      if (now) return toClassSummary(record, now.data);
      throw new AppError(409, "concurrent update, please retry");
    }
    // Write, then count (see the top of this file): whoever finds the class over its limit backs out.
    if ((await this.classes.countMembers(record.id)) > record.memberLimit) {
      await this.classes.deleteMember(record.id, account.id);
      throw this.fullError();
    }
    await this.classes.saveMemberOf(account.id, record.id, reverseOf(member));
    if (member.status === "active") await this.purgeBoard(record.id); // a new active member may bring solves
    return toClassSummary(record, member);
  }

  async leave(actor: ClassActor, classId: string): Promise<void> {
    const access = await this.access(actor, classId);
    if (actor.kind === "site-admin" || access.member === null) throw new AppError(403, "the admin isn't a member of any class", { code: "admin" });
    if (access.member.isOwner) throw new AppError(409, "the owner can't leave the class; archive it instead", { code: "owner-locked" });
    await this.removeMembership(classId, actor.account.id);
  }

  // ---- members (class admins) --------------------------------------------------

  async members(actor: ClassActor, classId: string): Promise<ClassMember[]> {
    const access = await this.access(actor, classId);
    if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    const rows = await this.classes.listMembers(classId);
    const views = await mapWithConcurrency(rows, async ({ accountId, member }) => {
      const account = await this.repos.accounts.get(accountId);
      return account ? this.toMember(accountId, account.data.username, member) : null;
    });
    return views
      .filter((m): m is ClassMember => m !== null)
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.status.localeCompare(b.status) || a.username.localeCompare(b.username));
  }

  async approve(actor: ClassActor, classId: string, accountId: string): Promise<ClassMember> {
    const access = await this.access(actor, classId);
    if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    this.assertActive(access.found.data);
    const member = await this.changeMember(classId, accountId, (m) =>
      m.status === "active" ? m : { ...m, status: "active", decidedAt: this.now().toISOString() },
    );
    await this.purgeBoard(classId);
    return member;
  }

  /**
   * Owner and site admin: anyone but the owner. Co-admins: plain members (active or pending) only. A removed
   * account can join again with the code; rotate the code to stop that.
   */
  async remove(actor: ClassActor, classId: string, accountId: string): Promise<void> {
    const access = await this.access(actor, classId);
    if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    const target = await this.targetMember(classId, accountId);
    if (target.isOwner) throw new AppError(409, "the owner can't be removed", { code: "owner-locked" });
    if (target.role === "admin" && !access.isOwner) throw new AppError(403, "only the owner can remove an admin", { code: "not-class-owner" });
    await this.removeMembership(classId, accountId);
  }

  /** Only the owner (or the site admin) promotes and demotes, and only active members; the owner stays an admin. */
  async setRole(actor: ClassActor, classId: string, accountId: string, role: ClassRole): Promise<ClassMember> {
    const access = await this.access(actor, classId);
    if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
    if (!access.isOwner) throw new AppError(403, "only the owner can change roles", { code: "not-class-owner" });
    this.assertActive(access.found.data);
    return this.changeMember(classId, accountId, (member) => {
      if (member.isOwner) throw new AppError(409, "the owner can't be demoted", { code: "owner-locked" });
      if (member.status !== "active") throw new AppError(409, "approve the member first", { code: "pending-member" });
      return member.role === role ? member : { ...member, role };
    });
  }

  // ---- site admin ------------------------------------------------------------

  async adminList(): Promise<Array<{ record: ClassRecord; members: number }>> {
    const records = await this.classes.list();
    const rows = await mapWithConcurrency(records, async (record) => ({ record, members: await this.classes.countMembers(record.id) }));
    return rows.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
  }

  setMemberLimit(actor: ClassActor, classId: string, memberLimit: number): Promise<ClassDetail> {
    return this.mutate(actor, classId, "owner", (record) => ({ ...record, memberLimit }), { allowArchived: true });
  }

  // ---- internals -----------------------------------------------------------------

  /** The class and the caller's place in it. 404 when the class doesn't exist or the caller isn't in it. */
  private async access(actor: ClassActor, classId: string): Promise<Access> {
    if (!CLASS_ID_PATTERN.test(classId)) throw notFound();
    const found = await this.classes.get(classId);
    if (!found) throw notFound();
    if (actor.kind === "site-admin") return { found, member: null, isAdmin: true, isOwner: true };
    if (actor.account.kind === "guest") throw notFound();
    const member = await this.classes.getMember(classId, actor.account.id);
    if (!member) throw notFound();
    await this.repairReverse(actor.account.id, classId, member.data);
    const isActiveAdmin = member.data.status === "active" && member.data.role === "admin";
    return { found, member: member.data, isAdmin: isActiveAdmin, isOwner: isActiveAdmin && member.data.isOwner };
  }

  /** Read, change and conditionally write the class record, retrying when another write got there first. */
  private async mutate(
    actor: ClassActor,
    classId: string,
    level: "admin" | "owner",
    change: (record: ClassRecord) => ClassRecord,
    options: { allowArchived?: boolean } = {},
  ): Promise<ClassDetail> {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const access = await this.access(actor, classId);
      if (level === "owner" && !access.isOwner) throw new AppError(403, "only the class owner can do that", { code: "not-class-owner" });
      if (!access.isAdmin) throw new AppError(403, "only class admins can do that", { code: "not-class-admin" });
      if (options.allowArchived !== true) this.assertActive(access.found.data);
      const next: ClassRecord = { ...change(access.found.data), id: classId, updatedAt: this.now().toISOString() };
      if (await this.classes.saveIfMatch(next, access.found.etag)) {
        await this.purgeBoard(classId); // every edit can change the board: its window, cases, name, token or status
        return this.toDetail(next, access.member, true);
      }
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  private async changeMember(classId: string, accountId: string, change: (member: ClassMemberRecord) => ClassMemberRecord): Promise<ClassMember> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError(404, "member not found");
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const found = await this.classes.getMember(classId, accountId);
      if (!found) throw new AppError(404, "member not found");
      const next = change(found.data);
      if (next === found.data || (await this.classes.saveMemberIfMatch(classId, accountId, next, found.etag))) {
        await this.classes.saveMemberOf(accountId, classId, reverseOf(next)); // forward first, then reverse
        const account = await this.repos.accounts.get(accountId);
        return this.toMember(accountId, account?.data.username ?? accountId, next);
      }
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  private async targetMember(classId: string, accountId: string): Promise<ClassMemberRecord> {
    const found = ACCOUNT_ID_PATTERN.test(accountId) ? await this.classes.getMember(classId, accountId) : null;
    if (!found) throw new AppError(404, "member not found");
    return found.data;
  }

  /** Forward first (access ends at once), then the reverse row. */
  private async removeMembership(classId: string, accountId: string): Promise<void> {
    await this.classes.deleteMember(classId, accountId);
    await this.classes.deleteMemberOf(accountId, classId);
    await this.purgeBoard(classId);
  }

  /**
   * Drops the CDN copy of the class board after an edit, so a rotated token, an archive or a removed member takes
   * effect at once instead of after the board's cache window. Solves never purge (see ClassBoardService).
   */
  private purgeBoard(classId: string): Promise<void> {
    return this.purger.purge([classBoardTag(classId)]);
  }

  private async repairReverse(accountId: string, classId: string, member: ClassMemberRecord): Promise<void> {
    const reverse = await this.classes.getMemberOf(accountId, classId);
    if (reverse === null || !sameReverse(reverse, reverseOf(member))) await this.classes.saveMemberOf(accountId, classId, reverseOf(member));
  }

  /** The class a typed code opens, or null. A stale index entry (its class has another code now) is removed. */
  private async findByCode(code: string): Promise<Versioned<ClassRecord> | null> {
    const normalized = normalizeClassCode(code);
    if (!/^[0-9A-Z]{4,40}$/.test(normalized)) return null;
    const hash = sha256Hex(normalized);
    const classId = await this.classes.lookupCode(hash);
    if (classId === null) return null;
    const found = await this.classes.get(classId);
    if (!found || joinCodeHash(found.data.joinCode) !== hash) {
      await this.classes.releaseCode(hash);
      return null;
    }
    return found.data.status === "active" ? found : null; // an archived class takes no one, and says nothing
  }

  private async claimNewCode(classId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateJoinCode();
      if (await this.classes.claimCode(joinCodeHash(code), classId)) return code;
    }
    throw new AppError(409, "couldn't pick a class code, please retry");
  }

  /** Active classes this account owns (the reverse index's owner rows, checked against each class). */
  private async ownedActive(accountId: string): Promise<number> {
    const owned = (await this.classes.listMemberOf(accountId)).filter((row) => row.entry?.isOwner === true);
    const classes = await mapWithConcurrency(owned, ({ classId }) => this.classes.get(classId));
    return classes.filter((c) => c !== null && c.data.ownerId === accountId && c.data.status === "active").length;
  }

  private cleanSchedule(schedule: ClassSchedule): ClassSchedule {
    if (!isValidTimeZone(schedule.timezone)) throw new AppError(400, `unknown time zone: ${schedule.timezone}`);
    this.assertReleased([schedule.defaultCaseId, ...Object.values(schedule.days)].filter((id): id is string => id !== null));
    // Entries older than a year go, so the record can't grow without bound (like the site schedule).
    const cutoff = localDate(new Date(this.now().getTime() - 366 * DAY_MS), schedule.timezone);
    const days = Object.fromEntries(Object.entries(schedule.days).filter(([day]) => day >= cutoff).sort(([a], [b]) => a.localeCompare(b)));
    return { ...schedule, days };
  }

  private assertReleased(caseIds: readonly string[]): void {
    const released = this.releasedCaseIds();
    const unknown = caseIds.find((id) => !released.includes(id));
    if (unknown !== undefined) throw new AppError(400, `case is not published: ${unknown}`, { code: "unknown-case" });
  }

  private assertActive(record: ClassRecord): void {
    if (record.status !== "active") throw new AppError(409, "this class is archived", { code: "class-archived" });
  }

  private classLimitError(limit: number): AppError {
    return new AppError(409, `you can own at most ${limit} active classes; archive one first`, { code: "class-limit" });
  }

  private fullError(): AppError {
    return new AppError(409, "this class is full", { code: "class-full" });
  }

  private toMember(accountId: string, username: string, member: ClassMemberRecord): ClassMember {
    return { accountId, username, role: member.role, status: member.status, isOwner: member.isOwner, joinedAt: member.joinedAt, decidedAt: member.decidedAt };
  }

  private toDetail(record: ClassRecord, member: ClassMemberRecord | null, isAdmin: boolean): ClassDetail {
    const summary = toClassSummary(record, member);
    if (!isAdmin && member?.status !== "active") return summary; // a pending request sees the name only
    const shared = { ...summary, schedule: record.schedule, event: record.event, caseIds: record.caseIds, boardToken: record.boardToken };
    if (!isAdmin) return shared;
    return {
      ...shared,
      admin: { ownerId: record.ownerId, joinMode: record.joinMode, joinCode: record.joinCode, memberLimit: record.memberLimit, createdAt: record.createdAt, updatedAt: record.updatedAt },
    };
  }
}
