# IncidentLab API

Accounts, server-side answer checking, the daily schedule, stats and the live admin view. Implemented
as one Netlify Function (`site/netlify/functions/api.mts`, mounted at `/api/*`) over `site/server/`
(Controller -> Service -> Repository). The contract (zod schemas + types) is `site/shared/contract.ts`;
both the browser and the function import it.

## Conventions

- Request and response bodies are JSON. POST/PUT bodies must send `content-type: application/json` (otherwise 415) and be at most 4 KB (64 KB for the schedule, 512 KB to start an upload; otherwise 413). The upload chunk and part PUTs are the exception: raw `application/octet-stream` bodies.
- Every response carries `cache-control: no-store`, except the two public DB-content routes below
  (`GET /api/cases`, `GET /api/cases/:caseId/content`), which carry no account data and are cacheable, and the
  three public polling routes in "CDN-cached public GETs".

## CDN-cached public GETs (#140)

`GET /api/event`, `GET /api/today` and `GET /api/leaderboard[?caseId=]` return the same body to every caller
and never read or set the session. Every open tab polls them, so Netlify's CDN serves them
(`controllers/http.ts` `publicJson`) and cached hits never invoke the function. That matters because the free
plan allows 125,000 function calls a month.

| Route | `Netlify-CDN-Cache-Control` | Tag | Purged by |
|---|---|---|---|
| `/api/event` | `public, durable, max-age=10, stale-while-revalidate=20` | `event` | `PUT /api/admin/event` |
| `/api/leaderboard` | `public, durable, max-age=10, stale-while-revalidate=20` | `leaderboard` | `PUT /api/admin/event` (freeze) |
| `/api/today` | `max-age` and `stale-while-revalidate` up to 60 s each, capped at the seconds left until midnight in the schedule's time zone | `today` | `PUT /api/admin/schedule` |

- Browsers get `Cache-Control: public, max-age=0, must-revalidate`, so they always ask the CDN.
- `Netlify-Vary: query`: the cache key is the URL and its query string, never the cookie.
- Purges go through `services/CachePurger.ts`. In production that is Netlify's `purgeCache`; tests and the local
  server use a no-op. A failed purge is logged, and the old copy lives until its max-age.
- Changes nobody purges (answers moving the leaderboard, a case being published) show within 10 s for the
  leaderboard and 60 s for today.
- **Clock:** a cached `serverTime` can be up to about 30 s old. The client (`src/lib/clock.ts`) takes the server
  clock from responses the origin answered: their `Date` header, or `/api/event`'s `serverTime` when its
  `Cache-Status` is not a hit. A cached `/api/event` counts only when its `Age` header is present.
- **Event poll:** the client (`src/lib/event.ts`) polls `/api/event` every 30 s while an event is running or
  starts within an hour, every 2 minutes otherwise. It doesn't poll at all while the tab is hidden, and polls
  once when the tab comes back.
- Errors are non-2xx with body `{ "error": string, "code"?: string, "retryAfterSeconds"?: number, "details"?: string[] }` (`details` lists every failed check of a rejected upload). Status codes: 400 validation, 401 signed out, 403 forbidden (see codes), 404, 405, 409 conflict (username taken, already finished, no more hints, concurrent update: retry), 413, 415, 429 rate limit (also sends `Retry-After`), 500 `{"error":"internal"}`, 503 admin disabled.
- Error codes the UI acts on: `signed-out`, `bad-credentials`, `username-taken`, `reserved`, `bad-invite-code`, `pending`, `rejected`, `admin`, `password-change-required`, `not-today`, `event-closed`, `locked`, `unknown-case`, `unknown-command`, `rate-limited`.

## Accounts and sessions

- Usernames are 3–24 chars (unicode letters, digits, `.`, `_`, `-`; no spaces) and **unique case-insensitively** (NFKC + lowercase). Uniqueness is enforced with a conditional write on a username index, so two simultaneous sign-ups can't both win.
- Passwords: 8–128 chars, stored as `scrypt` (N=16384, r=8, p=1, per-user salt). Login always runs scrypt, even for unknown usernames.
- New accounts are `pending`. They can sign in and see `/api/me`, but every `/api/cases/*` route returns 403 `pending` until the instructor approves them. `rejected` accounts can't sign in.
- The session is an opaque random token in the cookie `il_session` (`HttpOnly; SameSite=Lax; Path=/api; Secure`; 30 days, renewed when under 15 days remain). The store keeps `sha256(token)` only. Logout deletes the session; rejecting or deleting an account kills all of its sessions.
- CSRF: SameSite=Lax plus JSON-only bodies (a cross-site form can't send `application/json`).
- **Admin sign-in:** username `admin` with the `ADMIN_KEY` as password creates an admin session (12 h, ended
  when the key rotates). It works on every admin route instead of the `X-Admin-Key` header, and it can't
  play. Reserved usernames: `admin`, `administrator`, `root`, `instructor`, `system`.
- **Class code:** when the admin sets an invite code, sign-ups that send it are approved immediately.
- **Password reset:** the admin gets a one-time temporary password; the account is signed out and must
  set a new password (`POST /api/me/password`) before playing.

## Paid content and scoring

Hint texts and full toolbox commands are never in the public case content (`GET /api/cases/:id/content`
serves the package's `content.<lang>.json`, which has them removed), and the site bundle carries no case at all
(`scripts/check-bundle.mjs` fails the build otherwise). The browser only has each command's `syntax`. The server returns paid content in `progress.unlocked` only after charging for it, and
everything once the case is completed.

Per stage: `max(0, base − hints − 5×commands − min(20, 2×wrong))` + time bonus (+30 within the stage's
target time, fading linearly to 0 at 3× the target) + 10 for a clean solve (no hints, commands or wrong
answers) + 15 first blood (first solver of that stage; reset with the case). Per case: +50 when all six
stages are solved without revealing an answer. A revealed stage scores 0. `maxScore` is par (every stage
at base + 30 + 10, plus 50); first blood can push a score above par. Each solved stage stores its
`breakdown`, and the answer the player typed (trimmed) as `solvedAnswer` (#133; null for stages solved before
it). Only the player gets `solvedAnswer`, in their own `no-store` progress responses: the admin live view blanks
it, and no public or CDN-cached response carries stage records. Constants: `SCORING` in `site/shared/contract.ts`.

## Endpoints

### Public and player

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/api/auth/register` | none | `{username, password}` | 201 `{account}` + cookie |
| POST | `/api/auth/login` | none | `{username, password}` | `{account}` + cookie |
| POST | `/api/auth/logout` | cookie | `{}` | 204, clears the cookie |
| GET | `/api/me` | cookie | | `{account}` (401 when signed out) |
| GET | `/api/session` | optional cookie | | `{account}` or `{account: null}`, always 200. The browser uses this to probe sign-in without logging a 401. |
| GET | `/api/me/stats` | cookie | | `{stats: UserStats}` |
| GET | `/api/today` | none | | `{date, timezone, caseId, lockToToday, releasedCaseIds}` |
| GET | `/api/cases/:caseId/progress` | approved | | `{progress}` (first call creates the record, so the admin sees the player at "setup") |
| POST | `/api/cases/:caseId/setup-done` | approved | `{}` | `{progress}` (q1 becomes active; idempotent) |
| POST | `/api/cases/:caseId/answer` | approved | `{questionId, answer}` | `{correct, progress}` |
| POST | `/api/cases/:caseId/hint` | approved | `{questionId}` | `{progress}` (`hintsRevealed` +1) |
| POST | `/api/cases/:caseId/reveal` | approved | `{questionId}` | `{progress}` (0 points, `revealedAnswer` set, next stage active) |
| POST | `/api/cases/:caseId/reveal-command` | approved | `{toolId}` | `{progress}` (−5 on the active stage; free if already paid or the case is done) |
| GET | `/api/cases/:caseId/debrief?lang=en\|he` | approved | | `{markdown}`, 403 until every stage is finished |
| POST | `/api/me/password` | cookie | `{currentPassword, newPassword}` | `{account}` + fresh cookie (other sessions end) |
| GET | `/api/event` | none | | `{event, serverTime}` |
| GET | `/api/leaderboard?caseId=` | none | | `{caseId, frozen, frozenAt, generatedAt, entries}` (approved players; overall without caseId) |

### DB-stored case content (#64)

Served only from the `case:` records (see Storage). Since #68 this is the only source of case content:
the browser loads the catalog and every case from here, and the router treats an id that is not in
`GET /api/cases` as unknown. Only a case's `publishedVersion`, and only while its status is `published`, is
visible; drafts, older versions and trashed cases are 404.

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/cases` | none | `{cases: CatalogEntry[]}` (`site/shared/catalog.ts`; `file` is the case id, `version` the published version). `ETag` = hash of the body. |
| GET | `/api/cases/:caseId/content?lang=en\|he` | none | `{id, version, lang, content: CaseContent, evidence: {filesBase, zip}}` (`CaseContentResponseSchema` in `site/shared/case-records.ts`). `lang` is the one served: `he` falls back to `en`. `evidence` says where this version's evidence lives (below). The browser adds `&v=<version>` (ignored by the server) so its HTTP cache keeps one entry per version. `ETag` = `"<contentSha>-v<version>-<lang>"`. 400 for another `lang`, 404 unless published. |

Both send `Cache-Control: public, max-age=60, stale-while-revalidate=600` and answer `If-None-Match`
with 304. Errors (404, 400) stay `no-store`. These routes share the `/api/cases/:caseId/*` space with the
per-player routes above; `content` is the only action there that needs no session.

**Evidence location.** `evidence.filesBase` (ends in `/`; a file is `filesBase` + its URL-encoded path) and
`evidence.zip` come from `evidenceLocation()` in `site/server/services/evidenceStream.ts`, the one place that
decides where a published version's evidence is served. The browser follows these URLs only
(`site/src/content/evidence.ts`), so evidence can move to another host by changing that function; each file's
sha256 is in the version's evidence index.

**Evidence files** are not under `/api`: a Netlify Edge Function (`site/netlify/edge-functions/evidence.ts`,
logic in `site/server/services/evidenceStream.ts`) serves

| Path | Body |
|---|---|
| `/evidence/db/<caseId>/v<n>/files/<path>` | one evidence file (any size; 40 MB today) |
| `/evidence/db/<caseId>/v<n>.zip` | the prebuilt evidence zip (`content-disposition: attachment; filename="<caseId>-evidence.zip"`, the name the toolbox commands unzip) |

GET and HEAD. `Range: bytes=a-b` / `a-` / `-n` gives 206 with `Content-Range` (one range; a multi-range
or malformed header gets the whole file; past the end is 416). `ETag` is the file's SHA-256 and
`If-None-Match` gives 304; `If-Range` is honoured. `Cache-Control: public, max-age=31536000, immutable`
(the URL carries the version), `Content-Type` from the extension (text types are `text/plain`, so a file
never renders as a page), `X-Content-Type-Options: nosniff` and a sandbox CSP. Unknown, unpublished or
non-current versions are 404 `no-store`. The function is not bound by the Function payload limits (about
6 MB buffered, 20 MB streamed): it streams the 4 MiB chunks from Blobs in order, one read ahead.

**Caching and `netlify.toml`.** Netlify applies `[[headers]]` rules only to files it serves itself, not to
Function or Edge Function responses. So the `/api/*` `no-store` rule never reached function responses;
each route sets its own `Cache-Control` (`http.ts` defaults to `no-store`). The CDN may cache the two
content routes for 60 s (they vary only by URL, including `?lang`). The Edge Function does not opt in
to CDN caching (`cache = "manual"` is unset), so its responses are cached by browsers only.

### Author: upload, publish, rollback, delete (#66)

Contract: `site/shared/author-contract.ts`. Every `/api/author/*` route takes the admin (`X-Admin-Key`
header, as the CLI sends it, or the admin session) or an approved author session (`requireAuthor`:
`403 not-author` for players, `401` signed out). An author acts only on cases whose `createdBy` is their
account id (`403 not-owner`); the admin acts on any case. A new case id becomes the uploader's; an
author cannot upload a version of a case they do not own (`403 not-owner`; the original cases are owned by
`admin`). (`409 id-taken` guards ids of the test-only static cases, see `createApp`'s `staticSecrets`.) Every mutation except the single chunk and part
PUTs is audited (`case.upload`, `case.draft`, `case.publish`, `case.rollback`, `case.delete`,
`case.restore`; the detail names the author).

A package travels in pieces so every body stays at or under 4 MiB (the Function limit is about 6 MB):
evidence files and `evidence.zip` as content-addressed chunks, the small entries as named parts.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/author/uploads` | `{manifest, evidenceZip: {sha256, size}}` (≤ 512 KB) | 201 `{uploadId, caseId, expiresAt, chunkBytes, missingChunks: [{sha256, index}], parts}`. Chunks already stored (any case, any version) are not listed: re-POSTing after a failure is how an upload resumes. 413 `too-large` (over 100 MiB of evidence) or `too-many-files` (over 500); 409 `trashed`; 429 (30 per uploader per hour). |
| PUT | `/api/author/uploads/:uploadId/chunks/:sha256/:index` | raw bytes, `application/octet-stream`, exactly the chunk's size (4 MiB, the last one shorter) | `{stored, fileComplete, verified}`. Idempotent: a stored chunk is never overwritten. When a file's last chunk arrives the whole file is hashed; a mismatch drops its chunks and answers 422 `sha-mismatch`. 400 `chunk-size`, 413 above 4 MiB, 415 another content type. |
| PUT | `/api/author/uploads/:uploadId/parts/:name` | raw bytes (≤ 1 MiB) | `{name, size}`. Names: `content.en.json`, `content.he.json` (only for manifest languages), `sealed.answers.json`, `sealed.hints.json`, `sealed.commands.json`, `sealed.scoring.json`, `sealed.debrief.en.md`, `sealed.debrief.he.md` (the package entry with `/` as `.`); 400 `part-not-allowed` otherwise. |
| POST | `/api/author/uploads/:uploadId/finalize` | `{}` | `{caseId, version, status: "draft", diff}`. Runs the package checks of `validatePackageParts()` (schemas, cross-checks, the answer-leak scan of the public content against the sealed answers, hint texts and commands), checks every chunk is stored and every file's sha256, then writes version `latestVersion + 1` as a **draft**. 422 `invalid-package` / 409 `missing-parts` / `missing-chunks` with `details`; 422 `sha-mismatch`. A repeated finalize returns the same result. |
| GET | `/api/author/cases` | | `{cases: AuthorCase[]}`: the cases the caller may manage (trashed ones included), each with every version and its state (`published`, `draft`, `previous`). |
| POST | `/api/author/cases/:caseId/publish` | `{version, acceptAnswerChanges?}` | `{caseId, publishedVersion, previousVersion, rollback, changed}`. Rollback is publishing an older version. 409 `answer-drift` (below), `conflict` (another publish won: the meta is written with `setIfMatch`), `trashed`, `incomplete-version`; 404 unknown version. |
| DELETE | `/api/author/cases/:caseId` | | `{caseId, trashId, expiresAt}`: soft delete. Every public route answers 404 at once; the records stay. |
| POST | `/api/author/cases/:caseId/restore` | `{}` | `{caseId, status}`: back to `published` or `draft`. The admin can also restore it from `/api/admin/trash`. 404 after the 7 days. |

`diff` (finalize) compares with the published version: `contentChanged` (`"<lang>:<path>"`, at most 200,
`contentTruncated`), `evidenceAdded`/`Removed`/`Changed` (paths), `evidenceZipChanged` and
`answerFingerprintChanged` (null when there is nothing to compare).

**Answer drift.** The answer fingerprint (`site/shared/answer-fingerprint.ts`, identical to
`answer_fingerprint()` in `scripts/make_flags.py`) hashes the answers, points, hint costs and target
times. Publishing a version whose fingerprint differs from the published one (before a case's first DB
publish: from a test-only static answer key, if any) while any `progress:<caseId>:*` record exists is refused with
409 `answer-drift`, unless `acceptAnswerChanges` is true. This is the rule `deploy.sh` enforces. It
matters because a published version is what the game checks answers against: `CaseSecretsProvider` reads
the answer keys of the published DB cases only (since #68), and a publish, rollback, delete or restore reloads it at once
on the instance that served it (other instances within a minute).

Unfinished uploads expire after 24 h; starting an upload sweeps expired `upload:` records. Evidence chunks
are never deleted by a case delete, because versions and cases share them (a later garbage collection
may reclaim unreferenced ones). CLI: `scripts/data.ts upload` (see `docs/CASE_CONTRACT.md`).

### Admin (`X-Admin-Key: <ADMIN_KEY>` or the `admin` session cookie)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/admin/accounts` | | `{generatedAt, accounts: UserStats[]}` (every account with stats and rank; cached 2 s) |
| POST | `/api/admin/accounts/:id/approve` | `{}` | `{account}` |
| POST | `/api/admin/accounts/:id/reject` | `{}` | `{account}` (the player sees the "not approved" screen; can't sign in again) |
| DELETE | `/api/admin/accounts/:id` | | 204 (soft delete: account + progress go to the trash for 7 days; sessions end; username freed) |
| GET | `/api/admin/progress?caseId=` | | `{generatedAt, caseId, players: AdminProgress[]}` |
| DELETE | `/api/admin/progress/:accountId/:caseId` | | 204 (restart one player's case) |
| POST | `/api/admin/reset` | `{confirm:"RESET", caseId?}` | 204 (wipe progress for one case or all; accounts stay) |
| GET | `/api/admin/schedule` | | `{schedule}` |
| PUT | `/api/admin/schedule` | `Schedule` | `{schedule}` (case ids must be released; time zone must be valid) |
| GET | `/api/admin/stats` | | `{generatedAt, cases: CaseSummary[]}` |
| POST | `/api/admin/accounts/:id/reset-password` | `{}` | `{temporaryPassword}` |
| PUT | `/api/admin/accounts/:id/role` | admin | `{role: "player"\|"author"}` | `{account}`; audited as `account.role`. Authors may manage cases they created (the Author routes above). |
| POST | `/api/admin/accounts/approve-all` | `{}` | `{approved}` |
| GET/PUT | `/api/admin/settings` | `{inviteCode}` | `{settings}` |
| GET/PUT | `/api/admin/event` | `LiveEvent` | `{event, serverTime}` (window, freeze, announcement; `enforceWindow` refuses answers, hints and reveals outside it) |
| GET | `/api/admin/export.csv` | | CSV, one row per account per opened case |
| GET | `/api/admin/audit?limit=` | | `{entries}` newest first (every admin mutation is recorded) |
| GET | `/api/admin/trash` | | `{entries}` soft-deleted accounts, cases and progress resets, newest first (expire after 7 days) |
| POST | `/api/admin/trash/:id/restore` | `{}` | `{restored, skipped}` (never overwrites newer data; 409 `conflict` if the account or username exists again, or the case is no longer deleted) |

## Schedule ("incident of the day")

`Schedule = { timezone, defaultCaseId, days: {"YYYY-MM-DD": caseId}, lockToToday }`. "Today" is the
date in `timezone` (default `Asia/Jerusalem`). Today's case is `days[today] ?? defaultCaseId`. With
`lockToToday`, only today's case can be **started**; a case the player already opened stays playable,
so nobody is cut off at midnight.

## Rules

- Stages are sequential: setup, then q1 to q6, then the debrief. Acting on a locked stage returns 403. Acting on a finished stage returns 409, except that re-answering a solved stage returns `correct:true` without re-scoring and re-revealing a revealed stage returns the current progress.
- Score for a solved stage = `max(0, points - sum(cost of the first hintsRevealed hints))`. Points and hint costs come from the case JSON (copied into the secrets by `scripts/make_flags.py`).
- Rate limits: 5 wrong answers per account per question per 60 s; 8 failed logins per username and 60 per IP per 15 min; 100 sign-ups per IP per hour (classrooms share a NAT IP).
- Writes use optimistic concurrency (Blobs etags, up to 3 retries), so parallel requests for one player stay consistent.

## Storage

Rules for changing stored data, backups, restores and migrations: see `docs/DATA.md`.


One Netlify Blobs store, `incidentlab-v2`, with key prefixes: `account:`, `username:` (index),
`session:`, `progress:<caseId>:<accountId>`, `config:schedule`, `config:settings`, `config:event`,
`firstblood:<caseId>:<questionId>`, `audit:<iso>:<rand>`, `ratelimit:`, and for DB-stored cases `case:`,
`evidence:` and `upload:` (shapes in `docs/DATA.md`). Records written before scoring v2
still parse (new fields have defaults); stages solved before it keep their points. The pre-accounts store
`incidentlab-players` is no longer read.

## Environment

| Var | Meaning |
|---|---|
| `ADMIN_KEY` | Admin secret. If it is unset or shorter than 16 chars, every admin route returns 503 `admin disabled`. |
| `INCIDENTLAB_STORE` | Set to `memory` to use the in-process stores, JSON and bytes (tests and local work; data is lost on restart). Otherwise Netlify Blobs. |

Answers, debriefs, hint texts, commands and points are read from the published case versions in Blobs (`case:<id>:v<n>:sealed`), refreshed at most once a minute per instance and at once after a publish on the instance that served it. `site/server/generated/secrets.json` (written by the pipeline) is a build artefact for the checks only: no runtime code imports it (`server/test/handler.test.ts` checks), and it must never be imported from `site/src`.

## Tests

- `cd site && npm run test:server`: node:test over the real router with the in-memory store.
- `node --experimental-strip-types tests/local-server.ts [port] [--seed-db-case] [--no-cases]`: the built site + API on http://localhost:8888 (in-memory store). At startup it uploads and publishes every `build/packages/*.case.zip` through the upload API, so the local store has every case; `--seed-db-case` adds the `db-demo` fixture case.
- `node tests/smoke-api.mjs <baseUrl> [adminKeyFile] [caseId]` and `node tests/load.mjs <baseUrl> [players] [adminKeyFile] [caseId]` against a running deployment.
