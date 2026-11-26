// Who may use /api/author/*: the admin (X-Admin-Key header, as the CLI sends it, or the admin session), or
// an approved author account (AuthService.requireAuthor). Ownership of a case is checked by the services.
import type { AuditEntry } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AdminAuthService } from "./AdminAuthService.ts";
import type { AuthService } from "./AuthService.ts";

export const ADMIN_OWNER = "admin";

export type Actor =
  | { readonly kind: "admin"; readonly via: AuditEntry["via"] }
  | { readonly kind: "author"; readonly accountId: string; readonly username: string; readonly via: AuditEntry["via"] };

/** The `createdBy` / upload owner value for an actor. */
export const ownerId = (actor: Actor): string => (actor.kind === "admin" ? ADMIN_OWNER : actor.accountId);
/** For audit details: "admin" or "author dana_k". */
export const actorLabel = (actor: Actor): string => (actor.kind === "admin" ? ADMIN_OWNER : `author ${actor.username}`);

/** Throws 403 code "not-owner" unless the actor is the admin or owns the case (`createdBy`). */
export const assertOwner = (actor: Actor, createdBy: string): void => {
  if (actor.kind === "admin" || actor.accountId === createdBy) return;
  throw new AppError(403, "this case belongs to another author", { code: "not-owner" });
};

export class AuthorAuthService {
  private readonly admin: AdminAuthService;
  private readonly auth: AuthService;

  constructor(deps: { admin: AdminAuthService; auth: AuthService }) {
    this.admin = deps.admin;
    this.auth = deps.auth;
  }

  async resolve(input: { headerKey: string | null; sessionToken: string | null }): Promise<Actor> {
    if (input.headerKey) return { kind: "admin", via: await this.admin.assertAdmin({ headerKey: input.headerKey, sessionToken: null }) };
    const principal = await this.auth.requireAuthor(input.sessionToken);
    if (principal.kind === "admin") return { kind: "admin", via: "session" };
    return { kind: "author", accountId: principal.account.id, username: principal.account.username, via: "session" };
  }
}
