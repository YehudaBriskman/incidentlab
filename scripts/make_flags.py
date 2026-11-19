#!/usr/bin/env python3
"""Build the server-side answer key for the IncidentLab site.

Reads the generator truth files (build/truth/repo.json, build/truth/logs.json) plus the
canonical constants in generator/timeline.py, cross-checks them, and writes:

  site/server/generated/secrets.json  normalized answers + sealed debrief for the Netlify Function
                                      (bundled server-side only; gitignored; NEVER served to browsers)
  build/truth/answers.json            plaintext answers (instructor only; NEVER deployed)

Normalization must match normalizeAnswer() in site/src/content/schema.ts:
  trim -> lowercase -> collapse runs of whitespace to a single space.

Python 3 stdlib only. Run from anywhere; paths are resolved from the repo root.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))

import timeline  # noqa: E402

TRUTH_DIR = ROOT / "build" / "truth"
SECRETS_OUT = ROOT / "site" / "server" / "generated" / "secrets.json"
DEBRIEF_SRC = ROOT / "content-sealed" / f"{timeline.CASE_ID}.debrief.md"
ANSWERS_OUT = TRUTH_DIR / "answers.json"

_HMS_RE = re.compile(r"(\d{2}:\d{2}:\d{2})")


def fail(message: str) -> "None":
    print(f"\n[make_flags] FATAL: {message}\n", file=sys.stderr)
    sys.exit(1)


def normalize_answer(raw: str) -> str:
    # Mirrors JS: raw.trim().toLowerCase().replace(/\s+/g, " ")
    return re.sub(r"\s+", " ", raw.strip().lower())


def load_json(path: Path) -> dict:
    if not path.is_file():
        fail(f"missing {path.relative_to(ROOT)}; run the generators first (scripts/build-all.sh)")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")
    if not isinstance(data, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return data


def require(data: dict, key: str, source: str) -> object:
    if key not in data or data[key] in (None, ""):
        fail(f"{source} has no '{key}'")
    return data[key]


def build_answers(repo: dict, logs: dict) -> dict[str, str]:
    # q1: first 5xx (UTC, HH:MM:SS), cross-checked against the log generator's truth.
    q1 = timeline.FIRST_5XX.astimezone(timeline.UTC).strftime("%H:%M:%S")
    logged_first = str(require(logs, "first_5xx_utc", "logs.json"))
    match = _HMS_RE.search(logged_first)
    if not match or match.group(1) != q1:
        fail(f"q1 mismatch: timeline.FIRST_5XX={q1} but logs.json first_5xx_utc={logged_first!r}")

    # q2: short SHA of the bad commit.
    q2 = str(require(repo, "bad_commit_sha7", "repo.json")).strip()
    if not re.fullmatch(r"[0-9a-f]{7}", q2):
        fail(f"q2: repo.json bad_commit_sha7={q2!r} is not a 7-char lowercase hex SHA")

    # q3: poison order.
    q3 = timeline.POISON_ORDER

    # q4: dangerous function.
    q4 = str(require(repo, "bad_function", "repo.json")).strip()

    # q5: total submissions of the poison order, cross-checked.
    q5_int = len(timeline.POISON_ATTEMPTS)
    logged_attempts = require(logs, "poison_attempts", "logs.json")
    logged_count = len(logged_attempts) if isinstance(logged_attempts, list) else int(str(logged_attempts))
    if logged_count != q5_int:
        fail(f"q5 mismatch: timeline has {q5_int} poison attempts, logs.json has {logged_count}")
    q5 = str(q5_int)

    # q6: unique real customers with >=1 5xx on POST /api/checkout.
    q6_raw = require(logs, "q6_unique_customers", "logs.json")
    try:
        q6_int = int(str(q6_raw))
    except ValueError:
        fail(f"q6: logs.json q6_unique_customers={q6_raw!r} is not an integer")
    if q6_int <= 0:
        fail(f"q6: q6_unique_customers must be positive, got {q6_int}")
    q6 = str(q6_int)

    return {"q1": q1, "q2": q2, "q3": q3, "q4": q4, "q5": q5, "q6": q6}


def main() -> int:
    repo = load_json(TRUTH_DIR / "repo.json")
    logs = load_json(TRUTH_DIR / "logs.json")
    answers = build_answers(repo, logs)
    normalized = {qid: normalize_answer(a) for qid, a in answers.items()}

    if not DEBRIEF_SRC.is_file():
        fail(f"missing {DEBRIEF_SRC.relative_to(ROOT)}")
    debrief = DEBRIEF_SRC.read_text(encoding="utf-8")

    SECRETS_OUT.parent.mkdir(parents=True, exist_ok=True)
    SECRETS_OUT.write_text(
        json.dumps({"caseId": timeline.CASE_ID, "answers": normalized, "debrief": debrief}, indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    ANSWERS_OUT.parent.mkdir(parents=True, exist_ok=True)
    ANSWERS_OUT.write_text(
        json.dumps(
            {
                "caseId": timeline.CASE_ID,
                "_warning": "PLAINTEXT ANSWERS. Instructor only. Never deploy or share with players.",
                "answers": answers,
                "normalized": normalized,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"[make_flags] case: {timeline.CASE_ID}")
    print(f"  {'id':<4} {'answer':<20} normalized")
    print(f"  {'-' * 4} {'-' * 20} {'-' * 20}")
    for qid, ans in answers.items():
        print(f"  {qid:<4} {ans:<20} {normalized[qid]}")
    print(f"[make_flags] wrote {SECRETS_OUT.relative_to(ROOT)} (server-only; gitignored)")
    print(f"[make_flags] wrote {ANSWERS_OUT.relative_to(ROOT)} (plaintext; do not deploy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
