// A tiny, valid case package built in memory (made-up answers, no real case data), shared by the
// package validator tests and the upload tests. `build()` returns the .case.zip bytes.
import { createHash } from "node:crypto";
import { EVIDENCE_CHUNK_BYTES } from "../../shared/case-records.ts";
import { writeZip } from "./zip-writer.ts";
import type { ZipInput } from "./zip-writer.ts";

export const ID = "fixture-case";
export const QIDS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
export const ANSWERS: Record<string, string> = {
  q1: "07:15:42", q2: "deadbee", q3: "fixture-role-x", q4: "order-99", q5: "12", q6: "widget-api",
};
export const HINT = (qid: string, n: number): string => `Fixture hint ${n} for ${qid}: grep the made-up log for it`;
export const COMMAND = "grep -c 'fixture pattern' fixture/app.log | sort -u";

export type Json = Record<string, unknown>;
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export interface Fixture {
  manifest: Json & { evidence: Json[] };
  content: Json & { questions: Json[] };
  evidence: Map<string, Uint8Array>;
  extra: ZipInput[];
}

export function fixture(id: string = ID): Fixture {
  const evidence = new Map<string, Uint8Array>([
    ["README_FIRST.txt", new TextEncoder().encode("Fixture evidence pack. Times are UTC.\n")],
    ["logs/app.log", new TextEncoder().encode("2026-01-01T00:00:00Z INFO fixture line\n".repeat(20))],
    ["pcap/capture.pcap", new Uint8Array(64).map((_, i) => (i * 7) & 0xff)],
  ]);
  const content = {
    id,
    title: "Fixture case",
    subtitle: "A tiny case for tests",
    difficulty: "easy",
    estMinutes: 30,
    tags: ["test"],
    inspiredBy: { title: "Nothing real", year: 2026, summary: "Made up for the test suite." },
    briefing: "Something broke. Find out what.",
    evidenceZip: `/evidence/${id}-evidence.zip`,
    evidence: [{ path: "logs/app.log", format: "text", description: "The app log." }],
    rules: ["Be kind."],
    questions: QIDS.map((id) => ({
      id,
      title: `Question ${id}`,
      prompt: `What happened in ${id}?`,
      answerFormat: "text",
      placeholder: "answer",
      points: id === "q6" ? 150 : 100,
      hints: [{ cost: 10 }, { cost: 20 }, { cost: 40 }],
      successNote: "Well done.",
    })),
    toolbox: [{ category: "grep", items: [{ id: "count", title: "Count lines", syntax: "grep -c <pattern> <file>", explain: "Counts." }] }],
    debrief: "_Sealed._ Finish all six stages to unlock the debrief.",
  };
  const manifest = {
    schemaVersion: 1,
    id,
    version: 1,
    langs: ["en"],
    evidence: [...evidence].map(([path, bytes]) => ({
      path,
      format: "text",
      size: bytes.length,
      sha256: sha256(bytes),
      chunks: Math.ceil(bytes.length / EVIDENCE_CHUNK_BYTES),
      explorer: !path.endsWith(".pcap"),
    })),
  };
  return { manifest, content, evidence, extra: [] };
}

export async function build(f: Fixture): Promise<Uint8Array> {
  const evidenceZip = await writeZip([...f.evidence].map(([path, data]) => ({ name: `${String(f.manifest["id"])}/${path}`, data })));
  const sealedQuestions = Object.fromEntries(QIDS.map((id) => [id, { points: id === "q6" ? 150 : 100, hintCosts: [10, 20, 40], targetSeconds: 300 }]));
  const hints = Object.fromEntries(QIDS.map((id) => [id, [1, 2, 3].map((n) => ({ en: HINT(id, n), he: null }))]));
  return writeZip([
    { name: "manifest.json", data: json(f.manifest) },
    { name: "content.en.json", data: json(f.content) },
    { name: "sealed/answers.json", data: json(ANSWERS) },
    { name: "sealed/hints.json", data: json(hints) },
    { name: "sealed/commands.json", data: json({ count: { command: COMMAND, powershell: null } }) },
    { name: "sealed/scoring.json", data: json({ title: f.content["title"], estMinutes: 30, questions: sealedQuestions }) },
    { name: "sealed/debrief.en.md", data: "# Debrief\n\nThe fixture story.\n" },
    { name: "evidence.zip", data: evidenceZip, method: 0 },
    ...[...f.evidence].map(([path, data]) => ({ name: `evidence/${path}`, data })),
    ...f.extra,
  ]);
}

