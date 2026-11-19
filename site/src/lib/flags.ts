import { normalizeAnswer, type Flags } from "../content/schema";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkAnswer(flags: Flags, questionId: string, raw: string): Promise<boolean> {
  const flag = flags.flags[questionId];
  if (!flag) return false;
  const hash = await sha256Hex(flag.salt + normalizeAnswer(raw));
  return hash === flag.sha256.toLowerCase();
}
