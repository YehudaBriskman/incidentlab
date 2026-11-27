// Teacher-vouched password reset requests (#254): `resetrequest:<accountId>`, one per account.
// A request never holds or leads to a password by itself: class admins add vouches, and only the site owner's
// approval sets a temporary password (services/PasswordResetService.ts). Additive record, with defaults.
import { z } from "zod";

export const RESET_REQUEST_SCHEMA_VERSION = 1;

/** One class admin saying "I know this student", for one class the student is an active member of. */
export const ResetVouchSchema = z.object({
  classId: z.string(),
  /** the class admin's account id */
  byAccountId: z.string(),
  at: z.string(),
});
export type ResetVouch = z.infer<typeof ResetVouchSchema>;

export const ResetRequestStatusSchema = z.enum(["open", "done", "rejected"]);

export const ResetRequestRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(RESET_REQUEST_SCHEMA_VERSION),
  accountId: z.string(),
  status: ResetRequestStatusSchema.default("open"),
  createdAt: z.string(),
  /** createdAt (or the last repeat of the request) + RESET_REQUEST_TTL_DAYS; the weekly hygiene job deletes it after */
  expiresAt: z.string(),
  vouches: z.array(ResetVouchSchema).default([]),
  /** when the owner approved or rejected it */
  decidedAt: z.string().nullable().default(null),
});
export type ResetRequestRecord = z.infer<typeof ResetRequestRecordSchema>;

/** Open and not past its expiry: the only state a vouch or an approval accepts. */
export const isLiveRequest = (record: ResetRequestRecord, nowMs: number): boolean => record.status === "open" && Date.parse(record.expiresAt) > nowMs;
