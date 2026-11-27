// Migration 003 (open access, #171/#175): approves pending accounts and backfills score summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScoreRecordSchema } from "../domain/score.ts";
import { MIGRATIONS } from "../migrations/index.ts";
import { readLedger, runMigrations } from "../migrations/runner.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { takeSnapshot } from "../services/BackupService.ts";
import { AccountResponseSchema } from "../../shared/contract.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const summaryOf = async (kv: KvStore, id: string) => ScoreRecordSchema.parse((await kv.get(`score:${id}`))?.data);

test("migration 003 approves pending accounts and backfills summaries; dry run, apply, second run", async () => {
  const kv = new InMemoryKvStore();
  const account = (id: string, username: string, status: string) => ({
    id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status, sessionEpoch: 0,
    createdAt: "2026-11-01T00:00:00Z", decidedAt: null, lastSeenAt: null, lastLoginAt: null,
  }); // the round-2 shape: no schemaVersion, kind, showOnGlobalBoard, role
  const stage = (status: string, points: number, finishedAt: string | null, firstBlood = 0) => ({
    status, startedAt: "2026-11-02T10:00:00Z", finishedAt, hintsRevealed: 0, wrongAttempts: 0, points, revealedAnswer: null,
    ...(firstBlood > 0 ? { commandsRevealed: 0, breakdown: { base: points, hints: 0, commands: 0, wrong: 0, time: 0, clean: 0, firstBlood, total: points, solveSeconds: 5, targetSeconds: 600 } } : {}),
  });
  const locked = { status: "locked", startedAt: null, finishedAt: null, hintsRevealed: 0, wrongAttempts: 0, points: 0, revealedAnswer: null };
  await kv.set("account:AAAAAAAAAAAA", account("AAAAAAAAAAAA", "Old", "approved"));
  await kv.set("account:PPPPPPPPPPPP", account("PPPPPPPPPPPP", "Waiting", "pending"));
  await kv.set("account:RRRRRRRRRRRR", account("RRRRRRRRRRRR", "Nope", "rejected"));
  await kv.set("progress:alpha:AAAAAAAAAAAA", {
    accountId: "AAAAAAAAAAAA", caseId: "alpha", startedAt: "2026-11-02T10:00:00Z", lastSeenAt: "2026-11-02T10:00:00Z",
    setupDoneAt: "2026-11-02T10:00:00Z", completedAt: null, wrongAnswerTimestamps: {},
    stages: { q1: stage("solved", 120, "2026-11-02T10:05:00Z", 15), q2: stage("revealed", 0, "2026-11-02T10:06:00Z"), q3: stage("solved", 80, "2026-11-02T10:09:00Z"), q4: { ...locked, status: "active" }, q5: locked, q6: locked },
  });
  await kv.set("progress:beta:PPPPPPPPPPPP", {
    accountId: "PPPPPPPPPPPP", caseId: "beta", startedAt: "2026-11-02T10:00:00Z", lastSeenAt: "2026-11-02T10:00:00Z",
    setupDoneAt: null, completedAt: null, wrongAnswerTimestamps: {}, stages: {},
  });
  await kv.set("score:RRRRRRRRRRRR", { garbage: true });
  const only003 = MIGRATIONS.filter((m) => m.id === "003-open-access");
  assert.equal(only003.length, 1);

  const before = await takeSnapshot(kv, { source: "t", now: new Date(0) });
  const dry = await runMigrations({ kv, legacy: null, migrations: only003, dryRun: true });
  assert.equal(dry.results[0]?.changed, 3, "1 approval + 2 summaries (the garbage summary is skipped)");
  assert.deepEqual((await takeSnapshot(kv, { source: "t", now: new Date(0) })).entries, before.entries, "a dry run writes nothing");

  const applied = await runMigrations({ kv, legacy: null, migrations: only003, dryRun: false, now: () => new Date("2026-11-28T08:00:00Z") });
  assert.equal(applied.results[0]?.note, "1 approved, 2 score summaries written");
  const waiting = (await kv.get("account:PPPPPPPPPPPP"))?.data as Record<string, unknown>;
  assert.deepEqual([waiting["status"], waiting["decidedAt"]], ["approved", "2026-11-28T08:00:00.000Z"]);
  assert.equal(((await kv.get("account:RRRRRRRRRRRR"))?.data as Record<string, unknown>)["status"], "rejected");
  assert.equal(((await kv.get("account:AAAAAAAAAAAA"))?.data as Record<string, unknown>)["showOnGlobalBoard"], undefined, "opt-in stays off (default false)");
  const old = await summaryOf(kv, "AAAAAAAAAAAA");
  assert.deepEqual([old.total, old.stagesSolved, old.firstBloods, old.casesCompleted, old.lastSolveAt], [200, 2, 1, 0, "2026-11-02T10:09:00Z"]);
  assert.deepEqual((await summaryOf(kv, "PPPPPPPPPPPP")).cases, {});
  assert.deepEqual((await kv.get("score:RRRRRRRRRRRR"))?.data, { garbage: true }, "unparseable data is left alone");
  assert.equal((await kv.listKeys("globalboard:")).length, 0, "nobody is put on the public board");
  assert.ok((await readLedger(kv)).applied.some((a) => a.id === "003-open-access"));

  // Second run: the ledger skips it, and running the step itself again changes nothing.
  const afterApply = await takeSnapshot(kv, { source: "t", now: new Date(0) });
  assert.equal((await runMigrations({ kv, legacy: null, migrations: only003, dryRun: false })).results.length, 0);
  const migration = only003[0];
  assert.ok(migration);
  const again = await migration.run({ kv, legacy: null, now: () => new Date("2026-11-29T00:00:00Z"), dryRun: false, log: () => undefined });
  assert.equal(again.changed, 0);
  const afterSecond = await takeSnapshot(kv, { source: "t", now: new Date(0) });
  assert.deepEqual(afterSecond.entries, afterApply.entries, "the second run is a no-op");
});

test("migration 003 writes the same summary the live game keeps", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const player = harness.client();
  await player.call("/auth/register", { body: { username: "Live", password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await player.call("/cases/alpha/setup-done", { body: {} });
  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  await expectStatus(player.call("/cases/alpha/reveal", { body: { questionId: "q2" } }), 200);
  const live = await summaryOf(kv, id);
  await kv.delete(`score:${id}`);
  await runMigrations({ kv, legacy: null, migrations: MIGRATIONS.filter((m) => m.id === "003-open-access"), dryRun: false });
  assert.deepEqual(await summaryOf(kv, id), live);
});
