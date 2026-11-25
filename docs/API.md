# IncidentLab API

Accounts, server-side answer checking, the daily schedule, stats and the live admin view. Implemented
as one Netlify Function (`site/netlify/functions/api.mts`, mounted at `/api/*`) over `site/server/`
(Controller -> Service -> Repository). The contract (zod schemas + types) is `site/shared/contract.ts`;
both the browser and the function import it.

## Conventions

- Request and response bodies are JSON. POST/PUT bodies must send `content-type: application/json` (otherwise 415) and be at most 4 KB (64 KB for the schedule; otherwise 413).
- Every response carries `cache-control: no-store`.
- Errors are non-2xx with body `{ "error": string, "code"?: string, "retryAfterSeconds"?: number }`. Status codes: 400 validation, 401 signed out, 403 forbidden (see codes), 404, 405, 409 conflict (username taken, already finished, no more hints, concurrent update: retry), 413, 415, 429 rate limit (also sends `Retry-After`), 500 `{"error":"internal"}`, 503 admin disabled.
- Error codes the UI acts on: `signed-out`, `bad-credentials`, `username-taken`, `pending`, `rejected`, `not-today`, `locked`, `unknown-case`, `rate-limited`.

## Accounts and sessions

- Usernames are 3–24 chars (unicode letters, digits, `.`, `_`, `-`; no spaces) and **unique case-insensitively** (NFKC + lowercase). Uniqueness is enforced with a conditional write on a username index, so two simultaneous sign-ups can't both win.
- Passwords: 8–128 chars, stored as `scrypt` (N=16384, r=8, p=1, per-user salt). Login always runs scrypt, even for unknown usernames.
- New accounts are `pending`. They can sign in and see `/api/me`, but every `/api/cases/*` route returns 403 `pending` until the instructor approves them. `rejected` accounts can't sign in.
- The session is an opaque random token in the cookie `il_session` (`HttpOnly; SameSite=Lax; Path=/api; Secure`; 30 days, renewed when under 15 days remain). The store keeps `sha256(token)` only. Logout deletes the session; rejecting or deleting an account kills all of its sessions.
- CSRF: SameSite=Lax plus JSON-only bodies (a cross-site form can't send `application/json`).

## Endpoints

### Public and player

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/api/auth/register` | none | `{username, password}` | 201 `{account}` + cookie |
| POST | `/api/auth/login` | none | `{username, password}` | `{account}` + cookie |
| POST | `/api/auth/logout` | cookie | `{}` | 204, clears the cookie |
| GET | `/api/me` | cookie | | `{account}` |
| GET | `/api/me/stats` | cookie | | `{stats: UserStats}` |
| GET | `/api/today` | none | | `{date, timezone, caseId, lockToToday, releasedCaseIds}` |
| GET | `/api/cases/:caseId/progress` | approved | | `{progress}` (first call creates the record, so the admin sees the player at "setup") |
| POST | `/api/cases/:caseId/setup-done` | approved | `{}` | `{progress}` (q1 becomes active; idempotent) |
| POST | `/api/cases/:caseId/answer` | approved | `{questionId, answer}` | `{correct, progress}` |
| POST | `/api/cases/:caseId/hint` | approved | `{questionId}` | `{progress}` (`hintsRevealed` +1) |
| POST | `/api/cases/:caseId/reveal` | approved | `{questionId}` | `{progress}` (0 points, `revealedAnswer` set, next stage active) |
| GET | `/api/cases/:caseId/debrief?lang=en\|he` | approved | | `{markdown}`, 403 until every stage is finished |

### Admin (`X-Admin-Key: <ADMIN_KEY>`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/admin/accounts` | | `{generatedAt, accounts: UserStats[]}` (every account with stats and rank; cached 2 s) |
| POST | `/api/admin/accounts/:id/approve` | `{}` | `{account}` |
| POST | `/api/admin/accounts/:id/reject` | `{}` | `{account}` (signs the account out) |
| DELETE | `/api/admin/accounts/:id` | | 204 (account, sessions, progress; frees the username) |
| GET | `/api/admin/progress?caseId=` | | `{generatedAt, caseId, players: AdminProgress[]}` |
| DELETE | `/api/admin/progress/:accountId/:caseId` | | 204 (restart one player's case) |
| POST | `/api/admin/reset` | `{confirm:"RESET", caseId?}` | 204 (wipe progress for one case or all; accounts stay) |
| GET | `/api/admin/schedule` | | `{schedule}` |
| PUT | `/api/admin/schedule` | `Schedule` | `{schedule}` (case ids must be released; time zone must be valid) |
| GET | `/api/admin/stats` | | `{generatedAt, cases: CaseSummary[]}` |

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

One Netlify Blobs store, `incidentlab-v2`, with key prefixes: `account:`, `username:` (index),
`session:`, `progress:<caseId>:<accountId>`, `config:schedule`, `ratelimit:`. The pre-accounts store
`incidentlab-players` is no longer read.

## Environment

| Var | Meaning |
|---|---|
| `ADMIN_KEY` | Admin secret. If it is unset or shorter than 16 chars, every admin route returns 503 `admin disabled`. |
| `INCIDENTLAB_STORE` | Set to `memory` to use the in-process store (tests and local work; data is lost on restart). Otherwise Netlify Blobs. |

Answers, debriefs and points are read from `site/server/generated/secrets.json` (written by the pipeline; `{cases: {<id>: …}}`). Never import it from `site/src`.

## Tests

- `cd site && npm run test:server`: node:test over the real router with the in-memory store.
- `node --experimental-strip-types tests/local-server.ts`: the built site + API on http://localhost:8888 (in-memory store).
- `node tests/smoke-api.mjs <baseUrl> [adminKeyFile] [caseId]` and `node tests/load.mjs <baseUrl> [players] [adminKeyFile] [caseId]` against a running deployment.
