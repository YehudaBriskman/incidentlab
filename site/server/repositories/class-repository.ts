// Classes (#179): the class record, its join-code index and both membership indexes. Key layout in
// domain/classes.ts. Only prefix listings of `classmember:<classId>:` (at most memberLimit keys) and
// `memberof:<accountId>:` (one account's classes) happen on request paths; `class:` is listed by the admin only.
//
// Index consistency (docs/DATA.md, "Classes"): `classmember:` is authoritative, `memberof:` is derived.
// - Writes go forward first, then reverse; deletes go forward first (access ends at once), then reverse.
// - So a crash can leave a forward record without its reverse (the member can use the class but doesn't list it)
//   or a reverse without a forward (a stale "my classes" row). Both are repaired idempotently: listing my classes
//   drops stale reverse rows and rewrites ones that differ, and any class read by a member rewrites a missing one.
import { z } from "zod";
import { ClassCodeIndexSchema, ClassMemberRecordSchema, ClassRecordSchema, MemberOfRecordSchema, reverseOf } from "../domain/classes.ts";
import type { ClassMemberRecord, ClassRecord, MemberOfRecord, TrashedMembership } from "../domain/classes.ts";
import { mapWithConcurrency } from "./KvStore.ts";
import type { KvStore, Versioned } from "./KvStore.ts";

const parseVersioned = <T>(entry: Versioned<unknown> | null, schema: z.ZodType<T>): Versioned<T> | null => {
  if (!entry) return null;
  const parsed = schema.safeParse(entry.data);
  return parsed.success ? { data: parsed.data, etag: entry.etag } : null;
};

const CLASS_PREFIX = "class:";
const memberPrefix = (classId: string): string => `classmember:${classId}:`;
const memberOfPrefix = (accountId: string): string => `memberof:${accountId}:`;

export class ClassRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }

  // ---- class records ------------------------------------------------------
  async get(classId: string): Promise<Versioned<ClassRecord> | null> {
    return parseVersioned(await this.kv.get(`${CLASS_PREFIX}${classId}`), ClassRecordSchema);
  }
  /** Conditional write; `etag === null` means "only if new". */
  saveIfMatch(record: ClassRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`${CLASS_PREFIX}${record.id}`, record, etag);
  }
  /** Only to roll back a create that went over the owner's limit. Classes are archived, never deleted. */
  async deleteUnused(classId: string): Promise<void> {
    await this.kv.delete(`${CLASS_PREFIX}${classId}`);
  }
  /** Admin only: every class (a full prefix scan). */
  async list(): Promise<ClassRecord[]> {
    const keys = await this.kv.listKeys(CLASS_PREFIX);
    const rows = await mapWithConcurrency(keys, async (key) => parseVersioned(await this.kv.get(key), ClassRecordSchema)?.data ?? null);
    return rows.filter((r): r is ClassRecord => r !== null);
  }

  // ---- join-code index ----------------------------------------------------
  async lookupCode(codeHash: string): Promise<string | null> {
    return parseVersioned(await this.kv.get(`classcode:${codeHash}`), ClassCodeIndexSchema)?.data.classId ?? null;
  }
  /** Claims a code for a class; false when that code is already in use. */
  claimCode(codeHash: string, classId: string): Promise<boolean> {
    return this.kv.setIfMatch(`classcode:${codeHash}`, { classId }, null);
  }
  async releaseCode(codeHash: string): Promise<void> {
    await this.kv.delete(`classcode:${codeHash}`);
  }

  // ---- forward membership (authoritative) ---------------------------------
  async getMember(classId: string, accountId: string): Promise<Versioned<ClassMemberRecord> | null> {
    return parseVersioned(await this.kv.get(`${memberPrefix(classId)}${accountId}`), ClassMemberRecordSchema);
  }
  saveMemberIfMatch(classId: string, accountId: string, record: ClassMemberRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`${memberPrefix(classId)}${accountId}`, record, etag);
  }
  async deleteMember(classId: string, accountId: string): Promise<void> {
    await this.kv.delete(`${memberPrefix(classId)}${accountId}`);
  }
  /** Members and pending requests together (one list call, no reads): what the member cap counts. */
  async countMembers(classId: string): Promise<number> {
    return (await this.kv.listKeys(memberPrefix(classId))).length;
  }
  async listMembers(classId: string): Promise<Array<{ accountId: string; member: ClassMemberRecord }>> {
    const prefix = memberPrefix(classId);
    const keys = await this.kv.listKeys(prefix);
    const rows = await mapWithConcurrency(keys, async (key) => {
      const member = parseVersioned(await this.kv.get(key), ClassMemberRecordSchema)?.data ?? null;
      return member ? { accountId: key.slice(prefix.length), member } : null;
    });
    return rows.filter((r): r is { accountId: string; member: ClassMemberRecord } => r !== null);
  }

  // ---- reverse index --------------------------------------------------------
  async getMemberOf(accountId: string, classId: string): Promise<MemberOfRecord | null> {
    return parseVersioned(await this.kv.get(`${memberOfPrefix(accountId)}${classId}`), MemberOfRecordSchema)?.data ?? null;
  }
  async saveMemberOf(accountId: string, classId: string, record: MemberOfRecord): Promise<void> {
    await this.kv.set(`${memberOfPrefix(accountId)}${classId}`, record);
  }
  async deleteMemberOf(accountId: string, classId: string): Promise<void> {
    await this.kv.delete(`${memberOfPrefix(accountId)}${classId}`);
  }
  /** The class ids in one account's reverse index (one list call). */
  async listMemberOfIds(accountId: string): Promise<string[]> {
    const prefix = memberOfPrefix(accountId);
    return (await this.kv.listKeys(prefix)).map((key) => key.slice(prefix.length));
  }
  async listMemberOf(accountId: string): Promise<Array<{ classId: string; entry: MemberOfRecord | null }>> {
    return mapWithConcurrency(await this.listMemberOfIds(accountId), async (classId) => ({ classId, entry: await this.getMemberOf(accountId, classId) }));
  }

  // ---- account delete and restore ------------------------------------------
  /** Every membership of an account (from the reverse index, read from the authoritative forward records). */
  async membershipsOf(accountId: string): Promise<TrashedMembership[]> {
    const rows = await mapWithConcurrency(await this.listMemberOfIds(accountId), async (classId) => {
      const found = await this.getMember(classId, accountId);
      return found ? { classId, ...found.data } : null;
    });
    return rows.filter((r): r is TrashedMembership => r !== null);
  }

  /** Removes every membership of a deleted account from both indexes (forward first), stale reverse rows too. */
  async removeAccount(accountId: string): Promise<void> {
    const classIds = await this.listMemberOfIds(accountId);
    await mapWithConcurrency(classIds, async (classId) => {
      await this.deleteMember(classId, accountId);
      await this.deleteMemberOf(accountId, classId);
    });
  }

  /**
   * Puts a restored account's memberships back, in both indexes, for classes that still exist. A membership that
   * exists again is kept as it is. Restores ignore the member cap: the site admin chose to bring the account back.
   */
  async restoreAccount(accountId: string, memberships: readonly TrashedMembership[]): Promise<number> {
    let restored = 0;
    for (const { classId, ...member } of memberships) {
      if (!(await this.get(classId))) continue;
      if (await this.saveMemberIfMatch(classId, accountId, member, null)) restored += 1;
      const current = await this.getMember(classId, accountId);
      if (current) await this.saveMemberOf(accountId, classId, reverseOf(current.data));
    }
    return restored;
  }
}
