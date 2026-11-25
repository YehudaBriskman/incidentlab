# IncidentLab API

Server-side answer checking and live admin view. Implemented as one Netlify Function
(`site/netlify/functions/api.mts`, mounted at `/api/*`) over `site/server/`
(Controller -> Service -> Repository). The contract (zod schemas + types) is
`site/shared/contract.ts`; both the browser and the function import it.

## Conventions

- Request and response bodies are JSON. POST bodies must send `content-type: application/json` (otherwise 415) and be at most 4 KB (otherwise 413).
- Every response carries `cache-control: no-store`.
- Errors are non-2xx with body `{ "error": string, "retryAfterSeconds"?: number }`. Status codes: 400 validation, 401 auth, 403 locked, 404, 405, 409 conflict (already finished, no more hints, or concurrent update: retry), 413, 415, 429 rate limit (also sends a `Retry-After` header), 500 `{"error":"internal"}`, 503 admin disabled.

## Auth

- Player: `Authorization: Bearer <token>`. The token is returned once by `POST /api/players` and has the form `<playerId>.<secret>`. Keep it in localStorage. The server stores only its sha256.
- Admin: `X-Admin-Key: <ADMIN_KEY>`.

## Endpoints

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/api/players` | none | `{name, caseId:"3am-outage"}` | 201 `{token, player}` |
| GET | `/api/me` | player | | `{player}` |
| POST | `/api/setup-done` | player | `{}` | `{player}` (q1 becomes active; idempotent) |
| POST | `/api/answer` | player | `{questionId, answer}` | `{correct, player}` |
| POST | `/api/hint` | player | `{questionId}` | `{player}` (`hintsRevealed` +1) |
| POST | `/api/reveal` | player | `{questionId}` | `{player}` (0 points, `revealedAnswer` set, next stage active) |
| GET | `/api/debrief` | player | | `{markdown}`, 403 until every stage is solved or revealed |
| GET | `/api/admin/players` | admin | | `{generatedAt, players: AdminPlayer[]}` (cached for 2 s) |
| DELETE | `/api/admin/players/:id` | admin | | 204 |
| POST | `/api/admin/reset` | admin | `{confirm:"RESET"}` | 204, deletes all players |

## Rules

- Stages are sequential: setup, then q1 to q6, then the debrief. Acting on a locked stage returns 403. Acting on a finished stage returns 409, except that re-answering a solved stage returns `correct:true` without re-scoring and re-revealing a revealed stage returns the current player.
- Score for a solved stage = `max(0, points - sum(cost of the first hintsRevealed hints))`. Points and hint costs come from the case JSON.
- Rate limits: 5 wrong answers per player per question per 60 s. Player creation: 20 per hour per IP.
- Writes use optimistic concurrency (Blobs etags, up to 3 retries), so parallel requests for one player stay consistent.

## Environment

| Var | Meaning |
|---|---|
| `ADMIN_KEY` | Admin secret. If it is unset or shorter than 16 chars, every admin route returns 503 `admin disabled`. |
| `INCIDENTLAB_STORE` | Set to `memory` to use the in-process store (tests and local work; data is lost on cold start). Otherwise the function uses Netlify Blobs store `incidentlab-players`. |

Answers and the debrief are read from `site/server/generated/secrets.json` (written by the pipeline). Never import it from `site/src`.

## Tests

`cd site && npm run test:server` (node:test, in-memory store, no Blobs).
