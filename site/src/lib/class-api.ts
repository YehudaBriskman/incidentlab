// Typed client for the classes API (#179, #181; docs/API.md "Classes"). Every response is parsed with the
// contract's zod schemas. Everything here is personalised (no-store) except the class board, which is public,
// CDN-cached and read by whoever holds its capability URL.
import {
  AdminProgressResponseSchema,
  ClassBoardResponseSchema,
  ClassesResponseSchema,
  ClassJoinResponseSchema,
  ClassMemberResponseSchema,
  ClassMembersResponseSchema,
  ClassResponseSchema,
  ClassResetRequestResponseSchema,
  ClassResetRequestsResponseSchema,
  type ClassResetRequest,
  type ClassBoardResponse,
  type ClassDetail,
  type ClassMember,
  type ClassRole,
  type ClassSummary,
  type UpdateClassRequest,
} from "../../shared/contract";
import type { AdminProgressResult } from "./admin-api";
import { request, requestNoContent } from "./api";

const seg = encodeURIComponent;
const classPath = (id: string, rest = ""): string => `/api/classes/${seg(id)}${rest}`;

/** Class names by id, from every class response of this page load (the breadcrumb shows them). */
const names = new Map<string, string>();
const remember = <C extends ClassSummary>(c: C): C => {
  names.set(c.id, c.name);
  return c;
};
export const cachedClassName = (id: string): string | undefined => names.get(id);

export async function fetchMyClasses(): Promise<ClassSummary[]> {
  return (await request("GET", "/api/classes", ClassesResponseSchema)).classes.map(remember);
}

export async function createClass(name: string): Promise<ClassDetail> {
  return remember((await request("POST", "/api/classes", ClassResponseSchema, { name })).class);
}

export async function joinClass(code: string): Promise<ClassSummary> {
  return remember((await request("POST", "/api/classes/join", ClassJoinResponseSchema, { code })).class);
}

export async function fetchClass(id: string): Promise<ClassDetail> {
  return remember((await request("GET", classPath(id), ClassResponseSchema)).class);
}

export async function updateClass(id: string, patch: UpdateClassRequest): Promise<ClassDetail> {
  return remember((await request("PATCH", classPath(id), ClassResponseSchema, patch)).class);
}

export async function archiveClass(id: string): Promise<ClassDetail> {
  return remember((await request("POST", classPath(id, "/archive"), ClassResponseSchema, {})).class);
}

export async function restoreClass(id: string): Promise<ClassDetail> {
  return remember((await request("POST", classPath(id, "/restore"), ClassResponseSchema, {})).class);
}

export async function rotateJoinCode(id: string): Promise<ClassDetail> {
  return remember((await request("POST", classPath(id, "/join-code/rotate"), ClassResponseSchema, {})).class);
}

export async function rotateBoardToken(id: string): Promise<ClassDetail> {
  return remember((await request("POST", classPath(id, "/board-token/rotate"), ClassResponseSchema, {})).class);
}

export async function leaveClass(id: string): Promise<void> {
  await requestNoContent(classPath(id, "/leave"), {});
}

export async function fetchClassMembers(id: string): Promise<ClassMember[]> {
  return (await request("GET", classPath(id, "/members"), ClassMembersResponseSchema)).members;
}

export async function approveClassMember(id: string, accountId: string): Promise<ClassMember> {
  return (await request("POST", classPath(id, `/members/${seg(accountId)}/approve`), ClassMemberResponseSchema, {})).member;
}

export async function removeClassMember(id: string, accountId: string): Promise<void> {
  await requestNoContent(classPath(id, `/members/${seg(accountId)}/remove`), {});
}

export async function setClassMemberRole(id: string, accountId: string, role: ClassRole): Promise<ClassMember> {
  return (await request("POST", classPath(id, `/members/${seg(accountId)}/role`), ClassMemberResponseSchema, { role })).member;
}

/** Open password reset requests of the class's active members (#254; class admins). */
export async function fetchClassResetRequests(id: string): Promise<ClassResetRequest[]> {
  return (await request("GET", classPath(id, "/reset-requests"), ClassResetRequestsResponseSchema)).requests;
}

/** "I know this student" (#254). It changes no password: the site owner approves the request. */
export async function vouchResetRequest(id: string, accountId: string): Promise<ClassResetRequest> {
  return (await request("POST", classPath(id, `/reset-requests/${seg(accountId)}/vouch`), ClassResetRequestResponseSchema, {})).request;
}

/** Live progress of the class's active members on one case (class admins; the admin Live tab's shape). */
export async function fetchClassProgress(id: string, caseId: string): Promise<AdminProgressResult> {
  return request("GET", classPath(id, `/progress?caseId=${seg(caseId)}`), AdminProgressResponseSchema);
}

/** The class board (public, CDN-cached): overall when `caseId` is null, else for that case. */
export async function fetchClassBoard(boardToken: string, caseId: string | null): Promise<ClassBoardResponse> {
  const query = caseId === null ? "" : `?caseId=${seg(caseId)}`;
  return request("GET", `/api/classboard/${seg(boardToken)}${query}`, ClassBoardResponseSchema);
}

/** The shareable join link for a code (#/join/<code>), on this site. */
export const joinLink = (code: string): string => `${location.origin}${location.pathname}#/join/${seg(code)}`;

/** The class's "case of the day": the date in its time zone, then that day's case or the default. */
export function classToday(schedule: ClassDetail["schedule"], now = Date.now()): { date: string; caseId: string | null } | null {
  if (schedule === undefined) return null;
  let date: string;
  try {
    date = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  } catch {
    date = new Date(now).toISOString().slice(0, 10);
  }
  return { date, caseId: schedule.days[date] ?? schedule.defaultCaseId };
}
