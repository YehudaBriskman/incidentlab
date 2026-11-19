#!/usr/bin/env python3
"""Build salted answer hashes for the IncidentLab site.

Reads the generator truth files (build/truth/repo.json, build/truth/logs.json) plus the
canonical constants in generator/timeline.py, cross-checks them, and writes:

  site/src/generated/flags.json   salted SHA-256 hashes (deployed; contains no plaintext)
  build/truth/answers.json        plaintext answers (instructor only; NEVER deployed)

Normalization must match normalizeAnswer() in site/src/content/schema.ts:
  trim -> lowercase -> collapse runs of whitespace to a single space.

Python 3 stdlib only. Run from anywhere; paths are resolved from the repo root.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))

import timeline  # noqa: E402

TRUTH_DIR = ROOT / "build" / "truth"
FLAGS_OUT = ROOT / "site" / "src" / "generated" / "flags.json"
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


def hash_flag(normalized: str) -> dict[str, str]:
    salt = secrets.token_hex(8)
    digest = hashlib.sha256((salt + normalized).encode("utf-8")).hexdigest()
    return {"salt": salt, "sha256": digest}


def main() -> int:
    repo = load_json(TRUTH_DIR / "repo.json")
    logs = load_json(TRUTH_DIR / "logs.json")
    answers = build_answers(repo, logs)

    flags = {qid: hash_flag(normalize_answer(ans)) for qid, ans in answers.items()}

    # Self-check: every hash verifies against its normalized answer.
    for qid, ans in answers.items():
        salt, digest = flags[qid]["salt"], flags[qid]["sha256"]
        if hashlib.sha256((salt + normalize_answer(ans)).encode("utf-8")).hexdigest() != digest:
            fail(f"self-check failed for {qid}")

    FLAGS_OUT.parent.mkdir(parents=True, exist_ok=True)
    FLAGS_OUT.write_text(
        json.dumps({"caseId": timeline.CASE_ID, "flags": flags}, indent=2) + "\n", encoding="utf-8"
    )
    ANSWERS_OUT.parent.mkdir(parents=True, exist_ok=True)
    ANSWERS_OUT.write_text(
        json.dumps(
            {
                "caseId": timeline.CASE_ID,
                "_warning": "PLAINTEXT ANSWERS. Instructor only. Never deploy or share with players.",
                "answers": answers,
                "normalized": {qid: normalize_answer(a) for qid, a in answers.items()},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"[make_flags] case: {timeline.CASE_ID}")
    print(f"  {'id':<4} {'answer':<20} {'normalized':<20} {'salt':<17} sha256")
    print(f"  {'-' * 4} {'-' * 20} {'-' * 20} {'-' * 17} {'-' * 16}")
    for qid, ans in answers.items():
        f = flags[qid]
        print(f"  {qid:<4} {ans:<20} {normalize_answer(ans):<20} {f['salt']:<17} {f['sha256'][:16]}...")
    print(f"[make_flags] wrote {FLAGS_OUT.relative_to(ROOT)}")
    print(f"[make_flags] wrote {ANSWERS_OUT.relative_to(ROOT)} (plaintext; do not deploy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
