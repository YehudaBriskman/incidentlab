# Production data: rules and runbook

IncidentLab's state lives in Netlify Blobs. Treat it as production data: no code change, deploy or admin
click may lose it. This document is the contract for anyone changing stored records.

## Where the data is

| Store | What | Notes |
|---|---|---|
| `incidentlab-v2` | Live data: `account:`, `username:`, `session:`, `progress:<case>:<account>`, `score:<account>`, `globalboard:<account>`, `config:*` (schedule, settings, event, migrations ledger), `firstblood:`, `audit:`, `trash:`, `legacy:`, `ratelimit:`, `case:`, `evidence:` (binary), `upload:` | Never rename. A new name means an empty store. That's how round-1 players were orphaned. |
| `incidentlab-backups` | `daily/<YYYY-MM-DD>.json` snapshots, 30 days | Written by the scheduled function `backup-daily` |
| `incidentlab-players` | Round-1 anonymous players (pre-accounts) | Read-only. Migration 002 copies it to `legacy:<id>` |
| `~/.incidentlab-backups/` (your machine) | Pre-deploy, pre-migrate, pre-restore and manual snapshots | Mode 600, never in the repo |

`session:`, `ratelimit:` and `upload:` keys are ephemeral and never backed up or restored. `evidence:` keys
are binary and are left out of the JSON snapshots too (see below).

## Where each kind of data belongs (placement policy, #143)

The rule: **private or changing data → Netlify Blobs; public, versioned and large → GitHub.** The site repo
is public, so anything placed on GitHub is public too.

| Data | Home | Why |
|---|---|---|
| Accounts, sessions, progress, scores, first bloods, audit, schedule, event, settings | Netlify Blobs (`incidentlab-v2`) | private, changes constantly |
| Answer keys, paid hints and commands, sealed debriefs, case content | Netlify Blobs (`case:`; the only source since #68) | secret, versioned together with its answers |
| Evidence files and zips | Netlify Blobs chunks (`evidence:`), served by the Edge Function `/evidence/db/*` and cached at the CDN (#141) | 88 MB in total today (largest file 40 MB) |
| Lab images (lab mode, #146) | GHCR under the `incidentslab` org | public images cost nothing and have no pull-rate limit. Docker Hub limits pulls per IP, which a class behind one NAT would hit. |
| Lab material (Dockerfiles, devcontainers, lab docs) | `incidentslab/lab-*` repos | public, contains no answers |
| Evidence on GitHub Pages or Releases | **deferred** (#145) | move only when a trigger below fires |

Every evidence URL comes from one place: `evidenceLocation()` in `site/server/services/evidenceStream.ts` (the
content API hands it to `site/src/content/evidence.ts`). Moving evidence to another host is a server change.
It also needs a CSP `connect-src` entry and CORS from the new host: Pages sends CORS headers, Releases don't,
so Releases suit zip downloads only.

**Never publish** anything built from `build/truth/`, `build/packages/`, `site/server/generated/secrets.json`,
`solutions/` or `content-sealed/`. Images and releases are built only from the public evidence zip, in a clean
build context (lab mode adds a gate that compares an image's `/case` with the zip, file by file and sha256 by
sha256).

## Capacity budget (zero-cost hosting)

The account is on Netlify's **legacy Free plan** (verified 2026-11-26). **Never accept the switch to
credit-based pricing**: it charges credits per production deploy and per GB, and it can't be undone.

| Monthly allowance | Limit | Main users |
|---|---|---|
| Bandwidth | 100 GB | the app, evidence downloads |
| Function calls (`/api`) | 125,000 | every uncached API request |
| Function runtime | 100 GB-hours | the same requests |
| Edge function calls | 1,000,000 | evidence requests the CDN hasn't cached yet |
| Build minutes | 300 | unused: builds are local and deploys use the CLI |

- **Function calls are the binding limit.** Every open tab polls `/api/event`.
  - **Before #140:** a 2-hour class of 30 players cost about 11,000 calls (about 10 classes a month), and a
    forgotten tab about 2,900 a day.
  - **Since #140:**
    - `/api/event`, `/api/today` and `/api/leaderboard` are CDN-cached (`docs/API.md`);
    - the poll pauses in hidden tabs and slows to 2 minutes when no event is live;
    - a class costs about 1,500 calls and idle tabs about 0.
  - **Keep it that way:**
    - any new polled endpoint must be public and use `publicJson`, or stay off a timer;
    - personalised routes stay `no-store`.
- **Check monthly:** `node --experimental-strip-types scripts/data.ts usage`. It prints bandwidth with a 70%
  warning. The API doesn't report function counts on this plan, so check those in the Netlify UI (Team → Usage).
- **Triggers to move public evidence to GitHub (#145):** Netlify bandwidth over about 50 GB a month, or total
  evidence over about 500 MB.

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

### Score summaries and the opt-in board (`score:`, `globalboard:`, since #175)

| Key | Holds | Notes |
|---|---|---|
| `score:<accountId>` | `ScoreRecord` (`site/server/domain/score.ts`) | `{total, stagesSolved, casesCompleted, firstBloods, lastSolveAt}` plus `cases`: per case, every solved stage with its points and solve time, and the completion bonus with its time. Always derived from the account's progress records. `ScoreService` re-derives a case's part after each solve or reveal, admin reset, account delete and trash restore. It writes with `setIfMatch` and re-reads the progress record after the summary, so retries and races can't double-count. |
| `globalboard:<accountId>` | `{accountId, since}` | Exists only while the account opts in (`PUT /api/me/board`). The public board lists this prefix and reads only those accounts and their summaries. |

The account's `showOnGlobalBoard` flag is the player's choice. The board also checks that the account is
approved and not a guest, so a rejected or guest account never shows even if a marker is left behind.
Migration 003 backfills `score:` for every account. Accounts that have no summary yet get one when they opt in.

### Accounts (`account:<id>`, `username:<sha256(key)>`)

`AccountRecordSchema` in `site/server/domain/types.ts`. The open-access fields (#172) are additive, with defaults:
- `kind` (`user` or `guest`, default `user`), `showOnGlobalBoard` (default false), `classLimit` (default null).
- `recoveryCodeHash` (#174, default null): the scrypt hash (same format as `passwordHash`) of the account's
  recovery code, normalized (upper case, no spaces or dashes). The plain code is returned once, by sign-up, by
  the first sign-in of an account that has none, by `POST /api/auth/recover` and by
  `POST /api/me/recovery-code`; it is never stored, logged or returned again. Neither hash is in any response.
- `status`: since #173 sign-ups are `approved` at once (`decidedAt` = `createdAt`). `pending` remains for
  accounts from before it (migration 003 approves them); `rejected` blocks sign-in and recovery.
- A recovery bumps `sessionEpoch` (every session ends), clears `mustChangePassword` and replaces the code.

## Weekly hygiene (#177)

Without a sweep, `session:`, `ratelimit:`, `audit:` and guest accounts grow forever. The scheduled function
`hygiene-weekly` (`site/netlify/functions/hygiene-weekly.mts`, `@weekly`) runs one pass of
`AccountHygieneService` (`site/server/services/AccountHygieneService.ts`). `scripts/data.ts gc-accounts` runs the
same pass by hand: a dry run that only reads and reports, then `--apply`, which takes a local backup first.

| What | Rule | How |
|---|---|---|
| Guests (`account:` with `kind: "guest"`) | `lastSeenAt` (or `createdAt`) 30 days ago or more | **Soft delete**, like an admin delete: one `trash:` entry of kind `account` (label `idle guest guest-<id>`) with the account and all its progress, then the records go, with its `score:` summary and any `globalboard:` marker (`ScoreService.remove`, the same path as an admin delete). Restorable from Recently deleted for 7 days; a restore re-derives the summary and doesn't claim a username (guests never hold one). Users are never touched. |
| `session:` | past `expiresAt` | deleted (authenticate() already refuses them) |
| `ratelimit:` | newest hit more than 24 h ago (the longest window is 1 h) | deleted |
| `audit:` | key timestamp older than 90 days | deleted; keys that don't start with a timestamp are left alone |
| `trash:` | past the 7-day restore window | deleted (Recently deleted drops them too, but only when someone opens it) |

A restored guest still has its old `lastSeenAt`, so the next weekly run trashes it again unless it plays.
Cost: one listing per prefix plus one read per `account:`, `session:` and `ratelimit:` key, once a week. It
never runs on a request path, so it doesn't touch the function-call budget.

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

# Weekly hygiene by hand (#177): idle guests to the trash, expired sessions and rate limits, old audit and
# expired trash. Dry run, then apply (pre-gc-accounts backup first). The scheduled function does this weekly.
node --experimental-strip-types scripts/data.ts gc-accounts
node --experimental-strip-types scripts/data.ts gc-accounts --apply

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
- the weekly hygiene pass: idle guests trashed and restorable, active guests and users kept, expired sessions,
  stale rate limits, old audit and expired trash swept, and a dry run that changes nothing (`hygiene.test.ts`);
- the shared case schemas against the real case files and `secrets.json` (a build artefact; the function never
  imports it, which `handler.test.ts` checks), and answer normalization against the shared vectors.

CI runs them on every PR.
