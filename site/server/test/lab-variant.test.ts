// The lab command variant (#149): `syntaxLab` is free, `lab` is paid like `command`. It must be stripped from
// public content, default to null in older sealed records, unlock with the item's single reveal, and fail both
// leak checks (the case-package scan and scripts/check-bundle.mjs) when planted in public content.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ToolItemSchema } from "../../shared/case.ts";
import { CaseSealedSchema, PublicToolItemSchema, stripPaidContent } from "../../shared/case-records.ts";
import { packageFileName, validateCasePackage } from "../../shared/case-package.ts";
import { AccountResponseSchema, ProgressResponseSchema } from "../../shared/contract.ts";
import { ID, LAB_COMMAND, build, fixture } from "./package-fixture.ts";
import { sealedFixture } from "./case-fixtures.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const CHECK_BUNDLE = fileURLToPath(new URL("../../../scripts/check-bundle.mjs", import.meta.url));
const PLANTED = "tcpdump -nn -r pcap/planted-capture.pcap 'icmp' | head -5";

const authoredItem = {
  id: "pcap-icmp",
  title: "ICMP in the capture",
  syntax: "grep -n '<protocol>' <capture-text>",
  syntaxLab: "tcpdump -nn -r <capture.pcap> '<filter>'",
  command: "grep -n 'ICMP' pcap/planted-capture.txt",
  lab: PLANTED,
  explain: "Reads the capture.",
};

test("stripPaidContent drops `lab` and keeps the free `syntaxLab`", () => {
  const raw = { toolbox: [{ category: "pcap", items: [authoredItem] }] };
  const stripped = stripPaidContent(raw) as { toolbox: { items: Record<string, unknown>[] }[] };
  const item = stripped.toolbox[0]?.items[0];
  assert.ok(item);
  assert.equal("lab" in item, false);
  assert.equal(item["syntaxLab"], authoredItem.syntaxLab);
  assert.ok(ToolItemSchema.safeParse(authoredItem).success);
});

test("the strict public tool schema rejects a lab command", () => {
  const { command: _c, ...withLab } = authoredItem;
  assert.equal(PublicToolItemSchema.safeParse(withLab).success, false);
  const { lab: _l, ...free } = withLab;
  assert.equal(PublicToolItemSchema.safeParse(free).success, true);
});

test("sealed records written before #149 parse with lab = null (additive)", () => {
  const old = { ...sealedFixture("old-case"), tools: { t: { command: "grep ERROR app.log", powershell: null } } };
  const parsed = CaseSealedSchema.parse(old);
  assert.equal(parsed.tools["t"]?.lab, null);
});

test("one reveal unlocks the lab variant too, at the same single charge", async () => {
  const harness = createHarness();
  const player = harness.client();
  await player.call("/auth/register", { body: { username: "Labber", password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await player.call("/cases/alpha/progress");
  await player.call("/cases/alpha/setup-done", { body: {} });

  const before = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(before.progress.unlocked.commands["grep-5xx"], undefined, "no lab command before the reveal");
  const after = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx" } }), ProgressResponseSchema);
  const unlocked = after.progress.unlocked.commands["grep-5xx"];
  assert.equal(unlocked?.lab, "jq -r 'select(.status >= 500) | .path' access.jsonl");
  assert.equal(after.progress.stages.q1.commandsRevealed, 1);
});

test("case package: a lab command planted in public content fails the leak scan", async () => {
  const clean = await validateCasePackage(await build(fixture()), { fileName: packageFileName(ID, 1) });
  assert.deepEqual(clean.errors, []);
  const f = fixture();
  f.content["briefing"] = `Run this in the lab: ${LAB_COMMAND}`;
  const report = await validateCasePackage(await build(f), { fileName: packageFileName(ID, 1) });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /contains the lab command of tool count/.test(e)), report.errors.join("\n"));
});

/** Runs scripts/check-bundle.mjs on a tiny fake dist whose JS chunk holds `chunk`. */
function checkBundle(chunk: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "il-check-bundle-"));
  try {
    const dist = join(dir, "dist");
    const cases = join(dir, "cases");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(cases);
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>IncidentLab</title>");
    writeFileSync(join(dist, "assets", "toolbox.js"), chunk);
    writeFileSync(join(cases, "planted-case.json"), JSON.stringify({ id: "planted-case", questions: [], toolbox: [{ category: "pcap", items: [authoredItem] }] }));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ cases: {} }));
    const run = spawnSync(process.execPath, [CHECK_BUNDLE], {
      env: { ...process.env, CHECK_BUNDLE_DIST: dist, CHECK_BUNDLE_CASES: cases, CHECK_BUNDLE_SECRETS: join(dir, "secrets.json") },
      encoding: "utf8",
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("check-bundle: a lab command planted in the bundle fails, its free syntax does not", () => {
  const clean = checkBundle(`export const syntax = ${JSON.stringify(authoredItem.syntaxLab)};`);
  assert.equal(clean.status, 0, clean.output);
  const leaked = checkBundle(`export const cmd = ${JSON.stringify(PLANTED)};`);
  assert.equal(leaked.status, 1, leaked.output);
  assert.match(leaked.output, /PAID planted-case\.json lab pcap-icmp/);
});
