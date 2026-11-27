# IncidentLab API

Accounts, server-side answer checking, the daily schedule, stats and the live admin view. Implemented
as one Netlify Function (`site/netlify/functions/api.mts`, mounted at `/api/*`) over `site/server/`
(Controller -> Service -> Repository). The contract (zod schemas + types) is `site/shared/contract.ts`;
both the browser and the function import it.

## Conventions

- Request and response bodies are JSON. POST/PUT bodies must send `content-type: application/json` (otherwise 415) and be at most 4 KB (64 KB for the schedule, 512 KB to start an upload; otherwise 413). The upload chunk and part PUTs are the exception: raw `application/octet-stream` bodies.
- Every response carries `cache-control: no-store`, except the two public DB-content routes below
  (`GET /api/cases`, `GET /api/cases/:caseId/content`), which carry no account data and are cacheable, and the
  public polling routes in "CDN-cached public GETs" (including the class board).

## CDN-cached public GETs (#140)

`GET /api/event`, `GET /api/today` and `GET /api/leaderboard[?caseId=]` return the same body to every caller
and never read or set the session. Every open tab polls them, so Netlify's CDN serves them
(`controllers/http.ts` `publicJson`) and cached hits never invoke the function. That matters because the free
plan allows 125,000 function calls a month.

| Route | `Netlify-CDN-Cache-Control` | Tag | Purged by |
|---|---|---|---|
| `/api/event` | `public, durable, max-age=10, stale-while-revalidate=20` | `event` | `PUT /api/admin/event` |
| `/api/leaderboard` | `public, durable, max-age=10, stale-while-revalidate=20` | `leaderboard` | `PUT /api/admin/event` (freeze), `PUT /api/me/board` (a player opts in or out) |
| `/api/today` | `max-age` and `stale-while-revalidate` up to 60 s each, capped at the seconds left until midnight in the schedule's time zone | `today` | `PUT /api/admin/schedule` |
| `/api/classboard/:boardToken` (#181) | `public, durable, max-age=10, stale-while-revalidate=20` | `class:<classId>` | every class edit: `PATCH`, archive, restore, join-code and board-token rotation, an active join, approve, remove, leave. Solves don't purge it. |

- Browsers get `Cache-Control: public, max-age=0, must-revalidate`, so they always ask the CDN.
- `Netlify-Vary: query`: the cache key is the URL and its query string, never the cookie.
- Purges go through `services/CachePurger.ts`. In production that is Netlify's `purgeCache`; tests and the local
  server use a no-op. A failed purge is logged, and the old copy lives until its max-age.
- Changes nobody purges (answers moving the leaderboard or a class board, a case being published) show within
  10 s for the boards and 60 s for today. Solves never purge: a purge per correct answer would add an API call per
  solve on a class night, while the 10 s window already bounds how stale a board can be.
- **Clock:** a cached `serverTime` can be up to about 30 s old. The client (`src/lib/clock.ts`) takes the server
  clock from responses the origin answered: their `Date` header, or `/api/event`'s `serverTime` when its
  `Cache-Status` is not a hit. A cached `/api/event` counts only when its `Age` header is present.
- **Event poll:** the client (`src/lib/event.ts`) polls `/api/event` every 30 s while an event is running or
  starts within an hour, every 2 minutes otherwise. It doesn't poll at all while the tab is hidden, and polls
  once when the tab comes back.
- Errors are non-2xx with body `{ "error": string, "code"?: string, "retryAfterSeconds"?: number, "details"?: string[] }` (`details` lists every failed check of a rejected upload). Status codes: 400 validation, 401 signed out, 403 forbidden (see codes), 404, 405, 409 conflict (username taken, already finished, no more hints, concurrent update: retry), 413, 415, 429 rate limit (also sends `Retry-After`), 500 `{"error":"internal"}`, 503 admin disabled.
- Error codes the UI acts on (also, for private cases and review, #184: `not-admin`, `not-published`, `already-public`, `not-submitted`): `signed-out`, `bad-credentials`, `bad-recovery-code`, `signup-refused`, `username-taken`, `reserved`, `bad-invite-code`, `pending`, `rejected`, `admin`, `password-change-required`, `locked`, `unknown-case`, `unknown-command`, `rate-limited`, and for classes (#179) `guest`, `not-class-admin`, `not-class-owner`, `class-limit`, `class-full`, `class-archived`, `owner-locked`, `pending-member`.

## Accounts and sessions

- Usernames are 3–24 chars (unicode letters, digits, `.`, `_`, `-`; no spaces) and **unique case-insensitively** (NFKC + lowercase). Uniqueness is enforced with a conditional write on a username index, so two simultaneous sign-ups can't both win.
- Passwords: 8–128 chars, stored as `scrypt` (N=16384, r=8, p=1, per-user salt). Login always runs scrypt, even for unknown usernames.
- **Open sign-up (#173):** new accounts are `approved` at once. Accounts from before it may still be `pending`: they can sign in and see `/api/me`, but every `/api/cases/*` route returns 403 `pending` until approved. `rejected` accounts can't sign in or recover.
- **Bot checks on sign-up (#173):** the form sends a hidden honeypot field `website` (people leave it empty) and `elapsedMs`, how long the form was open. A filled `website` or `elapsedMs` under 2000 gets a generic 400 `signup-refused`, which still counts against the IP limit. Both fields are optional, so older clients still work. Sign-ups are limited to 20 per IP per hour (429 `rate-limited`).
- The session is an opaque random token in the cookie `il_session` (`HttpOnly; SameSite=Lax; Path=/api; Secure`; 30 days, renewed when under 15 days remain). The store keeps `sha256(token)` only. Logout deletes the session; rejecting or deleting an account kills all of its sessions.
- CSRF: SameSite=Lax plus JSON-only bodies (a cross-site form can't send `application/json`).
- **Admin sign-in:** username `admin` with the `ADMIN_KEY` as password creates an admin session (12 h, ended
  when the key rotates). It works on every admin route instead of the `X-Admin-Key` header, and it can't
  play. Reserved usernames: `admin`, `administrator`, `root`, `instructor`, `system`.
- **Class code:** the admin's invite code no longer decides approval (everyone is approved). A sign-up that sends a wrong code still gets 400 `bad-invite-code`. Classes replace it in Phase 2.
- **Recovery code (#174):** 4 groups of 5 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`
  (`ABCDE-FGHJK-MNPQR-STUVW`; case, spaces and dashes are ignored when typed), stored only as a scrypt hash.
  The plain code is returned once: in the sign-up response, in the first sign-in response of an account that has
  none yet, by a recovery and by a regeneration. `POST /api/auth/recover` checks it like login checks a password
  (scrypt always runs, with a dummy hash for unknown names or accounts without a code; 401 `bad-recovery-code`
  either way) and is rate-limited like login: 60 failures per IP and 8 per username per 15 minutes, in their own
  buckets. A success sets the new password, ends every session, clears `mustChangePassword`, lifts a sign-in
  lockout and issues a new code; it sets no cookie.
- **Password reset:** the admin (the owner) gets a one-time temporary password; the account is signed out and
  must set a new password (`POST /api/me/password`) before playing. Nobody else can reset a password.
- **Guests (#176):** `POST /api/guest` gives a signed-out visitor a guest account (`kind: "guest"`, `approved`,
  role `player`, username `guest-<id>`) and a player session, so every approved-player route works. A guest has
  no password and its generated name is never claimed in the `username:` index, so login always refuses it
  (401 `bad-credentials`). If the cookie already holds a live session, the call returns that account (200) and
  creates nothing. Rate limited to 30 per IP per hour. `POST /api/auth/upgrade {username, password}` turns the
  signed-in guest into a user with the **same id**, so its progress stays: the name is claimed with the same
  race-free conditional write as register, the guest's other sessions end and a fresh cookie is set. It counts
  against the sign-up limit. 409 `username-taken`, `reserved` (also any `guest-` name) or `not-guest`.
  Guests are on no leaderboard. Idle guests are trashed after 30 days by the weekly hygiene job
  (`docs/DATA.md`). The upgrade response carries the account's one-time recovery code (`recoveryCode`), like a sign-up.

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
| POST | `/api/auth/register` | none | `{username, password, inviteCode?, website?, elapsedMs?}` | 201 `{account, recoveryCode}` + cookie |
| POST | `/api/auth/login` | none | `{username, password}` | `{account, recoveryCode?}` + cookie (`recoveryCode` only when this sign-in issued the account's first one) |
| POST | `/api/auth/recover` | none | `{username, recoveryCode, newPassword}` | `{recoveryCode}` (the new code; no cookie) |
| POST | `/api/auth/logout` | cookie | `{}` | 204, clears the cookie |
| POST | `/api/guest` | optional cookie | `{}` | 201 `{account}` + cookie (a new guest), or 200 `{account}` for an existing session |
| POST | `/api/auth/upgrade` | guest cookie | `{username, password}` | `{account}` + fresh cookie (same id, `kind: "user"`) |
| GET | `/api/me` | cookie | | `{account}` (401 when signed out) |
| GET | `/api/session` | optional cookie | | `{account, privateCases}` or `{account: null, privateCases: false}`, always 200. The browser uses this to probe sign-in without logging a 401. `privateCases` (#184) says the account may have private cases to play; only then does the browser call `GET /api/me/cases`. |
| GET | `/api/me/cases` | optional cookie | | `{cases: CatalogEntry[]}`, `no-store`: the live private cases this session may see (#184; the site admin: all of them). The browser merges them into its catalog. Signed out: `{cases: []}`. |
| GET | `/api/me/stats` | cookie | | `{stats: UserStats}`. `rank` is the place on the live overall public board, null when not on it; `onGlobalBoard` says whether the player opted in (#175). Reads only the player's own progress plus the opted-in players' score summaries. |
| PUT | `/api/me/board` | approved | `{show: boolean}` | `{account}` with `showOnGlobalBoard`. Opts in to or out of the public global leaderboard (off by default; your username and score become public). 403 `guest` for guests. Purges the `leaderboard` CDN tag. |
| GET | `/api/today` | none | | `{date, timezone, caseId, lockToToday, releasedCaseIds}` (`lockToToday` is deprecated: returned, never enforced) |
| GET | `/api/cases/:caseId/progress` | approved | | `{progress}` (first call creates the record, so the admin sees the player at "setup") |
| POST | `/api/cases/:caseId/setup-done` | approved | `{}` | `{progress}` (q1 becomes active; idempotent) |
| POST | `/api/cases/:caseId/answer` | approved | `{questionId, answer}` | `{correct, progress}` |
| POST | `/api/cases/:caseId/hint` | approved | `{questionId}` | `{progress}` (`hintsRevealed` +1) |
| POST | `/api/cases/:caseId/reveal` | approved | `{questionId}` | `{progress}` (0 points, `revealedAnswer` set, next stage active) |
| POST | `/api/cases/:caseId/reveal-command` | approved | `{toolId}` | `{progress}` (−5 on the active stage; free if already paid or the case is done) |
| GET | `/api/cases/:caseId/debrief?lang=en\|he` | approved | | `{markdown}`, 403 until every stage is finished |
| POST | `/api/me/password` | cookie | `{currentPassword, newPassword}` | `{account}` + fresh cookie (other sessions end) |
| POST | `/api/me/recovery-code` | cookie | `{currentPassword}` | `{recoveryCode}` (replaces the old code; 400 `bad-credentials`; wrong passwords count against the username's sign-in limit) |
| GET | `/api/event` | none | | `{event, serverTime}` |
| GET | `/api/leaderboard?caseId=` | none | | `{caseId, frozen, frozenAt, generatedAt, entries}` (overall without caseId). Lists only approved, non-guest players who opted in and solved a stage. Built from the `globalboard:` markers and those players' `score:` summaries, never from every account or progress record. The summaries keep each solve's time, so the frozen board needs no progress record either. |

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
with 304. Errors (404, 400) stay `no-store`.

**Private cases (#184).** A case whose meta says `visibility: "private"` is never in `GET /api/cases`, the
released ids (`/api/today`, schedules, other classes' assignments), the global leaderboard or a class board's
`caseIds`. Its `content` route answers only its author, the site admin and active members of an active class in
the case's `classIds`, with `Cache-Control: no-store` and no `ETag` (personalised: it never enters the CDN). Every
other caller gets the same 404 body as for an unknown id. The play routes (`progress`, `answer`, `hint`...) answer
404 `unknown-case` the same way. Membership is read live on each request, so removing a member or a class takes
effect at once. Private plays stay in the player's score summary but don't count on the global board; on a class
board they count when the class lists the case in its `caseIds`.

These routes share the `/api/cases/:caseId/*` space with the
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
| `/evidence/db/<caseId>/v<n>~<key>/files/<path>` and `/evidence/db/<caseId>/v<n>~<key>.zip` | the same for a **private** case (#184): `<key>` is the case's `evidenceKey` (32 hex characters, 128 random bits) |

**Private evidence and its residual risk.** The Edge Function can't check a session cheaply (a session, an
account and a membership read per evidence request, on the edge runtime), so for a private case the URL itself
is the capability: the plain `v<n>` URL answers 404, and only `v<n>~<key>` with the exact key serves. The key is
set at the case's first private publish and appears only in the member-checked, `no-store` content response. No
public response names a private case at all, and a public case never answers on a keyed URL. What remains: anyone
who was given the URL (a member who copies it, or a member removed later who kept it) can still download that
version's evidence, and the CDN may cache it under that URL. Evidence holds no answers or paid content, but treat
a private case's evidence as shared with whoever once had access.

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
`case.restore`, and since #184 `case.review-submit`, `case.classes`, `case.review-approve`, `case.review-reject`;
the detail names the author).

**Private cases and the owner's review (#184).** Authors are granted by the owner. An author's case is private
until the owner approves it (who may see one: DB-stored case content above).
- An author's publish of a case that is not public yet makes or keeps it private (`visibility: "private"` in the
  response). Only the site admin may pass `visibility` (403 `not-admin`); without it, the admin's publish keeps
  the case's visibility (a new admin case is public, as before).
- **Re-review:** an author's publish of another version of a case that is already public does not go live. It
  becomes the case's `pendingVersion`, submitted for review (`pendingReview: true`), and the public version stays
  live until the owner approves. A public case can't change under players without the owner seeing it first.
  The pending version's evidence isn't served meanwhile. A rejection drops it from review (it stays a stored
  version).
- Publishing privately again while a review is submitted resets the review to `none` (what was submitted
  changed), so the author submits again.

A package travels in pieces so every body stays at or under 4 MiB (the Function limit is about 6 MB):
evidence files and `evidence.zip` as content-addressed chunks, the small entries as named parts.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/author/uploads` | `{manifest, evidenceZip: {sha256, size}}` (≤ 512 KB) | 201 `{uploadId, caseId, expiresAt, chunkBytes, missingChunks: [{sha256, index}], parts}`. Chunks already stored (any case, any version) are not listed: re-POSTing after a failure is how an upload resumes. 413 `too-large` (over 100 MiB of evidence) or `too-many-files` (over 500); 409 `trashed`; 429 (30 per uploader per hour). |
| PUT | `/api/author/uploads/:uploadId/chunks/:sha256/:index` | raw bytes, `application/octet-stream`, exactly the chunk's size (4 MiB, the last one shorter) | `{stored, fileComplete, verified}`. Idempotent: a stored chunk is never overwritten. When a file's last chunk arrives the whole file is hashed; a mismatch drops its chunks and answers 422 `sha-mismatch`. 400 `chunk-size`, 413 above 4 MiB, 415 another content type. |
| PUT | `/api/author/uploads/:uploadId/parts/:name` | raw bytes (≤ 1 MiB) | `{name, size}`. Names: `content.en.json`, `content.he.json` (only for manifest languages), `sealed.answers.json`, `sealed.hints.json`, `sealed.commands.json`, `sealed.scoring.json`, `sealed.debrief.en.md`, `sealed.debrief.he.md` (the package entry with `/` as `.`); 400 `part-not-allowed` otherwise. |
| POST | `/api/author/uploads/:uploadId/finalize` | `{}` | `{caseId, version, status: "draft", diff}`. Runs the package checks of `validatePackageParts()` (schemas, cross-checks, the answer-leak scan of the public content against the sealed answers, hint texts and commands), checks every chunk is stored and every file's sha256, then writes version `latestVersion + 1` as a **draft**. 422 `invalid-package` / 409 `missing-parts` / `missing-chunks` with `details`; 422 `sha-mismatch`. A repeated finalize returns the same result. |
| GET | `/api/author/cases` | | `{cases: AuthorCase[]}`: the cases the caller may manage (trashed ones included), each with every version and its state (`published`, `draft`, `previous`, `pending`), and (#184) `visibility`, `review`, `reviewNote`, `reviewAt`, `classIds`, `pendingVersion`. Never the evidence key. |
| POST | `/api/author/cases/:caseId/publish` | `{version, acceptAnswerChanges?, visibility?}` | `{caseId, publishedVersion, previousVersion, rollback, changed, visibility, pendingReview}`. Rollback is publishing an older version. 409 `answer-drift` (below), `conflict` (another publish won: the meta is written with `setIfMatch`), `trashed`, `incomplete-version`; 404 unknown version; 403 `not-admin` for an author's `visibility`. |
| POST | `/api/author/cases/:caseId/submit-review` | `{}` | `{case: AuthorCase}` with `review: "submitted"` (idempotent). The owner reviews a private case at its published version, a public case at its `pendingVersion`. 409 `not-published` (publish privately first, to try it out), `already-public`, `trashed`. |
| PUT | `/api/author/cases/:caseId/classes` | `{classIds}` (at most 20) | `{case: AuthorCase}`: the classes whose active members may play the private case. Each class added must be an active class the author is an active admin of (403 `not-class-admin`); the admin may assign any existing class; removing needs no check. A class admin then adds the case to the class's `caseIds` (`PATCH /api/classes/:id`, which accepts a private case only for a class in its `classIds`) to put it on the class board. |
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
| GET/PUT | `/api/admin/event` | `LiveEvent` | `{event, serverTime}`: the site announcement and the global event clock; `freezeAt` freezes the global leaderboard. `enforceWindow` is deprecated: stored, never enforced (#180). |
| GET | `/api/admin/export.csv` | | CSV, one row per account per opened case |
| GET | `/api/admin/audit?limit=` | | `{entries}` newest first (every admin mutation is recorded) |
| GET | `/api/admin/trash` | | `{entries}` soft-deleted accounts, cases and progress resets, newest first (expire after 7 days) |
| POST | `/api/admin/trash/:id/restore` | `{}` | `{restored, skipped}` (never overwrites newer data; 409 `conflict` if the account or username exists again, or the case is no longer deleted) |
| GET | `/api/admin/reviews` | | `{reviews: ReviewItem[]}` (#184): cases waiting for the owner's review, oldest submission first: `caseId`, `title`, `createdBy`, `author` (username), `version` (the one to approve), `publishedVersion`, `visibility`, `langs`, `submittedAt`, `answerKeyChanged`. No answers. Authors get 403 `not-admin`. UI: `#/author/reviews`. |
| POST | `/api/admin/cases/:caseId/review` | `{decision: "approve" or "reject", note?, acceptAnswerChanges?}` | `{case: AuthorCase}`. Approve: the reviewed version becomes the public published version (`review: "approved"`), under the same answer-drift rule as a publish (409 `answer-drift` unless accepted). Reject: `note` is required (400 otherwise); `review: "rejected"`, the note reaches the author, a pending version is dropped and the case stays as it was. 409 `not-submitted` when nothing waits. Audited. |

### Classes (#179)

Classes are server-side only for now (the class UI is #182). **Gameplay never blocks on a class** (#180): a class's
case list, event window and freeze decide what counts on that class's board, never whether anyone may play. Every
class response is personalised (`no-store`), except the public class board (below). Contract: the "classes" section of `site/shared/contract.ts`. Implementation:
`ClassController` → `ClassService` → `ClassRepository`.

- **Who may call:** an approved full account (pending, rejected and forced-password-change accounts get the
  usual 403 codes), or the site admin (`X-Admin-Key` or the `admin` session), who passes every class check
  without being a member. Guests get 403 `guest` on create and join, an empty list, and 404 elsewhere.
- **Non-members get 404** on every `/api/classes/:id/*` route, the same as for an id that doesn't exist. Members
  who lack the right get 403 `not-class-admin` or `not-class-owner`.
- **Limits:** an account owns at most `account.classLimit ?? 3` active classes (409 `class-limit`; archived
  classes don't count, and restoring one counts again). Creates are limited to 10 per account per day (429). A
  class holds at most `memberLimit` (default 60) members, counting pending requests (409 `class-full`). The site
  admin sets both. Caps hold under concurrent requests: a create or join writes its record and then counts, and
  backs out if the count is over.
- **Join codes:** `ABCDE-FGHJK` (2 groups of 5 from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, about 49 bits); case,
  spaces and dashes don't matter. An unknown code, or the code of an archived class, is a generic 404. Wrong
  codes count against 30 per IP and 10 per account per hour (429); right codes never do, so a class behind one
  NAT can all join. Joining again is a no-op (200 with the current membership). In `joinMode: "code"` a joiner is
  `active` at once; in `"approval"` they are `pending` until a class admin approves.
- **Board token:** `<classId>.<32 base64url chars>`, unguessable, and rotatable by class admins. Only active
  members and admins get it. It is a capability: whoever has the URL sees the class board, with no cookie.
- **Class board** (`GET /api/classboard/:boardToken[?caseId=]`, #181): public and CDN-cached (above). The server
  reads the class id from the token, loads the class and compares the whole token in constant time; a malformed,
  unknown or rotated token, or an archived class, is a generic `404 {error: "not found"}` (no-store). The body is
  the `/api/leaderboard` shape (`caseId, frozen, frozenAt, generatedAt, entries`) plus `classId, className, event,
  caseIds`, so the leaderboard view renders it. It lists the class's **active** members (never pending or removed
  ones, and never guests) who have a counted solve, whether or not they opted in to the global board: members see
  each other on their class board by design, and stay off the global board unless they opt in. It reads one
  listing of `classmember:<classId>:` (at most `memberLimit` records) and each active member's account (username
  only) and `score:` summary: no progress record, no scan.
  - **What counts** (`server/domain/class-board.ts`): a solve of case C at time T counts when C is in `caseIds`
    (or `caseIds` is empty and C is published); when the class event has both `startsAt` and `endsAt`, when
    `startsAt <= T < endsAt`; and once now has reached `freezeAt`, when `T <= freezeAt` (then `frozen` is true).
    A completion bonus counts by `completedAt` under the same rules. The class's first solver of each case and
    question (the earliest counted solve; ties go to the lower account id) gets the first-blood bonus instead of
    the site-wide first solver, and `firstBloods` counts class first solves.
  - **Rotating the token** makes the old URL 404 at once at the origin and purges the CDN copy; if the purge
    fails, the old URL can still be served for at most the cache window: 10 s plus 20 s stale-while-revalidate.
- **Live progress** (`GET /api/classes/:id/progress?caseId=`, class admins and the site admin, no-store): each
  active member's progress on that case, the same view as the admin Live tab (`AdminProgress`: stage statuses,
  points, hints, wrong attempts; never the player's own answers or paid content). It reads only the members'
  `progress:<caseId>:<member>` records (at most `memberLimit`). Members who haven't opened the case are left out.
  400 without `caseId`, 404 `unknown-case` for an unknown one.
- **No class admin may reset a password** or see anything of an account beyond its username and (later) its class
  progress: a reset by a class admin would allow account takeover. Only the site admin resets passwords.
- **Archiving is the soft delete:** nothing is removed. An archived class takes no joins and no edits (409
  `class-archived`); members still see it and may leave; the owner or the site admin restores it.
- Every write is in the audit log (`class.*`, target = class id, detail ends with `by <username>`).

| Method | Path | Body | Who | Response |
|---|---|---|---|---|
| POST | `/api/classes` | `{name}` (1–60 chars) | approved user, site admin | 201 `{class: ClassDetail}`; the creator becomes the active owner admin (the site admin's classes are owned by `admin`, with no member row) |
| GET | `/api/classes` | | any player | `{classes: ClassSummary[]}`, mine, from `memberof:` (sorted by name) |
| POST | `/api/classes/join` | `{code}` | approved user | `{class: ClassSummary}` |
| GET | `/api/classes/:id` | | member | `{class: ClassDetail}`: pending requests get `id, name, status, membership`; active members also `schedule, event, caseIds, boardToken`; admins also `admin: {ownerId, joinMode, joinCode, memberLimit, createdAt, updatedAt}` |
| PATCH | `/api/classes/:id` | any of `{name, joinMode, schedule: {timezone, defaultCaseId, days}, event: {name, startsAt, endsAt, freezeAt, announcement}, caseIds}` (up to 64 KB) | class admin | `{class}`; case ids must be published (400 `unknown-case`), the time zone valid, the event window sane |
| POST | `/api/classes/:id/archive` | `{}` | owner | `{class}` |
| POST | `/api/classes/:id/restore` | `{}` | owner | `{class}` (409 `class-limit` if the owner is at the limit; the site admin may go past it) |
| POST | `/api/classes/:id/join-code/rotate` | `{}` | class admin | `{class}`; the old code stops working at once |
| POST | `/api/classes/:id/board-token/rotate` | `{}` | class admin | `{class}`; old board links stop working |
| GET | `/api/classes/:id/members` | | class admin | `{members: [{accountId, username, role, status, isOwner, joinedAt, decidedAt}]}` |
| GET | `/api/classes/:id/progress?caseId=` | | class admin | `{generatedAt, caseId, players: AdminProgress[]}` (active members only) |
| GET | `/api/classboard/:boardToken?caseId=` | | anyone with the token | `ClassBoardResponse` (public, CDN-cached; 404 when unknown, rotated or archived) |
| POST | `/api/classes/:id/members/:accountId/approve` | `{}` | class admin | `{member}` (idempotent) |
| POST | `/api/classes/:id/members/:accountId/remove` | `{}` | see the matrix | 204 (a removed account can join again with the code: rotate it to stop that) |
| POST | `/api/classes/:id/members/:accountId/role` | `{role: "member"\|"admin"}` | owner | `{member}`; active members only (409 `pending-member`) |
| POST | `/api/classes/:id/leave` | `{}` | member | 204; the owner can't leave (409 `owner-locked`): they archive instead |
| GET | `/api/admin/classes` | | site admin | `{classes: [{id, name, status, ownerId, joinMode, memberLimit, members, createdAt}]}` (newest first) |
| PUT | `/api/admin/classes/:id/limits` | `{memberLimit}` (1–1000) | site admin | `{class}` |
| PUT | `/api/admin/accounts/:id/class-limit` | `{classLimit}` (0–100, or null for the default 3) | site admin | `{accountId, classLimit}` |

**Permission matrix.** "Class admin" means the owner or an active co-admin. Pending members are members only
for viewing and leaving.

| Action | Owner | Co-admin | Member | Pending | Site admin | Non-member |
|---|---|---|---|---|---|---|
| View the class | full | full | member view | name only | full | 404 |
| Edit settings, list members, approve requests, rotate the code or the board token | yes | yes | 403 | 403 | yes | 404 |
| Archive, restore | yes | 403 | 403 | 403 | yes | 404 |
| Remove a member or a pending request | yes | yes | 403 | 403 | yes | 404 |
| Remove a co-admin | yes | 403 | 403 | 403 | yes | 404 |
| Promote or demote | yes | 403 | 403 | 403 | yes | 404 |
| Remove or demote the owner | 409 | 409 (remove) / 403 (demote) | 403 | 403 | 409 | 404 |
| Leave | 409 | yes | yes | yes | 403 `admin` | 404 |
| Reset a member's password | never (only the site admin, through `/api/admin`) | never | never | never | yes | |

## Schedule ("incident of the day")

`Schedule = { timezone, defaultCaseId, days: {"YYYY-MM-DD": caseId}, lockToToday }`. "Today" is the
date in `timezone` (default `Asia/Jerusalem`). Today's case is `days[today] ?? defaultCaseId`: the daily card on
the home page and the streaks count it.

**Players can always play every published case** (#180). `lockToToday` (schedule) and `enforceWindow` (event)
are deprecated: they stay in the stored records and the responses, but nothing enforces them, and the admin
panel no longer shows their checkboxes. The 403 codes `not-today` and `event-closed` are gone. The global event
(`config:event`) is the site announcement and the global event clock; its `freezeAt` still freezes the global
leaderboard. Classes count their own windows on their own boards (see Classes).

## Rules

- Stages are sequential: setup, then q1 to q6, then the debrief. Acting on a locked stage returns 403. Acting on a finished stage returns 409, except that re-answering a solved stage returns `correct:true` without re-scoring and re-revealing a revealed stage returns the current progress.
- Score for a solved stage = `max(0, points - sum(cost of the first hintsRevealed hints))`. Points and hint costs come from the case JSON (copied into the secrets by `scripts/make_flags.py`).
- Rate limits: 5 wrong answers per account per question per 60 s; 8 failed logins per username and 60 per IP per 15 min; 100 sign-ups (and guest upgrades) per IP per hour and 30 new guests per IP per hour (classrooms share a NAT IP).
- Writes use optimistic concurrency (Blobs etags, up to 3 retries), so parallel requests for one player stay consistent.

## Storage

Rules for changing stored data, backups, restores and migrations: see `docs/DATA.md`.


One Netlify Blobs store, `incidentlab-v2`, with key prefixes: `account:`, `username:` (index),
`session:`, `progress:<caseId>:<accountId>`, `config:schedule`, `config:settings`, `config:event`,
`firstblood:<caseId>:<questionId>`, `audit:<iso>:<rand>`, `ratelimit:`, for classes `class:`, `classcode:`,
`classmember:` and `memberof:`, and for DB-stored cases `case:`,
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
