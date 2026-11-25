import type { AuditEntry } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AuthService } from "./AuthService.ts";
import { safeEqual, sha256Hex } from "./crypto.ts";

const MIN_ADMIN_KEY_LENGTH = 16;

/** Admin access: the X-Admin-Key header, or the session cookie of `admin` signed in with that key. */
export class AdminAuthService {
  private readonly adminKey: () => string | undefined;
  private readonly auth: AuthService;

  constructor(deps: { adminKey: () => string | undefined; auth: AuthService }) {
    this.adminKey = deps.adminKey;
    this.auth = deps.auth;
  }

  /** Throws 503 when admin is disabled, 401 when neither credential is valid. Returns how the caller authenticated. */
  async assertAdmin(input: { headerKey: string | null; sessionToken: string | null }): Promise<AuditEntry["via"]> {
    const adminKey = this.adminKey();
    if (!adminKey || adminKey.length < MIN_ADMIN_KEY_LENGTH) throw new AppError(503, "admin disabled");
    if (input.headerKey) {
      // Compare fixed-length digests so timingSafeEqual never sees different lengths.
      if (safeEqual(sha256Hex(input.headerKey), sha256Hex(adminKey))) return "key";
      throw new AppError(401, "invalid admin key");
    }
    if (await this.auth.isAdminSession(input.sessionToken)) return "session";
    throw new AppError(401, "admin key required");
  }
}
