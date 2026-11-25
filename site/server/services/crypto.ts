import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{12}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url

// scrypt cost: ~50 ms per hash on a Netlify function, 16 MiB memory.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32, saltBytes: 16 } as const;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const generateAccountId = (): string => {
  let id = "";
  while (id.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && id.length < 12) id += BASE62[byte % 62];
    }
  }
  return id;
};

export const generateSessionToken = (): string => randomBytes(32).toString("base64url");
export const isWellFormedSessionToken = (token: string): boolean => SESSION_TOKEN_PATTERN.test(token);

export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const scryptAsync = (password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLength: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

/** Returns `scrypt$N$r$p$<salt b64url>$<hash b64url>`. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, n, r, p, salt, hash, ...rest] = stored.split("$");
  if (scheme !== "scrypt" || rest.length > 0 || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const params = { N: Number(n), r: Number(r), p: Number(p), keyLength: expected.length };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0) || expected.length === 0) return false;
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), params);
  return timingSafeEqual(actual, expected);
};

/** A real hash of a random password, used to spend the same time when the username doesn't exist. */
let dummyHash: Promise<string> | null = null;
export const getDummyPasswordHash = (): Promise<string> => {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
};
