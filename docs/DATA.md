# Production data: rules and runbook

IncidentLab's state lives in Netlify Blobs. Treat it as production data: no code change, deploy or admin
click may lose it. This document is the contract for anyone changing stored records.

## Where the data is

| Store | What | Notes |
|---|---|---|
| `incidentlab-v2` | Live data: `account:`, `username:`, `session:`, `progress:<case>:<account>`, `score:<account>`, `globalboard:<account>`, `class:`, `classcode:`, `classmember:`, `memberof:` (#179), `config:*` (schedule, settings, event, migrations ledger), `firstblood:`, `audit:`, `trash:`, `legacy:`, `ratelimit:`, `case:`, `evidence:` (binary), `upload:` | Never rename. A new name means an empty store. That's how round-1 players were orphaned. |
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
- **A class event night (#181)**: 60 players for 2 hours, a projector and every player polling the class board
  (`/api/classboard/<token>`) every 10 s.
  - Uncached, the board alone would cost 61 clients × 6 polls a minute × 120 minutes = **43,920 calls**: a third
    of the month in one night.
  - CDN-cached (`publicJson`, 10 s plus 20 s stale-while-revalidate, durable), it costs at most one call per
    10 s window per distinct URL: 7,200 s / 10 s = **720 calls** for the overall board, and 720 more for each
    `?caseId=` variant in use. Budget **1,440** for two URLs.
  - The rest of the night: `/api/event` polling (CDN-cached) about **720**; gameplay (`no-store`: sign-in, the
    case page, setup, about 12 answers, a few hints and command reveals, reloads) about 30 calls a player, so
    **1,800**; a class admin's live-progress view (`no-store`, the later UI) polled every 15 s, **480**.
  - **Total about 4,500 calls a night**, so the 125,000 allowance covers roughly **25 class nights a month** with
    room for daily play. Solves never purge the board (a purge per answer would add a call per solve); class edits
    do, and they are rare.
  - Storage reads per uncached board call: one `classmember:` listing plus up to 60 member, 60 account and 60
    `score:` reads (181). Blobs operations are not one of the allowances above; they cost function runtime
    (milliseconds each), not calls.
- **Private cases (#184)** add no polling, and no call for most visits. `GET /api/session` (already called once
  per page load) carries a `privateCases` hint from the in-memory case list: no storage read when there are no
  private cases, at most one `memberof:` listing otherwise. Only when it is true does the browser call
  `GET /api/me/cases` (`no-store`), once per page load or sign-in. Private content is `no-store` too: a call per
  case open, for the few players who can see one. Public content stays CDN-cached.
- **Scale check (#185).** `tests/load/seed-scale.ts` fills an in-memory store with a public-site-sized data set:
  2,000 accounts (200 guests, 563 opted in to the global board), 20 cases with 9,369 progress records and a
  `score:` summary per account, and 100 classes of 10 to 60 members (3,490 memberships). `tests/load/scale-check.ts`
  then calls the app directly, as a CDN miss would, and counts the store operations per call:

  | Call | Who, how often | Store gets | Listings | Time (in-memory) |
  |---|---|---:|---:|---:|
  | `GET /api/leaderboard` | public, CDN-cached 10 s | 1,129 | 1 | 42 ms |
  | `GET /api/leaderboard?caseId=` (same instance, within 10 s) | public, CDN-cached | 1 | 0 | 2 ms |
  | `GET /api/classboard/<token>` (a full class of 60) | public, CDN-cached 10 s per URL | 181 | 1 | 9 ms |
  | `GET /api/me/stats` (first call on an instance) | player, `no-store`, per home or stats view | 1,152 | 1 | 26 ms |
  | `GET /api/me/stats` (same instance, within 10 s) | player, `no-store` | 24 | 0 | 3 ms |
  | `GET /api/classes` (member of 4 classes) | player, `no-store`, Classes page | 14 | 1 | 3 ms |
  | `GET /api/admin/users?limit=50` | owner, `no-store`, on demand | 4,477 | 2 | 113 ms |
  | `GET /api/admin/users?q=` (same instance, within 2 s) | owner, on demand | 351 | 1 | 22 ms |
  | `GET /api/admin/accounts` (what the console polled every 5 s before #185) | scripts only now | 11,370 | 2 | 388 ms |
  | `GET /api/admin/classes` | owner, `no-store`, on demand | 200 | 101 | 56 ms |
  | `GET /api/admin/progress?caseId=` (650 players on the case) | owner, Live polls it every 5 s | 1,300 | 1 | 21 ms |

  Reads are the measure, not time: the in-memory store answers in microseconds, while each Blobs read is a
  request inside the function's runtime (tens of milliseconds, 10 at a time), so 1,000 reads is about 2 s of a
  call. What #185 changed:
  - the console no longer polls the users list. Before, an open console tab cost one function call and 11,370
    reads every 5 s (about 720 calls an hour, whatever section was on screen). Now only Live and the site
    announcement poll; Users, Classes, Stats and Audit load when opened, searched or refreshed. The users list
    reads accounts and summaries (2 s cache) and only the shown page's progress;
  - Live's progress reads only the accounts on the case (was every account on every 5 s poll);
  - the opted-in players behind the leaderboard and every player's rank are shared for 10 s per instance
    (`BoardCache`), cleared by any write on that instance that changes the board. A warm instance answers
    `/api/me/stats` in 24 reads instead of 1,152, and the leaderboard's `?caseId=` variants share one read. The
    first call on a cold instance still reads the opted-in set: it grows with opt-ins, not with all accounts.
  `site/server/test/scale.test.ts` runs the check in CI with a read budget per call (`READ_BUDGET` in
  `tests/load/scale-check.ts`), so a change that brings back a full scan on one of these paths fails the build.
  Print the table with `node --experimental-strip-types tests/load/scale-check.ts`.
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

Private cases and owner review (#184), all additive with zod defaults:
- `visibility` (`public` or `private`, default `public`): who may see the live version (`docs/API.md`, DB-stored
  case content). **No migration:** a meta stored before #184 has no `visibility`, so it parses as `public`, which
  is exactly what every case published until then was. Authors' drafts stored before #184 parse as public too,
  but they are not live, and an author's publish of a case that was never published makes it private. New author
  uploads store `private` from the start.
- `review` (`none`, `submitted`, `approved` or `rejected`, default `none`), `reviewNote` and `reviewAt` (default
  null): the owner's review.
- `classIds` (default `[]`, at most 20): classes whose active members may play the case while it is private.
- `pendingVersion` (default null): an author's new version of a public case, waiting for re-review, while the
  public `publishedVersion` stays live. Must be a stored version.
- `evidenceKey` (default null; 32 hex characters): the private evidence URL segment, set at the first private
  publish. Server-only: it is in no public response and not in `GET /api/author/cases`.

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

### Audit (`audit:<isoTimestamp>:<random>`)

`AuditEntrySchema` in `site/shared/contract.ts`: `{at, action, target, detail, via}` plus `actor` (#185, additive,
default null): `"admin"` for the site owner (key or session) or the acting account's id. Entries written before
#185 parse with `actor: null`. The weekly hygiene job deletes entries older than 90 days.

### Classes (`class:`, `classcode:`, `classmember:`, `memberof:`, since #179)

Schemas in `site/server/domain/classes.ts`, storage in `site/server/repositories/class-repository.ts`. All four
prefixes are new (additive) and every field has a default, so a record from the first release still parses.

| Key | Holds | Notes |
|---|---|---|
| `class:<classId>` | `ClassRecord`: `schemaVersion, id, name, ownerId, createdAt, updatedAt, status (active\|archived), joinMode (code\|approval), memberLimit (60), boardToken, joinCode, schedule {timezone, defaultCaseId, days}, event {name, startsAt, endsAt, freezeAt, announcement}, caseIds ([] = any public case)` | Edits are read, change, `setIfMatch` (retried 3 times). `ownerId` is an account id, or `admin` for classes the site owner made (Class 1). `joinCode` is kept in plain text because class admins are shown it; it is a shareable invite, not a secret like a password. `boardToken` is `<classId>.<random>`, so the board (#181) needs no token index. |
| `classcode:<sha256(normalized code)>` | `{classId}` | The join-code index, claimed with `onlyIfNew` (a collision picks another code). Rotating writes the new entry, then the class, then deletes the old entry. A join checks that the class's current code hashes to the key, so a stale entry left by a crash opens nothing (and is deleted). |
| `classmember:<classId>:<accountId>` | `{role (member\|admin), status (pending\|active), isOwner, joinedAt, decidedAt}` | **Authoritative.** Permission checks read it; the member cap counts its keys (one listing, at most `memberLimit` keys). Removing a member deletes it. |
| `memberof:<accountId>:<classId>` | `{role, status, isOwner}` | The reverse index: "my classes" and the owned-class count list this prefix, with no scan. |

**Class boards and scoring windows (#180, #181)** add no keys. The class board reads the class, lists
`classmember:<classId>:` (at most `memberLimit` records) and reads each active member's `account:` (username only)
and `score:` summary; the class's first solver per case and question is re-derived from the solve times in those
summaries. Class live progress reads only the active members' `progress:<caseId>:<member>` records. A class's
`schedule`, `event` and `caseIds` decide what counts on its board, never whether anyone may play.

**Keeping the two membership indexes consistent.** There are no transactions, so the order is fixed and every
gap repairs itself:
- writes (join, approve, role change, restore) go forward first, then reverse; deletes (remove, leave, account
  delete) also go forward first, so access ends at once, then reverse;
- a forward row without its reverse (a crash in between) still grants access; the member's next read of the
  class, or a repeated join, rewrites the reverse row;
- a reverse row without its forward row (or one that differs) is dropped or rewritten by `GET /api/classes`;
- caps are enforced by write-then-count: a join or create writes its record, counts, and removes its own record if
  the count is over the limit. The last writer always sees every kept record, so the cap can't be exceeded
  (tested with concurrent joins and creates).

**Deleting a class is archiving it** (the soft delete chosen over the `trash:` pattern). Archiving keeps every
record: the class, its members and its code index. It only stops joins and edits. There is no hard delete and
no 7-day expiry, so a restore (owner or site admin) can't conflict with newer data, and a trash bundle never has
to carry up to 60 memberships. Archived classes don't count toward the owner's limit; restoring one does.

**Account deletes** (admin delete and the hygiene job's idle-guest delete, which share the path) read the
account's memberships first, store them in the `trash:` bundle (`memberships`, default `[]`), then remove both
index rows of each. A restore puts them back in both indexes for classes that still exist, keeping any row that
exists again. It ignores the member cap, because the site admin chose to bring the account back. The classes an
account owned stay; their `ownerId` points at the deleted account until the restore, and meanwhile only co-admins
and the site admin can manage them.

**Migration 004 (`004-default-class`).** It turns today's single class into "Class 1" (`class:DefaultClass`,
owned by `admin`):
- the class gets copies of `config:schedule` (without `lockToToday`) and `config:event` (without
  `enforceWindow`);
- its join code is `config:settings.inviteCode` (or a generated code when none is set), with join mode `code`;
- every approved user account becomes an active member, and `memberLimit` is 60 or that count, whichever is
  more.

`config:*` stay as they are. Since #180 they no longer gate play: `config:schedule` is the global case of the day
(the daily card and streaks), `config:event` the site announcement, global event clock and global-board freeze;
`lockToToday` and `enforceWindow` are kept in the records (additive) but unused. `config:settings.inviteCode` is
legacy too (#204): classes replaced the site invite code, sign-up resolves its optional code through `classcode:`
and joins that class, and the owner console no longer edits the setting. A stored code is still accepted at
sign-up (joining no class) and stays readable; nothing deletes it. The fixed id makes the migration
idempotent: a second run changes nothing, and a run that stopped halfway is finished by the next one.

## Weekly hygiene (#177)

Without a sweep, `session:`, `ratelimit:`, `audit:` and guest accounts grow forever. The scheduled function
`hygiene-weekly` (`site/netlify/functions/hygiene-weekly.mts`, `@weekly`) runs one pass of
`AccountHygieneService` (`site/server/services/AccountHygieneService.ts`). `scripts/data.ts gc-accounts` runs the
same pass by hand: a dry run that only reads and reports, then `--apply`, which takes a local backup first.

| What | Rule | How |
|---|---|---|
| Guests (`account:` with `kind: "guest"`) | `lastSeenAt` (or `createdAt`) 30 days ago or more | **Soft delete**, like an admin delete: one `trash:` entry of kind `account` (label `idle guest guest-<id>`) with the account and all its progress, then the records go, with its `score:` summary and any `globalboard:` marker (`ScoreService.remove`, the same path as an admin delete). Restorable from Recently deleted for 7 days; a restore re-derives the summary and doesn't claim a username (guests never hold one). Users are never touched. |
| `session:` | past `expiresAt` | deleted (authenticate() already refuses them) |
| `ratelimit:` | newest hit more than 24 h ago (the longest window, class creates, is 24 h) | deleted |
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
