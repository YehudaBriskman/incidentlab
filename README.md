# IncidentLab

**Live:** https://incidentlab-3am-outage.netlify.app

**Real incidents, as puzzles.** IncidentLab is a CTF-style training platform for engineers. Each case
drops you into a production outage after the fact. You get a zip of evidence (web server logs, app
logs, metrics, a deploy log, a chat export, and the service's git repo) and a set of questions.
Every correct answer is a flag. Each case is inspired by a real, publicly documented incident.

It is built for a live session with colleagues: about 10 minutes of orientation, 40 minutes of
solving in pairs, then a debrief and a short lecture. Players need **no installs**: they can work in a
bash terminal (`grep`, `awk`, `jq`, `date`), in Windows PowerShell 5.1 (every Toolbox command has a
PowerShell version), or entirely in the browser with the built-in **Evidence Explorer**.

## Cases

| Status | Case | Skills |
|---|---|---|
| Live | **The 3 AM Outage** (`3am-outage`): checkout is down in the middle of the night and the chat is full of theories | log forensics, time zones, correlation, git archaeology |
| Coming soon | 4 more cases (teasers on the site's home page) | |

## Architecture

- **Static site** (`site/dist`, Vite): case content, Toolbox, the Evidence Explorer (reads the loose
  evidence files from `/evidence/files/`), and the evidence zip.
- **One Netlify Function** (`site/netlify/functions`, served at `/api/*`): registers players, checks
  answers, hands out hints/reveals, unlocks the debrief and serves the admin dashboard data. The answer
  key and the debrief (`site/server/generated/secrets.json`, gitignored) are bundled into the function
  only; they are never published as static files.
- **Netlify Blobs**: per-player progress and scores, so the instructor sees everyone live at `#/admin`.

## Repo layout

```
docs/
  CASE_BIBLE.md          SPOILERS: the true story, timeline and answers for each case
  SITE_SCHEMA.ts.txt     content schema shared by the generators and the site
  INSTRUCTOR.md          presenter run-sheet (SPOILERS)
  POSTMORTEM_TEMPLATE.md blameless postmortem template for players
generator/               Python 3 (stdlib) generators that build the evidence pack deterministically
  timeline.py            canonical constants for the case
  build_repo.py          builds the service git repo and bundle
  gen_logs.py            nginx and application logs
  gen_support.py         metrics, DB log, deploy log, chat export, README for players
scripts/
  make_flags.py          writes the server answer key: site/server/generated/secrets.json (gitignored)
  package.sh             exports repo/git-log.txt, zips the evidence pack into site/public/evidence/,
                         and copies loose files to site/public/evidence/files/ for the Explorer
  build-all.sh           runs the whole pipeline + tests (solver, then server tests)
  deploy.sh              build-all.sh + ADMIN_KEY setup + netlify deploy (site + function)
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

## Tests

```bash
bash solutions/solve.sh           # derives every answer from the evidence and compares to build/truth
cd site && npm run test:server    # Netlify Function / answer-checking tests
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
600; the key is never printed), then runs
`npx -y netlify-cli@17 deploy --prod --dir=site/dist --functions=site/netlify/functions`.

Drag-and-drop deploys no longer work: the site needs its function.

## How answer checking works

Answers never reach the browser. `scripts/make_flags.py` normalizes each answer (trim, lowercase,
collapse whitespace) into `site/server/generated/secrets.json`, which is bundled into the Netlify
Function only. The browser POSTs a guess to `/api/*`; the function normalizes it the same way, compares,
and records progress in Netlify Blobs. Hints, reveals and the debrief are also served by the function.

`build/truth/answers.json` (plaintext, instructor only) and `secrets.json` are gitignored and must never
be committed or copied into `site/dist`.

## Adding a new case

1. **Bible.** Write the true story, a UTC timeline, the questions and where each answer comes from in
   `docs/CASE_BIBLE.md` (or a sibling bible file). This is the contract for everything else.
2. **Generator.** Add a `timeline.py`-style constants module and generators that write the evidence pack to
   `build/evidence/<case-id>/` and any generated answers to `build/truth/*.json`. Use stdlib only and a
   fixed seed so builds are reproducible.
3. **Content JSON.** Add `site/src/content/cases/<case-id>.json` (briefing, evidence list, questions, hints,
   toolbox, debrief) that validates against the schema. It must contain no answers. Move the case's teaser
   out of `teasers.json`.
4. **Answers.** Extend `scripts/make_flags.py` to compute the new case's answers into the server secrets, and
   `scripts/package.sh` to zip its evidence and copy the Explorer files. Wire both into `scripts/build-all.sh`.
5. Run `./scripts/build-all.sh`, then solve the case end to end yourself before showing it to players.

## Spoilers: keep the repo private

`docs/CASE_BIBLE.md`, `docs/INSTRUCTOR.md`, `solutions/` and `build/truth/` contain the answers. Keep this
repository private, or remove those paths before sharing it with players. Only `site/dist` should ever be
public, plus the function bundle that `deploy.sh` uploads.
