# Case contract

How a case plugs into IncidentLab. Every case except the original `3am-outage` (which predates this
contract and keeps its own `generator/*.py` + `solutions/solve.sh`) follows it exactly. The build
pipeline discovers cases from `generator/cases/*/build.py`, so a case that follows this contract needs
**no edits to shared files**.

`<id>` below is the case id, kebab-case, e.g. `ghost-in-the-network`.

## Files a case owns

| Path | What |
|---|---|
| `docs/cases/<id>.md` | **SPOILERS.** The bible: true story, UTC timeline, the six questions, the answer to each and exactly where in the evidence it comes from, red herrings. Write it first; it is the contract for everything else. |
| `generator/cases/<id>/build.py` | Entry point. Python 3.10+ **stdlib only**, fixed seed, deterministic. Run from anywhere as `python3 generator/cases/<id>/build.py`. May import sibling modules in the same folder (add the folder to `sys.path` yourself). |
| `content-sealed/<id>.debrief.md` | Debrief markdown (English), served only after all six stages are finished. |
| `content-sealed/<id>.debrief.he.md` | Hebrew debrief (optional; falls back to English). |
| `site/src/content/cases/<id>.json` | Player content (English). Validates against `CaseSchema` in `site/shared/case.ts`. **Contains no answers.** |
| `site/src/content/cases/<id>.he.json` | Hebrew translation of the same file (same ids, points, costs, tool ids, evidence paths; commands stay in English). |
| `solutions/<id>/solve.sh` | Evidence-only solver (see below). |

Never edit another case's files or any shared file (`scripts/`, `site/src/views`, `site/server`, `teasers.json`, ...).
The integrator removes the teaser and wires anything shared.

## What `build.py` must produce

1. Wipe and recreate `build/evidence/<id>/`, then write the evidence pack into it. It **must** include
   `README_FIRST.txt` (what happened from on-call's point of view, the file list, time-zone notes, and
   no answers).
2. Write `build/truth/<id>.answers.json`:
   ```json
   { "caseId": "<id>", "answers": { "q1": "...", "q2": "...", "q3": "...", "q4": "...", "q5": "...", "q6": "..." } }
   ```
   Answers are **plaintext as the player would type them**. The pipeline normalizes them
   (trim, lowercase, collapse whitespace) for the server.
3. Exit non-zero with a clear message if any internal cross-check fails (e.g. the planted count does not
   match what was actually written to the logs).

Evidence rules:

- **Text only** in the Explorer: logs, JSON/JSONL, CSV, YAML, config, diffs, `git log -p` style exports,
  pcap rendered as text (`tcpdump -nn -tttt`-style lines), `kubectl` output, etc. A binary file
  (e.g. a `.bundle` or a real `.pcap`) may go in the zip, but it must have a text twin and its name must
  end in `.bundle`, `.pcap`, `.tar.gz` or `.bin` (the Explorer skips those extensions).
- Size: each file at most 15 MB, the whole evidence directory at most 40 MB uncompressed.
- Realistic noise: real-looking background traffic, red herrings that the bible explains, and more than
  one plausible theory in the chat/ticket. Players should have to **correlate at least two sources** for most answers.
- Timestamps: state every source's time zone and format in `README_FIRST.txt`. Mixing zones on purpose is fine.
- No real people, companies, domains, IPs or credentials. Use fictional orgs, RFC 5737/1918 IPs,
  `example.com`/`.internal` domains, and obviously fake keys (`AKIAEXAMPLE...`).

## Questions

- Exactly six: `q1` ... `q6`, solved **in order** (each stage unlocks the next), telling the RCA story
  (e.g. when, what changed, the trigger, where/how, blast radius, the root cause).
- Each answer must be a **single unambiguous token or short string** whose spelling the `answerFormat` pins
  down completely (`HH:MM:SS (UTC)`, `7-char commit SHA`, `integer`, `pod name`, `IAM role name`, ...).
  Avoid answers where "1.5" vs "1.50" or "eu-west-1a" vs "eu-west-1" could both seem right.
- `points`: 100 for q1–q5, 150 for q6. Exactly **3 hints** per question, costs `10`, `20`, `40`
  (hint 3 is nearly the full command, but still not the answer).
- Every question has a `stage` block (`name`, `goal`, 2–4 `lookFor`, `tools` = toolbox item ids, and an
  `explorerTip` explaining how to do it in the browser Explorer: filters `contains`/`not`/`regex`,
  first/last match, unique values by regex capture group, histogram by regex capture group, JSON pretty view, CSV table).
- `successNote`: the "why this matters" lesson, in markdown.

## Case JSON fields

- `id` = `<id>`; `evidenceZip` = `/evidence/<id>-evidence.zip` (the zip has one top-level folder `<id>/`).
- `evidence`: **every** text file in the pack, with its path relative to `build/evidence/<id>/`. This list drives the Explorer sidebar.
- `setupChecklist`: 4–5 items (get the pack or open the Explorer, read README_FIRST, time zones, pick bash/PowerShell/browser).
- `rules`: reuse the 3am-outage rules, adapted.
- `toolbox`: 6–10 categories; **every item has both `command` (bash) and `powershell`**. Ids are unique and referenced by `stage.tools`.
- `debrief`: one line: `"_Sealed._ Finish all six stages to unlock the debrief."` (the real one is served by the server).
- `inspiredBy`: the real public incident, year and a factual 2–3 sentence summary.
- Writing style: plain, direct, no em dashes.

## Schemas

The zod schemas are the source of truth for every case shape (there is no separate schema doc):

| Schema | File | What |
|---|---|---|
| `CaseSchema` | `site/shared/case.ts` | The authored case JSON above, paid fields included. The browser bundle gets it with the paid fields stripped. |
| `CaseContentSchema` | `site/shared/case-records.ts` | The public form: hints are `{cost}` only, toolbox items have no `command`/`powershell`. Derived from `CaseSchema`; `stripPaidContent()` turns one into the other. |
| `CaseSealedSchema` | `site/shared/case-records.ts` | The server-only half: normalized answers, hint texts, commands, debriefs, points and hint costs. Each case in `site/server/generated/secrets.json` has this shape. |
| `CaseMetaSchema`, `EvidenceEntrySchema`, `CasePackageManifestSchema` | `site/shared/case-records.ts` | Case records and the upload package manifest (evidence in `EVIDENCE_CHUNK_BYTES` = 4 MiB chunks). Planned in #64/#65; nothing uses them yet. |

Answers are normalized by `normalizeAnswer()` in `site/shared/normalize.ts`. `scripts/make_flags.py` mirrors it
and checks itself against `site/shared/normalize-vectors.json` on every build.

## Solver: `solutions/<id>/solve.sh`

`bash solutions/<id>/solve.sh [evidence_dir]` (default `build/evidence/<id>`). Using only standard CLI
tools (grep, awk, sed, sort, uniq, jq, date, git) on the evidence, it derives all six answers, prints `qN=value`,
then compares them with `build/truth/<id>.answers.json` (normalized) and exits 1 on any mismatch. It must not read generator code or constants.

## Pipeline (for reference; you don't edit it)

`scripts/build-all.sh` runs every `generator/cases/*/build.py`, then `scripts/make_flags.py` merges every
`build/truth/<id>.answers.json` and `content-sealed/<id>.debrief*.md` into the server secrets, then
`scripts/package.sh` zips `build/evidence/<id>/` to `site/public/evidence/<id>-evidence.zip` and copies the
Explorer files to `site/public/evidence/<id>/files/`, then runs every `solutions/*/solve.sh`.
