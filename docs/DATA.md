# Production data: rules and runbook

IncidentLab's state lives in Netlify Blobs. Treat it as production data: no code change, deploy or admin
click may lose it. This document is the contract for anyone changing stored records.

## Where the data is

| Store | What | Notes |
|---|---|---|
| `incidentlab-v2` | Live data: `account:`, `username:`, `session:`, `progress:<case>:<account>`, `config:*` (schedule, settings, event, migrations ledger), `firstblood:`, `audit:`, `trash:`, `legacy:`, `ratelimit:`, `case:`, `evidence:` (binary), `upload:` | Never rename. A new name means an empty store. That's how round-1 players were orphaned. |
| `incidentlab-backups` | `daily/<YYYY-MM-DD>.json` snapshots, 30 days | Written by the scheduled function `backup-daily` |
| `incidentlab-players` | Round-1 anonymous players (pre-accounts) | Read-only. Migration 002 copies it to `legacy:<id>` |
| `~/.incidentlab-backups/` (your machine) | Pre-deploy, pre-migrate, pre-restore and manual snapshots | Mode 600, never in the repo |

`session:`, `ratelimit:` and `upload:` keys are ephemeral and never backed up or restored. `evidence:` keys
are binary and are left out of the JSON snapshots too (see below).

### DB-stored cases (`case:`, `evidence:` and `upload:`, since #64 and #66)

Written through `CaseRepository` / `EvidenceChunkRepository` (`site/server/repositories/case-repository.ts`)
with the schemas in `site/shared/case-records.ts`. Every read is validated; a corrupt record is logged and
treated as missing, never thrown. The author upload routes (#66, `docs/API.md`) write them.

**Since #68 these records are the only source of case content.** The five original cases were uploaded to
production as v1 with `scripts/data.ts upload --publish` (each answer fingerprint equal to the old bundled key),
and the site and the function no longer carry any case: released case ids and answer keys come from the published
versions, and the browser reads content and evidence only through the content API. So:
- a deploy never changes a case; a new case or a content fix is a new package version, uploaded and published;
- trashing a published case takes it off the site and out of play at once (nothing falls back to a bundle);
- a restore of a JSON snapshot restores `case:` records but not `evidence:` chunks, so re-upload the packages of
  any case whose chunks are gone (uploads skip chunks that are already stored);
- local and CI stores are filled the same way: `tests/local-server.ts` uploads every `build/packages/*.case.zip`
  through the upload API at startup.

| Key | Holds | Notes |
|---|---|---|
| `case:<id>:meta` | `CaseMeta` | One per case, written with `setIfMatch` (concurrent finalizes and publishes cannot overwrite each other). Fields below. |
| `case:<id>:v<n>:content:<lang>` | `CaseContent` | Public content per language (`en`, `he`); no hint texts or runnable commands. |
| `case:<id>:v<n>:sealed` | `CaseSealed` | Server-only: answers, hint texts, commands, debriefs, scoring. |
| `case:<id>:v<n>:evidence-index` | `EvidenceEntry[]` | Every evidence file: path, size, sha256, chunk count. |
| `case:<id>:v<n>:evidence-zip` | `EvidenceEntry` | The prebuilt evidence zip. |
| `evidence:<sha256>:<chunk#>` | raw bytes | 4 MiB chunks (`EVIDENCE_CHUNK_BYTES`), the last one shorter. Content-addressed: identical files share chunks across cases and versions. Binary, through `ByteStore` (`site/server/repositories/ByteStore.ts`), not `KvStore`. |

| `upload:<uploadId>` | `UploadRecord` | An upload in progress (`site/server/repositories/upload-repository.ts`): owner, manifest, evidence zip, `expiresAt` (24 h), and after finalize the draft version and diff. |
| `upload:<uploadId>:verified:<sha256>` | `{at}` | This file's stored chunks hashed to its sha256 during this upload. |
| `upload:<uploadId>:part:<name>` | raw bytes | One named part (content JSON, sealed parts, debriefs), at most 1 MiB. Deleted after finalize. |

**`CaseMeta` fields** (schemaVersion 2 since #66; draft and published are separate):
- `publishedVersion` (number or null): the version public routes and the evidence Edge Function serve,
  only while `status` is `published`; null until the first publish.
- `latestVersion`: the highest stored version, drafts included. An upload's finalize writes `latestVersion + 1`
  as a draft; publishing sets `publishedVersion`; a rollback publishes an older one.
- `status`: `draft` (nothing published yet), `published`, or `trashed` (soft-deleted; restore puts back the
  previous status).
- `versions`: every stored version with its `langs`, `title`, `difficulty`, `tags`, `answerFingerprint`,
  `contentSha`, `createdBy`, `createdAt`, `evidenceFiles` and `evidenceBytes`.
- `createdBy`: the case owner, the account id of the author who first uploaded the id, or `admin`. Authors
  may only manage their own cases. `createdAt`, `updatedAt`.
- `version`, `langs`, `title`, `difficulty`, `tags`, `answerFingerprint`, `contentSha` describe
  `publishedVersion` (or `latestVersion` while nothing is published). They are kept so the #64 readers keep
  working.

Metas written by #64 have only `version`: they still parse, as `publishedVersion = version` (null for a
`draft`), `latestVersion = version` and one entry in `versions` (`server/test/case-schema.test.ts`).

Versioned keys are immutable once written: a change is a new version. `evidence:` chunks are **not** in
JSON snapshots (they are binary, and rebuilt from the case package), so a restore never touches them,
even with `--prune`. Neither are `upload:` keys: they expire after 24 hours, and starting an upload sweeps
expired ones.

**Deleting a case** is soft: its meta becomes `trashed` (every public route answers 404), a `trash:` entry
of kind `case` records the status to restore, and nothing else is removed. After the 7 days the trash entry
goes and the case stays trashed. Evidence chunks are never deleted on delete, because cases and versions
share them. `scripts/data.ts gc-evidence` (`EvidenceGcService`, #122) reclaims chunks that no case version
(of any status) and no live upload references, such as chunks from abandoned uploads.

Their input is the **case package** (`build/packages/<id>-v<n>.case.zip`, format in `docs/CASE_CONTRACT.md`).
Packages are build artefacts: `scripts/build-all.sh` writes and validates them under the gitignored `build/`.
They contain the answer keys, so they are never committed, deployed or put under `site/`.

## Rules for changing stored records

1. **Additive only.** New fields get a zod `.default(...)`, so every record already stored still parses.
   Records carry `schemaVersion` (`site/server/domain/types.ts`).
2. **Expand, migrate, contract.**
   1. Ship code that reads the old and new shapes.
   2. Run a migration that rewrites records.
   3. Only in a later release, remove the old-shape code.
3. **Migrations** live in `site/server/migrations/index.ts`:
   - numbered (`NNN-name`) and idempotent;
   - conditional writes (`setIfMatch`) so live traffic wins races;
   - never delete or rename keys.
   - Never edit or remove one that ran in production: the `config:migrations` ledger has it.
   - Every migration gets a test with fixture records from older versions (`server/test/data-safety.test.ts`).
4. **Deletes are soft.** Deleting an account or a case and resetting progress all write a `trash:` entry first. It can
   be restored from the admin panel for 7 days (Recently deleted). Restores never overwrite newer data.
5. **Answer keys are data too.** Changing a released case's answers, points or hint costs re-scores players
   mid-case. `deploy.sh` refuses such a deploy unless you reset the case or pass `--accept-answer-changes`, and
   publishing an uploaded version refuses the same change (409 `answer-drift`) unless `acceptAnswerChanges` is set.

## Runbook

All commands run from the repo root and need `~/.netlify-token` (or `NETLIFY_AUTH_TOKEN`) and the linked
site (`.netlify/state.json`). Everything is a dry run unless you pass `--apply`.

```bash
# Snapshot production to ~/.incidentlab-backups/ (read-only on production)
node --experimental-strip-types scripts/data.ts backup

# Daily snapshots kept in the backup store
node --experimental-strip-types scripts/data.ts list-backups

# What would a restore change? (dry run), then do it (takes a pre-restore backup first)
node --experimental-strip-types scripts/data.ts restore ~/.incidentlab-backups/<file>.json
node --experimental-strip-types scripts/data.ts restore daily/2026-11-25.json --apply
#   --prune also deletes keys created after the snapshot (exact rollback). Use with care.

# Evidence chunks no case version or live upload uses (#122): dry run, then apply (pre-gc backup first;
# refuses while an upload is in progress, and stops if any evidence record is unreadable)
node --experimental-strip-types scripts/data.ts gc-evidence
node --experimental-strip-types scripts/data.ts gc-evidence --apply

# Pending migrations: dry run, then apply (takes a pre-migrate backup first)
node --experimental-strip-types scripts/data.ts migrate
node --experimental-strip-types scripts/data.ts migrate --apply
```

`./scripts/deploy.sh` does the safe sequence for you:
1. Build, including all tests and solvers.
2. Check for answer-key drift.
3. **Back up production, and abort if the backup fails.**
4. Deploy.
5. Check migrations; apply them only with `--migrate`.

## Recovering from a bad deploy

1. `scripts/data.ts list-backups` and the files in `~/.incidentlab-backups/`: pick the last good snapshot
   (the `pre-deploy` one from the bad deploy is ideal).
2. `scripts/data.ts restore <snapshot>` (dry run). Read the add/overwrite list.
3. Redeploy the previous good commit (`git checkout <sha> && ./scripts/deploy.sh`), then
   `scripts/data.ts restore <snapshot> --apply`.
4. Add `--prune` only if keys written by the bad version must go.

## Tests

`cd site && npm run test:server` covers:
- migrations: idempotency, dry runs, the legacy import;
- the backup → wipe → restore round trip (with and without prune);
- daily rotation;
- soft delete and restore, including conflict and expiry;
- the shared case schemas against the real case files and `secrets.json` (a build artefact; the function never
  imports it, which `handler.test.ts` checks), and answer normalization against the shared vectors.

CI runs them on every PR.
