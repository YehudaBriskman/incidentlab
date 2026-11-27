// Scale seed (#185): fills a KvStore with a public-site-sized data set, straight into the records (no HTTP, no
// scrypt), so the scale check can call the app on a CDN miss and count the store reads per call.
//
//   2,000 accounts (10% guests, 30% of the full accounts opted in to the global board, 5 authors, a few banned),
//   20 cases, about 5 cases played per account with realistic stage progress, a `score:` summary per account,
//   100 classes of 10 to 60 members (class 0 is full at 60) in both membership indexes.
//
// Deterministic: a seeded PRNG, so every run (and CI) measures the same data set.
import { createHash, randomBytes } from "node:crypto";
import { QUESTION_ORDER } from "../../site/shared/contract.ts";
import type { QuestionId } from "../../site/shared/contract.ts";
import { summarizeProgress } from "../../site/server/domain/score.ts";
import type { ProgressRecord, Secrets } from "../../site/server/domain/types.ts";
import type { KvStore } from "../../site/server/repositories/KvStore.ts";

export const SCALE = { ACCOUNTS: 2000, GUEST_SHARE: 0.1, OPT_IN_SHARE: 0.3, CASES: 20, CLASSES: 100, MAX_MEMBERS: 60, CASES_PER_PLAYER: 5 } as const;

/** mulberry32: small, fast, and the same sequence on every platform. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const idFrom = (rand: () => number): string => Array.from({ length: 12 }, () => ALNUM[Math.floor(rand() * ALNUM.length)] ?? "0").join("");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const question = { points: 100, hintCosts: [10, 20, 40], targetSeconds: 600 };
const hintTexts = (qid: string) => [1, 2, 3].map((n) => ({ en: `${qid} hint ${n}`, he: null }));

/** 20 made-up cases (the same shape the server tests use). */
export const scaleSecrets = (): Secrets => {
  const cases: Secrets["cases"] = {};
  for (let i = 0; i < SCALE.CASES; i++) {
    const id = `scale-case-${String(i).padStart(2, "0")}`;
    cases[id] = {
      title: `Scale case ${i}`,
      answers: { q1: "a1", q2: "a2", q3: "a3", q4: "a4", q5: "a5", q6: "a6" },
      debrief: `# debrief ${id}`,
      debriefHe: null,
      questions: { q1: question, q2: question, q3: question, q4: question, q5: question, q6: { ...question, points: 150 } },
      hints: { q1: hintTexts("q1"), q2: hintTexts("q2"), q3: hintTexts("q3"), q4: hintTexts("q4"), q5: hintTexts("q5"), q6: hintTexts("q6") },
      tools: {},
      estMinutes: 60,
    };
  }
  return { cases };
};

export type ScaleSeed = {
  readonly caseIds: readonly string[];
  readonly accountIds: readonly string[];
  /** an opted-in, approved full account in three classes, with a live session */
  readonly player: { readonly id: string; readonly token: string };
  /** the full class (60 members) */
  readonly fullClass: { readonly id: string; readonly boardToken: string };
  readonly counts: Readonly<Record<string, number>>;
};

const BASE_MS = Date.UTC(2026, 9, 1);
const iso = (ms: number): string => new Date(ms).toISOString();

/** A progress record on one case: `solved` stages solved in order, the next one active (or the case completed). */
const progressRecord = (accountId: string, caseId: string, solved: number, startMs: number, rand: () => number): ProgressRecord => {
  const stages = {} as ProgressRecord["stages"];
  let t = startMs + 120_000;
  for (const [i, q] of QUESTION_ORDER.entries()) {
    const qid: QuestionId = q;
    if (i < solved) {
      const hints = rand() < 0.3 ? 1 : 0;
      const points = (qid === "q6" ? 150 : 100) - hints * 10;
      const started = t;
      t += 60_000 + Math.floor(rand() * 900_000);
      stages[qid] = { status: "solved", startedAt: iso(started), finishedAt: iso(t), hintsRevealed: hints, wrongAttempts: Math.floor(rand() * 3), points, revealedAnswer: null, commandsRevealed: 0, breakdown: null, solvedAnswer: null };
    } else if (i === solved) {
      stages[qid] = { status: "active", startedAt: iso(t), finishedAt: null, hintsRevealed: 0, wrongAttempts: 0, points: 0, revealedAnswer: null, commandsRevealed: 0, breakdown: null, solvedAnswer: null };
    } else {
      stages[qid] = { status: "locked", startedAt: null, finishedAt: null, hintsRevealed: 0, wrongAttempts: 0, points: 0, revealedAnswer: null, commandsRevealed: 0, breakdown: null, solvedAnswer: null };
    }
  }
  const completed = solved === QUESTION_ORDER.length;
  return {
    schemaVersion: 1, accountId, caseId, startedAt: iso(startMs), lastSeenAt: iso(t), setupDoneAt: iso(startMs + 60_000),
    completedAt: completed ? iso(t) : null, stages, wrongAnswerTimestamps: {}, commandsRevealed: {}, completionBonus: completed ? 50 : 0,
  };
};

/** Writes the data set into `store` and returns the ids the scale check calls with. */
export async function seedScale(store: KvStore, options: { seed?: number; nowMs?: number } = {}): Promise<ScaleSeed> {
  const rand = prng(options.seed ?? 185);
  const nowMs = options.nowMs ?? Date.now();
  const caseIds = Object.keys(scaleSecrets().cases);
  const counts: Record<string, number> = { accounts: 0, guests: 0, optedIn: 0, progress: 0, classes: 0, memberships: 0 };
  const accountIds: string[] = [];
  const fullAccounts: string[] = [];

  for (let i = 0; i < SCALE.ACCOUNTS; i++) {
    const id = idFrom(rand);
    const guest = i % Math.round(1 / SCALE.GUEST_SHARE) === 0;
    const username = guest ? `guest-${id.slice(0, 8).toLowerCase()}` : `player_${String(i).padStart(4, "0")}`;
    const createdMs = BASE_MS + Math.floor(rand() * 50 * 86_400_000);
    const optedIn = !guest && rand() < SCALE.OPT_IN_SHARE;
    const status = !guest && i % 97 === 1 ? "rejected" : "approved";
    await store.set(`account:${id}`, {
      schemaVersion: 1, id, username, usernameKey: username, passwordHash: "x", status, sessionEpoch: 0,
      createdAt: iso(createdMs), decidedAt: iso(createdMs), lastSeenAt: iso(nowMs - Math.floor(rand() * 20 * 86_400_000)), lastLoginAt: null,
      mustChangePassword: false, role: !guest && i % 400 === 3 ? "author" : "player", kind: guest ? "guest" : "user",
      showOnGlobalBoard: optedIn, recoveryCodeHash: null, classLimit: null,
    });
    if (!guest) await store.set(`username:${sha256(username)}`, { accountId: id });
    if (optedIn) await store.set(`globalboard:${id}`, { accountId: id, since: iso(createdMs) });

    // About CASES_PER_PLAYER cases each (guests 1 or 2), at a random depth.
    const played = guest ? 1 + Math.floor(rand() * 2) : Math.floor(rand() * (SCALE.CASES_PER_PLAYER * 2 + 1));
    const picks = [...caseIds].sort(() => rand() - 0.5).slice(0, played);
    const records = picks.map((caseId) => progressRecord(id, caseId, Math.floor(rand() * 7), createdMs + Math.floor(rand() * 20 * 86_400_000), rand));
    for (const r of records) await store.set(`progress:${r.caseId}:${id}`, r);
    await store.set(`score:${id}`, summarizeProgress(id, records));

    accountIds.push(id);
    if (!guest && status === "approved") fullAccounts.push(id);
    counts["accounts"] = (counts["accounts"] ?? 0) + 1;
    counts["progress"] = (counts["progress"] ?? 0) + records.length;
    if (guest) counts["guests"] = (counts["guests"] ?? 0) + 1;
    if (optedIn) counts["optedIn"] = (counts["optedIn"] ?? 0) + 1;
  }

  // The measured player: opted in, approved, signed in.
  const playerId = fullAccounts[0] ?? "";
  const player = (await store.get(`account:${playerId}`))?.data;
  if (typeof player === "object" && player !== null) await store.set(`account:${playerId}`, { ...player, showOnGlobalBoard: true });
  await store.set(`globalboard:${playerId}`, { accountId: playerId, since: iso(BASE_MS) });
  const token = randomBytes(32).toString("base64url");
  await store.set(`session:${sha256(token)}`, { role: "player", accountId: playerId, epoch: 0, createdAt: iso(nowMs), expiresAt: iso(nowMs + 86_400_000) });

  let fullClass = { id: "", boardToken: "" };
  for (let c = 0; c < SCALE.CLASSES; c++) {
    const id = idFrom(rand);
    const ownerId = fullAccounts[(c * 7) % fullAccounts.length] ?? playerId;
    const size = c === 0 ? SCALE.MAX_MEMBERS : 10 + Math.floor(rand() * (SCALE.MAX_MEMBERS - 9));
    const members = new Set<string>([ownerId]);
    if (c < 3) members.add(playerId); // the measured player is in three classes
    while (members.size < size) members.add(fullAccounts[Math.floor(rand() * fullAccounts.length)] ?? ownerId);
    const boardToken = `${id}.${idFrom(rand)}${idFrom(rand)}`;
    const joinCode = `SCALE-${String(c).padStart(5, "0")}`;
    const at = iso(BASE_MS + c * 3_600_000);
    const event = c % 4 === 0
      ? { name: `Event night ${c}`, startsAt: iso(nowMs - 3_600_000), endsAt: iso(nowMs + 3_600_000), freezeAt: null, announcement: null }
      : { name: "", startsAt: null, endsAt: null, freezeAt: null, announcement: null };
    await store.set(`class:${id}`, {
      schemaVersion: 1, id, name: `Class ${c}`, ownerId, createdAt: at, updatedAt: at, status: "active", joinMode: "code",
      memberLimit: SCALE.MAX_MEMBERS, boardToken, joinCode, schedule: { timezone: "Asia/Jerusalem", defaultCaseId: null, days: {} },
      event, caseIds: c % 2 === 0 ? caseIds.slice(0, 5) : [],
    });
    await store.set(`classcode:${sha256(joinCode.replace("-", ""))}`, { classId: id });
    for (const accountId of members) {
      const isOwner = accountId === ownerId;
      const member = { role: isOwner ? "admin" : "member", status: "active", isOwner, joinedAt: at, decidedAt: at };
      await store.set(`classmember:${id}:${accountId}`, member);
      await store.set(`memberof:${accountId}:${id}`, { role: member.role, status: member.status, isOwner });
    }
    counts["classes"] = (counts["classes"] ?? 0) + 1;
    counts["memberships"] = (counts["memberships"] ?? 0) + members.size;
    if (c === 0) fullClass = { id, boardToken };
  }
  return { caseIds, accountIds, player: { id: playerId, token }, fullClass, counts };
}
