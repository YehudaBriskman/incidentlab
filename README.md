# IncidentLab

**Live:** https://incidentlab-3am-outage.netlify.app

**Real incidents, as puzzles.** IncidentLab is a CTF-style training platform for engineers. Each case
drops you into a production outage after the fact. You get a zip of evidence (web server logs, app
logs, metrics, a deploy log, a chat export, and the service's git repo) and a set of questions.
Every correct answer is a flag. Each case is inspired by a real, publicly documented incident.

It is built for a live session with colleagues: about 10 minutes of orientation, 40 minutes of
solving in pairs, then a debrief and a short lecture. Players need only a terminal (`grep`, `awk`,
`jq`, `git`, `date`) and a browser.

## Cases

| Status | Case | Skills |
|---|---|---|
| Live | **The 3 AM Outage** (`3am-outage`): checkout is down in the middle of the night and the chat is full of theories | log forensics, time zones, correlation, git archaeology |
| Coming soon | 4 more cases (teasers on the site's home page) | |

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
  make_flags.py          hashes the answers into site/src/generated/flags.json
  package.sh             zips the evidence pack into site/public/evidence/
  build-all.sh           runs the whole pipeline
site/                    the player-facing web app (Vite + React)
solutions/               SPOILERS: reference solutions
build/                   generated output (git-ignored); build/truth/ holds the plaintext answers
```

## Quickstart

Requirements: Python 3.10+, git, zip, Node 20+.

```bash
./scripts/build-all.sh          # generate evidence, flags, zip, and build the site into site/dist
./scripts/build-all.sh --no-site  # same, but skip the npm build

cd site && npm run dev          # local dev server
```

## Deploy (Netlify)

The site is deployed **prebuilt**. `netlify.toml` publishes `site/dist` and does not run the
generators on Netlify (they need Python, git and zip, and they would reshuffle the flag salts on
every push). Build locally, then pick one:

```bash
npx netlify-cli deploy --prod --dir=site/dist
```

or drag and drop the `site/dist` folder onto <https://app.netlify.com/drop>.

After deploying, download the evidence zip from the live site once to make sure it opens.

## How flags work

Answers never ship to the browser in plaintext. At build time `scripts/make_flags.py` normalizes each
answer (trim, lowercase, collapse whitespace), adds a random per-flag salt, and stores
`sha256(salt + answer)` in `site/src/generated/flags.json`. The browser normalizes what the player types
the same way and compares hashes. Progress and hints are kept in the browser only.

This is **good enough for a classroom, not for prizes**. Short answers (a timestamp, a small number) can
be brute-forced from the hash, and anyone can edit their local state. Don't attach anything valuable to
the scoreboard.

## Adding a new case

1. **Bible.** Write the true story, a UTC timeline, the questions and where each answer comes from in
   `docs/CASE_BIBLE.md` (or a sibling bible file). This is the contract for everything else.
2. **Generator.** Add a `timeline.py`-style constants module and generators that write the evidence pack to
   `build/evidence/<case-id>/` and any generated answers to `build/truth/*.json`. Use stdlib only and a
   fixed seed so builds are reproducible.
3. **Content JSON.** Add `site/src/content/cases/<case-id>.json` (briefing, evidence list, questions, hints,
   toolbox, debrief) that validates against the schema. It must contain no answers. Move the case's teaser
   out of `teasers.json`.
4. **Flags.** Extend `scripts/make_flags.py` to compute the new case's answers and write its flags, and
   `scripts/package.sh` to zip its evidence. Wire both into `scripts/build-all.sh`.
5. Run `./scripts/build-all.sh`, then solve the case end to end yourself before showing it to players.

## Spoilers: keep the repo private

`docs/CASE_BIBLE.md`, `docs/INSTRUCTOR.md`, `solutions/` and `build/truth/` contain the answers. Keep this
repository private, or remove those paths before sharing it with players. Only `site/dist` should ever be
public.
