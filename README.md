# IncidentLab

**Live:** https://incidentlab-3am-outage.netlify.app

**Real incidents, as puzzles.** IncidentLab is a CTF-style training platform for engineers. Each case
drops you into a production outage after the fact. You get a zip of evidence (web server logs, app
logs, metrics, a deploy log, a chat export, and the service's git repo) and a set of questions.
Every correct answer is a flag. Each case is inspired by a real, publicly documented incident.

It is built for a live session with colleagues: about 10 minutes of orientation, 40 minutes of
solving in pairs, then a debrief and a short lecture. Players need **no installs**: they can work in a
bash terminal with only the built-in tools (`grep`, `sed`, `awk`, `sort`, `date`; no `jq`, no `git`), in Windows PowerShell 5.1 (every Toolbox command has a
PowerShell version), or entirely in the browser with the built-in **Evidence Explorer**.

## Cases

| Status | Case | Skills |
|---|---|---|
| Live | **The 3 AM Outage** (`3am-outage`): checkout is down in the middle of the night and the chat is full of theories | log forensics, time zones, correlation, git archaeology |
| Live | **Ghost in the Network** (`ghost-in-the-network`): Small requests work. Big ones hang forever. Half the fleet resolves an IP that hasn't existed since Tuesday. Nothing is down, yet nothing quite works. | tcpdump, wireshark, mtu, pmtud, icmp |
| Live | **The Insider Commit** (`the-insider-commit`): SSH logins got 500 ms slower after a routine library update. A trusted maintainer, a tarball that doesn't match the repo. Follow the half-second. | supply-chain, git-archaeology, release-artifacts, autotools, binary-analysis |
| Live | **Kubernetes Crime Scene** (`kubernetes-crime-scene`): Pods in CrashLoopBackOff, a node under pressure, a Service with no endpoints, and an HPA that can't make up its mind. Every one of them is a witness, and only one of them is telling the truth. | kubernetes, kubectl, oomkilled, probes, service-selectors |
| Live | **Who Deleted Prod?** (`who-deleted-prod`): 100 million customer records walked out the door, and every API call was made with our own role. Reconstruct the attack from CloudTrail, WAF logs and one very chatty metadata endpoint. | cloud-forensics, aws, cloudtrail, ssrf, imds |

## Architecture

- **Static site** (`site/dist`, Vite): case content, Toolbox, the Evidence Explorer (reads each case's loose
  evidence files from `/evidence/<case-id>/files/`), and the evidence zips (`/evidence/<case-id>-evidence.zip`).
- **One Netlify Function** (`site/netlify/functions`, served at `/api/*`): accounts and sessions, answer
  checking, hints/reveals, debriefs, the incident-of-the-day schedule, stats and the admin API. The answer keys
  and debriefs (`site/server/generated/secrets.json`, gitignored) are bundled into the function only; they are
  never published as static files. See `docs/API.md`.
- **Accounts:** unique username + password (scrypt). New sign-ups wait for the instructor's approval in
  `#/admin`. The session is an HttpOnly cookie, so progress follows the account across reloads and devices.
- **Netlify Blobs** (store `incidentlab-v2`): accounts, sessions, per-account-per-case progress, the schedule.
  The instructor dashboard at `#/admin` approves players, picks the incident of the day, and shows live
  progress and stats.

Design decisions (tokens, type, components, themes) are recorded in `DESIGN.md`.

## Repo layout

```
docs/
  CASE_BIBLE.md          SPOILERS: the true story, timeline and answers for 3am-outage
  CASE_CONTRACT.md       how a case plugs in (files, generator output, questions, solver)
  cases/<id>.md          SPOILERS: the bible of every other case
  API.md                 the /api contract (accounts, sessions, gameplay, schedule, stats, admin)
  DATA.md                production data rules, backups, restores and migrations
  SITE_SCHEMA.ts.txt     content schema shared by the generators and the site
  INSTRUCTOR.md          presenter run-sheet (SPOILERS)
  POSTMORTEM_TEMPLATE.md blameless postmortem template for players
generator/               Python 3 (stdlib) generators that build the evidence packs deterministically
  cases/<id>/build.py    one generator per case (docs/CASE_CONTRACT.md); 3am-outage uses the files below
  timeline.py            canonical constants for the case
  build_repo.py          builds the service git repo and bundle
  gen_logs.py            nginx and application logs
  gen_support.py         metrics, DB log, deploy log, chat export, README for players
scripts/
  make_flags.py          writes the server answer key: site/server/generated/secrets.json (gitignored)
  package.sh             exports repo/git-log.txt, zips the evidence pack into site/public/evidence/,
                         and copies loose files to site/public/evidence/files/ for the Explorer
  build-all.sh           runs the whole pipeline + tests (solver, then server tests)
  deploy.sh              build-all.sh + ADMIN_KEY setup + backup + netlify deploy (site + function)
  data.ts                production data: backup, list-backups, restore, migrate (dry run by default)
site/                    the player-facing web app (Vite) + server code (site/server, site/netlify/functions)
solutions/               SPOILERS: reference solutions
build/                   generated output (git-ignored); build/truth/ holds the plaintext answers
```

## Quickstart

Requirements: Python 3.10+, git, zip, Node 20+.

```bash
./scripts/build-all.sh            # evidence, answer key, zip, solver test, site build, server tests
./scripts/build-all.sh --no-site  # same, but skip the npm build and server tests

cd site && npm run dev            # local dev server (the /api function needs `netlify dev` to run locally)
```

**Local preview with the real API and demo data** (after `build-all.sh` once):

```bash
node --experimental-strip-types tests/local-server.ts   # http://localhost:8888, in-memory store
node tests/seed-demo.mjs http://localhost:8888          # in another terminal: players, schedule, event, class code
```

`seed-demo.mjs` prints the demo credentials. Sign in as `admin` with the local admin key
(`local-admin-key-0123456789`).

## Tests

```bash
bash solutions/solve.sh           # 3am-outage: derives every answer from the evidence, compares to build/truth
bash solutions/<case-id>/solve.sh # same, for every other case
cd site && npm run test:server    # Netlify Function tests (accounts, gameplay, schedule, stats, admin)

# the built site + real API on http://localhost:8888 (in-memory store, admin key printed on start)
node --experimental-strip-types tests/local-server.ts
node tests/smoke-api.mjs http://localhost:8888 <admin-key-file> [case-id]   # end-to-end API smoke test
```

Both run automatically inside `./scripts/build-all.sh`.

## Deploy (Netlify)

The site is deployed **prebuilt** (the generators need Python, git and zip, so they don't run on Netlify).
The repo root is already linked to the site (`.netlify/state.json`). Deploy with:

```bash
export NETLIFY_AUTH_TOKEN=...      # or put the token in ~/.netlify-token
./scripts/deploy.sh
```

`deploy.sh` runs `build-all.sh`, makes sure the site has an `ADMIN_KEY` env var (on first run it
generates one, sets it in the production context and saves a copy to `~/.incidentlab-admin-key`, mode
600; the key is never printed), **backs up production data and aborts if the backup fails**, then runs
`npx -y netlify-cli@17 deploy --prod --dir=site/dist --functions=site/netlify/functions`. Pending data
migrations are reported, and applied only with `--migrate`.

Drag-and-drop deploys no longer work: the site needs its function.

## Production data

Player data lives in Netlify Blobs and is treated as production data:

- **Nightly backups:** a scheduled function snapshots the store every day and keeps 30 days.
- **`scripts/data.ts`:** `backup`, `list-backups`, `restore` and `migrate`. Every command is a dry run until
  you pass `--apply`, and restore and migrate take a backup first.
- **Deploys back up first** (see above).
- **Recently deleted:** deleting an account or resetting a case moves the data to the trash. Restore it from
  `#/admin` → Accounts → Recently deleted within 7 days.

Rules for changing stored records, the runbook and how to recover from a bad deploy: `docs/DATA.md`.

## How answer checking works

Answers never reach the browser. `scripts/make_flags.py` normalizes each answer (trim, lowercase,
collapse whitespace) into `site/server/generated/secrets.json`, which is bundled into the Netlify
Function only. The browser POSTs a guess to `/api/*`; the function normalizes it the same way, compares,
and records progress in Netlify Blobs. Hints, reveals and the debrief are also served by the function.

`build/truth/answers.json` (plaintext, instructor only) and `secrets.json` are gitignored and must never
be committed or copied into `site/dist`.

## Adding a new case

Follow `docs/CASE_CONTRACT.md`. In short, a case owns only its own files: the bible `docs/cases/<id>.md`,
the generator `generator/cases/<id>/build.py` (writes `build/evidence/<id>/` and
`build/truth/<id>.answers.json`), the sealed debriefs `content-sealed/<id>.debrief(.he).md`, the content
`site/src/content/cases/<id>(.he).json`, and the solver `solutions/<id>/solve.sh`. The pipeline discovers it
automatically: no edits to `make_flags.py`, `package.sh` or `build-all.sh`. Run `./scripts/build-all.sh`, solve
it yourself end to end, then schedule it in `#/admin`.

## Spoilers: keep the repo private

`docs/CASE_BIBLE.md`, `docs/cases/`, `docs/INSTRUCTOR.md`, `solutions/`, `content-sealed/` and `build/truth/` contain the answers. Keep this
repository private, or remove those paths before sharing it with players. Only `site/dist` should ever be
public, plus the function bundle that `deploy.sh` uploads.

## CI and end-to-end test

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: it runs
`./scripts/build-all.sh` (generators, answer keys, packaging, every solver, site build, server tests), then starts
`tests/local-server.ts` and runs the Playwright tests in `tests/e2e/` against it. On failure, the Playwright
report, screenshots/traces and the server log are uploaded as the `playwright-report` artifact.

- `tests/e2e/walkthrough.spec.ts`: a browser walkthrough: sign up, admin approval (via the API), today's incident,
  setup, an optional paid command reveal, a wrong and then a correct Stage 1 answer (from `build/truth/all-answers.json`),
  `#/me` score, sign out, then `admin` sign-in and the dashboard. UI selectors live in the `ui` object at the top.
- `tests/e2e/api.spec.ts`: API-only checks (reserved username 409, public leaderboard, admin routes need auth).

Run locally (after `./scripts/build-all.sh` once, so `build/truth/` exists):

```bash
cd site && npx vite build && cd ..                      # build site/dist
node --experimental-strip-types tests/local-server.ts   # http://localhost:8888, in-memory store
# in another terminal:
cd tests/e2e && npm install
CHROMIUM_PATH=/usr/bin/chromium npx playwright test     # or: npx playwright install chromium, then npx playwright test
```

`E2E_BASE_URL` points the tests at another server, and `ADMIN_KEY` must match that server's key
(default `local-admin-key-0123456789`). The walkthrough changes the server's schedule, so don't point it at production.
