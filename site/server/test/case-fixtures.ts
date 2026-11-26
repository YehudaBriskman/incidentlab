// Fixtures for DB-stored cases: valid content, sealed and meta records, and a writer that stores a whole
// case version (records + evidence chunks) straight through the repositories. Used by the server tests
// and by tests/local-server.ts --seed-db-case (dev only; never against production).
import { CaseMetaSchema } from "../../shared/case-records.ts";
import type { CaseContent, CaseLang, CaseMeta, CaseSealed, CaseStatus, EvidenceEntry } from "../../shared/case-records.ts";
import type { CaseRepository, EvidenceChunkRepository } from "../repositories/case-repository.ts";

export const contentFixture = (id: string, lang: CaseLang = "en"): CaseContent => ({
  id,
  title: lang === "he" ? `תיק ${id}` : `Case ${id}`,
  subtitle: lang === "he" ? "כותרת משנה" : "A subtitle",
  difficulty: "medium",
  estMinutes: 45,
  tags: ["logs"],
  inspiredBy: { title: "Some outage", year: 2021, summary: "What happened." },
  briefing: "Read the logs.",
  evidenceZip: `/evidence/db/${id}/v1.zip`,
  evidence: [{ path: "logs/app.log", format: "app log", description: "The app log." }],
  rules: ["No answers in public content."],
  questions: [
    {
      id: "q1",
      title: "When?",
      prompt: "When did it start?",
      answerFormat: "HH:MM:SS",
      placeholder: "03:00:00",
      points: 100,
      hints: [{ cost: 10 }, { cost: 20 }],
      successNote: "Well done.",
    },
  ],
  toolbox: [{ category: "grep", items: [{ id: "grep-errors", title: "Find errors", syntax: "grep <pattern> <file>", explain: "Search." }] }],
  debrief: "",
});

const QUESTION_IDS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
const perQuestion = <T>(value: (qid: string) => T): Record<(typeof QUESTION_IDS)[number], T> => ({
  q1: value("q1"), q2: value("q2"), q3: value("q3"), q4: value("q4"), q5: value("q5"), q6: value("q6"),
});

export const sealedFixture = (id: string): CaseSealed => ({
  title: `Case ${id}`,
  answers: perQuestion((qid) => `${qid}-answer`),
  debrief: "# debrief",
  debriefHe: null,
  questions: perQuestion(() => ({ points: 100, hintCosts: [10, 20], targetSeconds: 600 })),
  hints: perQuestion((qid) => [{ en: `${qid} first hint`, he: null }, { en: `${qid} second hint`, he: null }]),
  tools: { "grep-errors": { command: "grep ERROR app.log", powershell: null } },
  estMinutes: 45,
});

/** A meta in the shape #64 wrote (one `version`, no draft/published split). */
export type LegacyMeta = {
  schemaVersion: number; id: string; version: number; status: CaseStatus; langs: CaseLang[]; title: string;
  difficulty: CaseMeta["difficulty"]; tags: string[]; answerFingerprint: string; contentSha: string; createdBy: string; createdAt: string;
};

/** A meta as stored by #64, parsed into today's shape (the legacy `version` becomes publishedVersion unless a draft). */
export const metaFixture = (id: string, overrides: Partial<LegacyMeta> = {}): CaseMeta => CaseMetaSchema.parse(legacyMetaFixture(id, overrides));

export const legacyMetaFixture = (id: string, overrides: Partial<LegacyMeta> = {}): LegacyMeta => ({
  schemaVersion: 1,
  id,
  version: 1,
  status: "published",
  langs: ["en"],
  title: `Case ${id}`,
  difficulty: "medium",
  tags: ["logs"],
  answerFingerprint: "fp",
  contentSha: "a".repeat(64),
  createdBy: "admin",
  createdAt: "2026-11-26T00:00:00.000Z",
  ...overrides,
});

/** Deterministic pseudo-random bytes (not all zeros, so a misplaced chunk changes the hash). */
export const patternBytes = (size: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
};

export type SeedFile = { readonly path: string; readonly bytes: Uint8Array; readonly format?: string };

/** Writes one case version: content per language, sealed, evidence chunks + index, zip, then the meta. */
export const seedCase = async (
  repos: { cases: CaseRepository; chunks: EvidenceChunkRepository },
  input: { id: string; version?: number; status?: CaseStatus; langs?: CaseLang[]; files?: SeedFile[]; zip?: Uint8Array },
): Promise<{ meta: CaseMeta; index: EvidenceEntry[] }> => {
  const version = input.version ?? 1;
  const langs = input.langs ?? ["en"];
  for (const lang of langs) await repos.cases.putContent(input.id, version, lang, contentFixture(input.id, lang));
  await repos.cases.putSealed(input.id, version, sealedFixture(input.id));
  const index: EvidenceEntry[] = [];
  for (const file of input.files ?? []) {
    const stored = await repos.chunks.putFile(file.bytes);
    index.push({ path: file.path, format: file.format ?? "log", size: stored.size, sha256: stored.sha256, chunks: stored.chunks, explorer: true });
  }
  await repos.cases.putEvidenceIndex(input.id, version, index);
  if (input.zip) {
    const stored = await repos.chunks.putFile(input.zip);
    await repos.cases.putEvidenceZip(input.id, version, { path: `${input.id}-evidence.zip`, format: "zip", size: stored.size, sha256: stored.sha256, chunks: stored.chunks, explorer: false });
  }
  const meta = metaFixture(input.id, { version, status: input.status ?? "published", langs });
  const current = await repos.cases.getMeta(input.id);
  const saved = await repos.cases.saveMeta(meta, current?.etag ?? null);
  if (!saved) throw new Error(`meta write for ${input.id} lost a race`);
  return { meta, index };
};
