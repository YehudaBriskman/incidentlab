// What a class admin may do to one member, from the permission matrix in docs/API.md ("Classes"). The UI hides
// every action the server would refuse; the server still checks each one. DOM-free, so it is unit tested.
// There is no password reset and no account delete here: class admins never get either (account takeover).
import type { ClassMember, ClassMembership } from "../../shared/contract";

/** Who is managing: the caller's membership (null for the site admin, who may do what an owner may). */
export type ClassCaller = { membership: ClassMembership | null; accountId: string | null };

export type MemberAction = "approve" | "decline" | "promote" | "demote" | "remove";

/** The owner and the site admin: archive, restore, promote and demote, remove co-admins. */
export const isOwnerLike = (caller: ClassCaller): boolean => caller.membership === null || caller.membership.isOwner;

/** Owner, active co-admin or site admin: edit settings, list members, approve, remove members. */
export const isClassAdmin = (caller: ClassCaller): boolean =>
  caller.membership === null || (caller.membership.role === "admin" && caller.membership.status === "active");

export function memberActions(caller: ClassCaller, member: ClassMember): MemberAction[] {
  if (!isClassAdmin(caller)) return [];
  if (member.isOwner || member.accountId === caller.accountId) return [];
  if (member.status === "pending") return ["approve", "decline"];
  const owner = isOwnerLike(caller);
  if (member.role === "admin") return owner ? ["demote", "remove"] : [];
  return owner ? ["promote", "remove"] : ["remove"];
}
