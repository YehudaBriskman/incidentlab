import { AppError } from "../domain/types.ts";
import { sha256Hex, safeEqual } from "./crypto.ts";

const MIN_ADMIN_KEY_LENGTH = 16;

export class AdminAuthService {
  private readonly adminKey: string | undefined;

  constructor(adminKey: string | undefined) {
    this.adminKey = adminKey;
  }

  /** Throws 503 when admin is disabled, 401 when the key is missing or wrong. */
  assertAdmin(providedKey: string | null): void {
    if (!this.adminKey || this.adminKey.length < MIN_ADMIN_KEY_LENGTH) throw new AppError(503, "admin disabled");
    if (!providedKey) throw new AppError(401, "admin key required");
    // Compare fixed-length digests so timingSafeEqual never sees different lengths.
    if (!safeEqual(sha256Hex(providedKey), sha256Hex(this.adminKey))) throw new AppError(401, "invalid admin key");
  }
}
