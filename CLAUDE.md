# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IncidentLab is a CTF-style incident-forensics training site. Each case gives players an evidence pack
(logs, metrics, chat, git history as text) and six sequential questions; answers are checked server-side.
It runs on Netlify: a static Vite SPA plus one Netlify Function (`/api/*`) backed by Netlify Blobs.

## Commands

```bash
./scripts/build-all.sh             # everything: generators -> answer keys -> packaging -> all solvers ->
                                   # stock-tools command check -> site build -> paid-content leak check -> server tests
./scripts/build-all.sh --no-site   # same without the npm build/tests

cd site && npm run typecheck       # tsc --noEmit
cd site && npm run build           # tsc + vite build -> site/dist
cd site && npm run test:server     # node:test over site/server/test/*.test.ts (in-memory store)
cd site && node --test --experimental-strip-types server/test/auth.test.ts   # one server test file
cd site && node --test --experimental-strip-types src/explorer/              # Explorer core tests
cd site && npm run test:client     # Explorer core, components and overlay rules (no browser)

bash solutions/solve.sh                         # 3am-outage solver (compares to build/truth/answers.json)
bash solutions/<case-id>/solve.sh               # other cases
python3 scripts/check_commands.py [case-id]     # runs every toolbox command, hint block and solver with stock tools only
node scripts/check-bundle.mjs                   # fails if hint texts/full commands leak into site/dist

# Local stack: built site + real API on an in-memory store (admin key local-admin-key-0123456789)
node --experimental-strip-types tests/local-server.ts 8888
node tests/seed-demo.mjs http://localhost:8888  # demo players (password demo-password-1), schedule, event

# E2E (Playwright) against a running local server
cd tests/e2e && npm ci && CHROMIUM_PATH=/usr/bin/chromium E2E_BASE_URL=http://localhost:8888 \
  ADMIN_KEY=local-admin-key-0123456789 npx playwright test [regressions.spec.ts] [-g "name"]
node tests/smoke-api.mjs <baseUrl> <adminKeyFile> <case-id>   # API smoke test against any deployment

./scripts/deploy.sh [--migrate] [--accept-answer-changes]     # production deploy (see Data safety)
```

Gitignored build inputs: `build/` (evidence, `build/truth/*.json` plaintext answers), `site/public/evidence/`,
`site/server/generated/secrets.json`. Run `build-all.sh` once before the site builds or tests; in a fresh
git worktree, copy them from the main checkout instead.

## Architecture

**Server** (`site/server/`, entry `site/netlify/functions/api.mts`): strict Controller -> Service -> Repository.
- `router.ts` wires everything and maps paths to controllers. `shared/contract.ts` holds the zod schemas and the
  endpoint list that browser and server share. `docs/API.md` documents the API.
- Repositories sit on a small `KvStore` interface (`repositories/KvStore.ts`): `BlobsKvStore` in production,
  `InMemoryKvStore` in tests and the local server. One Blobs store, `incidentlab-v2`, with key prefixes:
  `account:`, `username:`, `session:`, `progress:<case>:<account>`, `config:*`, `firstblood:`, `audit:`,
  `trash:`, `legacy:`, `ratelimit:`.
- Auth: an HttpOnly session cookie. Signing in as `admin` with `ADMIN_KEY` gives an admin session; admin routes
  also accept the `X-Admin-Key` header.
- Scoring lives in `services/scoring.ts`, with constants (`SCORING`) in the contract. Hint texts and full
  toolbox commands are *paid content*: `site/vite.config.ts` strips them from the bundle, and the API returns them
  in `progress.unlocked` only after charging for them.

**Client** (`site/src/`): framework-free TypeScript with hash routing in `main.ts`, built with the `h()` helper in
`lib/dom.ts`.
- Views load lazily per route. Case content is code-split per case and language (`content/load.ts`), with a
  build-time catalog module for home, stats and leaderboard.
- i18n: EN + HE (RTL) through `defineStrings`, split across several `i18n/strings-*.ts` files.
- The Evidence Explorer (`views/explorer.ts`, `explorer/*`) is a web worker plus a virtual list over the files in
  `/evidence/<case>/files/`.
- Dialogs, confirms, sheets, popovers, menus, toasts and banners come from `lib/overlay.ts`; never build them inline.
- Styling: plain CSS on a token system. Use the tokens and components recorded in `DESIGN.md`, not raw colours or px values.

**Cases**: `3am-outage` uses the legacy generators in `generator/*.py`. Every other case follows
`docs/CASE_CONTRACT.md`:
- `generator/cases/<id>/build.py` (stdlib Python, deterministic) writes `build/evidence/<id>/` and
  `build/truth/<id>.answers.json`;
- content goes in `site/src/content/cases/<id>(.he).json`, with no answers;
- the sealed debriefs in `content-sealed/`;
- an evidence-only solver in `solutions/<id>/solve.sh`.

`scripts/make_flags.py` merges every case into the server secrets, and `scripts/package.sh` zips the evidence
and copies the Explorer files. `build-all.sh` discovers new cases automatically.

## Rules specific to this repo

- **Players install nothing.** Toolbox commands, hint code and solvers may use only stock tools (grep, sed,
  POSIX awk, sort/uniq/cut, date…; no jq, git, python, column) and Windows PowerShell 5.1 built-ins.
  `scripts/check_commands.py` enforces this in CI.
- **No answers in public content.** Answers live only in generator truth and the server secrets. Each case JSON
  has a free `syntax` with `<placeholders>`; the runnable `command` is paid.
- **Data safety** (`docs/DATA.md`):
  - Stored-record changes are additive, with zod defaults.
  - Rewrites ship as numbered, idempotent migrations in `site/server/migrations/`.
  - Never rename the Blobs store or key prefixes.
  - Deletes and resets are soft (`trash:`, 7-day restore).
  - `deploy.sh` backs up production first and refuses answer-key drift.
  - Production data tools: `node --experimental-strip-types scripts/data.ts backup|list-backups|restore|migrate`
    (dry run unless `--apply`).
- **Spoilers:** `docs/CASE_BIBLE.md`, `docs/cases/`, `docs/SOLUTION.md`, `docs/INSTRUCTOR.md`, `solutions/`,
  `content-sealed/` and `build/truth/` contain answers.
- **Workflow:**
  - Feature branches merge straight into `main`; there is no `dev` branch.
  - CI (`.github/workflows/ci.yml`) runs `build-all.sh` plus the e2e suite on every PR. It must pass before merge.
  - Production deploys use `./scripts/deploy.sh`, then the smoke test runs against the live site. Prod may lock
    players to today's case, so smoke-test that case (`GET /api/today`).
