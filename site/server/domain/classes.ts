// Stored class records (#179). Additive: new prefixes only, every field beyond the first release has a default.
//   class:<classId>                       ClassRecord
//   classcode:<sha256(normalized code)>   { classId }          the join-code index (rotating deletes the old entry)
//   classmember:<classId>:<accountId>     ClassMemberRecord    authoritative membership (permission checks, the cap)
//   memberof:<accountId>:<classId>        MemberOfRecord       reverse index ("my classes", owned count)
import { z } from "zod";
import {
  CLASS_DEFAULTS,
  ClassEventSchema,
  ClassJoinModeSchema,
  ClassMemberStatusSchema,
  ClassRoleSchema,
  ClassScheduleSchema,
  ClassStatusSchema,
} from "../../shared/contract.ts";

export const CLASS_SCHEMA_VERSION = 1;

/** Class 1 from migration 004 is owned by the site owner, who signs in as `admin` and has no account record. */
export const SITE_OWNER_ID = "admin";

export const DEFAULT_CLASS_SCHEDULE = { timezone: "Asia/Jerusalem", defaultCaseId: null, days: {} } as const;
export const DEFAULT_CLASS_EVENT = { name: "", startsAt: null, endsAt: null, freezeAt: null, announcement: null } as const;

export const ClassRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(CLASS_SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  /** an account id, or SITE_OWNER_ID */
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: ClassStatusSchema.default("active"),
  joinMode: ClassJoinModeSchema.default("code"),
  memberLimit: z.number().int().min(1).default(CLASS_DEFAULTS.MEMBER_LIMIT),
  /** `<classId>.<random>`: the class board (#181) finds the class from the token itself, without an index */
  boardToken: z.string(),
  /** shown to class admins; the index key holds its sha256 (normalized) */
  joinCode: z.string(),
  schedule: ClassScheduleSchema.default({ ...DEFAULT_CLASS_SCHEDULE, days: {} }),
  event: ClassEventSchema.default({ ...DEFAULT_CLASS_EVENT }),
  /** assigned cases; [] = any public case */
  caseIds: z.array(z.string()).default([]),
});
export type ClassRecord = z.infer<typeof ClassRecordSchema>;

export const ClassCodeIndexSchema = z.object({ classId: z.string() });

export const ClassMemberRecordSchema = z.object({
  role: ClassRoleSchema,
  status: ClassMemberStatusSchema,
  /** exactly one member is the owner (except the site-owned Class 1, which has none) */
  isOwner: z.boolean().default(false),
  joinedAt: z.string(),
  decidedAt: z.string().nullable().default(null),
});
export type ClassMemberRecord = z.infer<typeof ClassMemberRecordSchema>;

export const MemberOfRecordSchema = z.object({
  role: ClassRoleSchema,
  status: ClassMemberStatusSchema,
  isOwner: z.boolean().default(false),
});
export type MemberOfRecord = z.infer<typeof MemberOfRecordSchema>;

/** A membership as the trash keeps it when its account is deleted, so a restore can put both index entries back. */
export const TrashedMembershipSchema = ClassMemberRecordSchema.extend({ classId: z.string() });
export type TrashedMembership = z.infer<typeof TrashedMembershipSchema>;

export const reverseOf = (member: ClassMemberRecord): MemberOfRecord => ({ role: member.role, status: member.status, isOwner: member.isOwner });
export const sameReverse = (a: MemberOfRecord, b: MemberOfRecord): boolean => a.role === b.role && a.status === b.status && a.isOwner === b.isOwner;
