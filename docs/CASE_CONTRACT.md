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

- `id` = `<id>`; `evidenceZip` = `/evidence/<id>-evidence.zip` (the zip has one top-level folder `<id>/`). The site
  ignores this value since #68 and links the zip at the location the content API names; it downloads as
  `<id>-evidence.zip`, the name the toolbox commands unzip.
- `evidence`: **every** text file in the pack, with its path relative to `build/evidence/<id>/`. This list drives the Explorer sidebar.
- `setupChecklist`: 4–5 items (get the pack or open the Explorer, read README_FIRST, time zones, pick bash/PowerShell/browser).
- `rules`: reuse the 3am-outage rules, adapted.
- `toolbox`: 6–10 categories; **every item has both `command` (bash) and `powershell`**. Ids are unique and referenced by `stage.tools`.
  Optional lab track (#149): `syntaxLab` (free, with `<placeholders>`) and `lab` (paid), a command for the lab
  image's shell (`lab/README.md`), run from `/case`, that may use its tools (tcpdump, dig, jq, gawk, git). The
  item's single reveal unlocks it with the others. `scripts/check_commands.py` runs it inside the image when
  `LAB_IMAGE_CHECK=1`.
- `debrief`: one line: `"_Sealed._ Finish all six stages to unlock the debrief."` (the real one is served by the server).
- `inspiredBy`: the real public incident, year and a factual 2–3 sentence summary.
- Writing style: plain, direct, no em dashes.

## Schemas

The zod schemas are the source of truth for every case shape (there is no separate schema doc):

| Schema | File | What |
|---|---|---|
| `CaseSchema` | `site/shared/case.ts` | The authored case JSON above, paid fields included. The browser bundle gets it with the paid fields stripped. |
| `CaseContentSchema` | `site/shared/case-records.ts` | The public form: hints are `{cost}` only, toolbox items have no `command`/`powershell`/`lab`. Derived from `CaseSchema`; `stripPaidContent()` turns one into the other. |
| `CaseSealedSchema` | `site/shared/case-records.ts` | The server-only half: normalized answers, hint texts, commands, debriefs, points and hint costs. Each case in `site/server/generated/secrets.json` has this shape. |
| `EvidenceEntrySchema`, `CasePackageManifestSchema` | `site/shared/case-records.ts` | The case package manifest (below), evidence in `EVIDENCE_CHUNK_BYTES` = 4 MiB chunks. |
| `CaseMetaSchema` | `site/shared/case-records.ts` | The stored case record. Planned in #64; nothing stores it yet. |

Answers are normalized by `normalizeAnswer()` in `site/shared/normalize.ts`. `scripts/make_flags.py` mirrors it
and checks itself against `site/shared/normalize-vectors.json` on every build.

## Solver: `solutions/<id>/solve.sh`

`bash solutions/<id>/solve.sh [evidence_dir]` (default `build/evidence/<id>`). Using only standard CLI
tools (grep, awk, sed, sort, uniq, jq, date, git) on the evidence, it derives all six answers, prints `qN=value`,
then compares them with `build/truth/<id>.answers.json` (normalized) and exits 1 on any mismatch. It must not read generator code or constants.

## Case package

Every build also turns each case into one upload package, `build/packages/<id>-v<n>.case.zip`
(`scripts/make_package.py`, default version 1). It is the unit that DB-stored cases are uploaded and stored
as (#64, #66). **It contains the answers**: it lives only under the gitignored `build/`, and is never served
or committed.

| Entry | What | Schema |
|---|---|---|
| `manifest.json` | `schemaVersion` (1), `id`, `version`, `langs` (unique, includes `en`), and `evidence`: one entry per file with `path`, `format`, `size`, `sha256`, `chunks` and `explorer` | `CasePackageManifestSchema` |
| `content.<lang>.json` | Public content, one per manifest language: the case JSON with hint texts and `command`/`powershell`/`lab` removed (`stripPaidContent`) | `CaseContentSchema` |
| `sealed/answers.json` | `{qN: answer}`, normalized with `normalizeAnswer` | `CaseSealedSchema.answers` |
| `sealed/hints.json` | `{qN: [{en, he}]}`, hint texts in order (`he` is `null` without a translation) | `CaseSealedSchema.hints` |
| `sealed/commands.json` | `{toolId: {command, powershell, lab}}` (`lab` may be null or absent) | `CaseSealedSchema.tools` |
| `sealed/scoring.json` | `{title, estMinutes, questions: {qN: {points, hintCosts, targetSeconds}}}` | the rest of `CaseSealedSchema` |
| `sealed/debrief.en.md`, `sealed/debrief.he.md` | The sealed debriefs (Hebrew only when `content-sealed/<id>.debrief.he.md` exists) | `debrief`, `debriefHe` |
| `evidence.zip` | The player download, exactly as `scripts/package.sh` built it (one top-level folder `<id>/`), stored uncompressed | |
| `evidence/<path>` | Every raw file in `build/evidence/<id>/`, binaries (`.pcap`, `.bundle`) included | listed in `manifest.evidence` |

Manifest evidence entries:
- `path` is relative to `build/evidence/<id>/` (POSIX, no leading `/`, no `.` or `..` segments) and unique;
- `format` comes from the case JSON's `evidence` list, or from the extension for binaries it does not list;
- `chunks` is `ceil(size / 4 MiB)`; `explorer` is false for the binary extensions the Explorer skips.

The sealed files together are exactly the case's entry in `site/server/generated/secrets.json`
(`make_package.py` reuses `make_flags.py` to build them).

Packages are **deterministic**: entries sorted by name, fixed timestamps (2026-11-13 08:00) and mode 0644,
deflate level 9. The same inputs give a byte-identical zip, so its sha256 identifies a version.

`scripts/check-packages.mts` (run by `build-all.sh`) opens every package with `site/shared/zip.ts` and checks it
with `validateCasePackage()` in `site/shared/case-package.ts`:
- no unexpected entries, and the file name matches `<id>-v<version>.case.zip`;
- manifest, content and sealed parts against the schemas above, and the sealed points, hint costs and tool ids
  against `content.en.json`;
- every evidence file's size, sha256 and chunk count against the manifest, no unlisted files, and
  `evidence.zip` holding the same files;
- no answer, hint text or command in `manifest.json` or any `content.<lang>.json`, using the rules in
  `site/shared/leak-scan.ts` (shared with `check-bundle.mjs`). Answers are matched as normalized whole tokens,
  so a raw answer in any case or spacing is caught; answers shorter than 4 characters are not scanned;
- against the build inputs: each `content.<lang>.json` equals `stripPaidContent` of the authored JSON, and the
  sealed part equals the server secrets.

### Uploading a package

A package becomes a stored case version through the author API (`docs/API.md`, "Author"): the instructor
(admin) or an author account the admin approved. Upload stores a **draft**; nothing changes for players until
that version is published. From the command line:

```bash
# local server first (tests/local-server.ts on :8888 is the default target; any port with --url)
node --experimental-strip-types scripts/data.ts upload build/packages/<id>-v1.case.zip
node --experimental-strip-types scripts/data.ts upload build/packages/<id>-v1.case.zip --publish

# publish a stored version, or roll back by publishing an older one
node --experimental-strip-types scripts/data.ts publish <id> <version>

# production: only with an explicit --url; the admin key comes from ADMIN_KEY or ~/.incidentlab-admin-key
node --experimental-strip-types scripts/data.ts upload build/packages/<id>-v1.case.zip --url https://<site>
```

- The CLI runs `validateCasePackage()` locally first, prints where it is about to write, then sends the
  evidence in 4 MiB chunks (at most 4 at once, each retried) and the small entries as named parts.
- If it fails midway, run the same command again: the server lists only the chunks it does not have yet, so
  nothing is sent twice. Evidence that another case or version already stored is never sent at all.
- Finalize re-checks everything on the server (schemas, cross-checks, the answer-leak scan, every file's
  sha256) and prints a diff against the published version: changed content keys, evidence added, removed or
  changed, and whether the answer key changed.
- Publishing a version whose answers, points, hint costs or target times differ from the live ones is refused
  while players have progress on the case (like `deploy.sh`). Pass `--accept-answer-changes` to do it anyway,
  or reset the case first.
- The server assigns version numbers (`latestVersion + 1`); the package's `manifest.version` only names the
  file.
- Limits: 100 MiB of evidence, 500 evidence files, 1 MiB per content or sealed part; unfinished uploads expire
  after 24 hours.

## Pipeline (for reference; you don't edit it)

`scripts/build-all.sh` runs every `generator/cases/*/build.py`, then `scripts/make_flags.py` merges every
`build/truth/<id>.answers.json` and `content-sealed/<id>.debrief*.md` into the server secrets, then
`scripts/package.sh` zips `build/evidence/<id>/` to `build/evidence-zips/<id>-evidence.zip` (nothing goes under
`site/`: the site serves evidence from the DB), then `scripts/make_package.py` and
`scripts/check-packages.mts` build and check the case packages, then it runs every `solutions/*/solve.sh`.
