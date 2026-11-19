import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const PLAYER_ID_PATTERN = /^[0-9A-Za-z]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const generatePlayerId = (): string => {
  let id = "";
  while (id.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && id.length < 12) id += BASE62[byte % 62];
    }
  }
  return id;
};

export const generateToken = (playerId: string): string => `${playerId}.${randomBytes(32).toString("base64url")}`;

export const parseToken = (token: string): { playerId: string } | null => {
  const [playerId, secret, ...rest] = token.split(".");
  if (rest.length > 0 || !playerId || !secret) return null;
  if (!PLAYER_ID_PATTERN.test(playerId) || !SECRET_PATTERN.test(secret)) return null;
  return { playerId };
};

export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};
