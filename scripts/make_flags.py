#!/usr/bin/env python3
"""Build the server-side answer key for the IncidentLab site (every released case).

Case `3am-outage` (legacy pipeline): reads build/truth/repo.json + build/truth/logs.json plus the
canonical constants in generator/timeline.py and cross-checks them.
Every other case (docs/CASE_CONTRACT.md): reads build/truth/<id>.answers.json, written by
generator/cases/<id>/build.py.

Points and hint costs come from site/src/content/cases/<id>.json; debriefs from
content-sealed/<id>.debrief.md (+ optional <id>.debrief.he.md). Writes:

  site/server/generated/secrets.json  {cases: {<id>: {title, answers (normalized), debrief, debriefHe, questions}}}
                                      (bundled server-side only; gitignored; NEVER served to browsers)
  build/truth/answers.json            3am-outage plaintext answers (read by solutions/solve.sh)
  build/truth/all-answers.json        every case's plaintext answers (instructor only; NEVER deployed)

Normalization must match normalizeAnswer() in site/shared/normalize.ts:
  trim -> lowercase -> collapse runs of whitespace to a single space.
Every run first checks normalize_answer() against site/shared/normalize-vectors.json, the vectors the
TypeScript implementation is tested against too, and answer_fingerprint() against
site/shared/fingerprint-vectors.json (its twin is site/shared/answer-fingerprint.ts).

Python 3 stdlib only. Run from anywhere; paths are resolved from the repo root.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))

import timeline  # noqa: E402

TRUTH_DIR = ROOT / "build" / "truth"
SECRETS_OUT = ROOT / "site" / "server" / "generated" / "secrets.json"
SEALED_DIR = ROOT / "content-sealed"
CASES_JSON_DIR = ROOT / "site" / "src" / "content" / "cases"
CASE_GENERATORS = ROOT / "generator" / "cases"
ANSWERS_OUT = TRUTH_DIR / "answers.json"
ALL_ANSWERS_OUT = TRUTH_DIR / "all-answers.json"
NORMALIZE_VECTORS = ROOT / "site" / "shared" / "normalize-vectors.json"
FINGERPRINT_VECTORS = ROOT / "site" / "shared" / "fingerprint-vectors.json"
QUESTION_IDS = ["q1", "q2", "q3", "q4", "q5", "q6"]

_HMS_RE = re.compile(r"(\d{2}:\d{2}:\d{2})")


def fail(message: str) -> "None":
    print(f"\n[make_flags] FATAL: {message}\n", file=sys.stderr)
    sys.exit(1)


# JavaScript's \s (and what String.prototype.trim removes). Python's \s differs (it includes \x1c-\x1f and
# leaves out U+FEFF), so the set is spelled out to match site/shared/normalize.ts exactly.
_JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_WHITESPACE_RUN = re.compile("[" + _JS_WHITESPACE + "]+")


def normalize_answer(raw: str) -> str:
    # Mirrors site/shared/normalize.ts: raw.trim().toLowerCase().replace(/\s+/g, " ")
    return _JS_WHITESPACE_RUN.sub(" ", raw.strip(_JS_WHITESPACE).lower())


def check_normalize_vectors() -> None:
    vectors = load_json(NORMALIZE_VECTORS).get("vectors")
    if not isinstance(vectors, list) or not vectors:
        fail(f"{NORMALIZE_VECTORS.relative_to(ROOT)} has no vectors")
    for vector in vectors:
        got = normalize_answer(vector["input"])
        if got != vector["expected"]:
            fail(f"normalize_answer({vector['input']!r}) = {got!r}, expected {vector['expected']!r} "
                 f"({NORMALIZE_VECTORS.relative_to(ROOT)}); keep it in step with site/shared/normalize.ts")


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


def case_config(case_id: str) -> dict:
    """Title, points, hint costs/texts, target times and full commands from the case JSONs (EN + optional HE).

    Hint texts and full commands are paid content: the site bundle has them stripped
    (site/vite.config.ts) and the server hands them out only after charging for them.
    """
    data = load_json(CASES_JSON_DIR / f"{case_id}.json")
    he_path = CASES_JSON_DIR / f"{case_id}.he.json"
    he = load_json(he_path) if he_path.is_file() else {}
    est_minutes = int(data.get("estMinutes", 60))
    questions = {q.get("id"): q for q in data.get("questions", []) if isinstance(q, dict)}
    he_questions = {q.get("id"): q for q in he.get("questions", []) if isinstance(q, dict)}
    config: dict[str, dict] = {}
    hints: dict[str, list] = {}
    for qid in QUESTION_IDS:
        q = questions.get(qid)
        if q is None:
            fail(f"{case_id}.json has no question {qid}")
        target_minutes = float(q.get("targetMinutes") or est_minutes / len(QUESTION_IDS))
        config[qid] = {
            "points": int(q["points"]),
            "hintCosts": [int(h["cost"]) for h in q["hints"]],
            "targetSeconds": max(60, round(target_minutes * 60)),
        }
        he_hints = (he_questions.get(qid) or {}).get("hints") or []
        hints[qid] = []
        for i, h in enumerate(q["hints"]):
            text = h.get("text")
            if not text:
                fail(f"{case_id}.json {qid} hint {i + 1} has no text")
            he_text = he_hints[i].get("text") if i < len(he_hints) and isinstance(he_hints[i], dict) else None
            hints[qid].append({"en": text, "he": he_text or None})
    tools: dict[str, dict] = {}
    for section in data.get("toolbox", []):
        for item in section.get("items", []):
            tool_id, command = item.get("id"), item.get("command")
            if not tool_id or not command:
                continue
            tools[tool_id] = {"command": command, "powershell": item.get("powershell") or None, "lab": item.get("lab") or None}
    return {
        "title": str(data.get("title", case_id)),
        "estMinutes": est_minutes,
        "questions": config,
        "hints": hints,
        "tools": tools,
    }


def debriefs(case_id: str) -> tuple[str, str | None]:
    en = SEALED_DIR / f"{case_id}.debrief.md"
    if not en.is_file():
        fail(f"missing {en.relative_to(ROOT)}")
    he = SEALED_DIR / f"{case_id}.debrief.he.md"
    return en.read_text(encoding="utf-8"), (he.read_text(encoding="utf-8") if he.is_file() else None)


def contract_case_answers(case_id: str) -> dict[str, str]:
    data = load_json(TRUTH_DIR / f"{case_id}.answers.json")
    if data.get("caseId") != case_id:
        fail(f"{case_id}.answers.json has caseId={data.get('caseId')!r}")
    answers = data.get("answers")
    if not isinstance(answers, dict):
        fail(f"{case_id}.answers.json has no answers object")
    out: dict[str, str] = {}
    for qid in QUESTION_IDS:
        value = str(answers.get(qid, "")).strip()
        if not value:
            fail(f"{case_id}: empty answer for {qid}")
        out[qid] = value
    return out


def discover_contract_cases() -> list[str]:
    if not CASE_GENERATORS.is_dir():
        return []
    return sorted(p.parent.name for p in CASE_GENERATORS.glob("*/build.py"))


def collect_answers() -> dict[str, dict[str, str]]:
    """Every case's plaintext answers (3am-outage first, then the contract cases in id order)."""
    check_normalize_vectors()
    all_answers: dict[str, dict[str, str]] = {}
    repo = load_json(TRUTH_DIR / "repo.json")
    logs = load_json(TRUTH_DIR / "logs.json")
    all_answers[timeline.CASE_ID] = build_answers(repo, logs)
    for case_id in discover_contract_cases():
        all_answers[case_id] = contract_case_answers(case_id)
    return all_answers


def sealed_case(case_id: str, answers: dict[str, str]) -> dict:
    """One case's server-only record (CaseSealedSchema in site/shared/case-records.ts)."""
    debrief_en, debrief_he = debriefs(case_id)
    return {
        **case_config(case_id),
        "answers": {qid: normalize_answer(a) for qid, a in answers.items()},
        "debrief": debrief_en,
        "debriefHe": debrief_he,
    }


def answer_fingerprint(sealed: dict) -> str:
    """What scoring depends on (answers, points, hint costs). deploy.sh refuses a deploy that changes it."""
    return hashlib.sha256(
        json.dumps({"answers": sealed["answers"], "questions": sealed["questions"]}, sort_keys=True).encode("utf-8")
    ).hexdigest()


def check_fingerprint_vectors() -> None:
    """answer_fingerprint() has a TypeScript twin (site/shared/answer-fingerprint.ts, used by case uploads)."""
    vectors = load_json(FINGERPRINT_VECTORS).get("vectors")
    if not isinstance(vectors, list) or not vectors:
        fail(f"{FINGERPRINT_VECTORS.relative_to(ROOT)} has no vectors")
    for vector in vectors:
        if answer_fingerprint(vector["input"]) != vector["fingerprint"]:
            fail(f"answer_fingerprint() disagrees with {FINGERPRINT_VECTORS.relative_to(ROOT)}; "
                 "keep it in step with site/shared/answer-fingerprint.ts")


def main() -> int:
    check_fingerprint_vectors()
    all_answers = collect_answers()
    cases = {case_id: sealed_case(case_id, answers) for case_id, answers in all_answers.items()}

    SECRETS_OUT.parent.mkdir(parents=True, exist_ok=True)
    SECRETS_OUT.write_text(json.dumps({"cases": cases}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Fingerprint of what scoring depends on, per case: answers, points, hint costs. deploy.sh compares it
    # with the last deployed one, because changing these under players who are mid-case breaks their runs.
    fingerprints = {case_id: answer_fingerprint(c) for case_id, c in cases.items()}
    (TRUTH_DIR / "fingerprints.json").write_text(json.dumps(fingerprints, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    legacy = all_answers[timeline.CASE_ID]
    ANSWERS_OUT.parent.mkdir(parents=True, exist_ok=True)
    ANSWERS_OUT.write_text(
        json.dumps(
            {
                "caseId": timeline.CASE_ID,
                "_warning": "PLAINTEXT ANSWERS. Instructor only. Never deploy or share with players.",
                "answers": legacy,
                "normalized": {qid: normalize_answer(a) for qid, a in legacy.items()},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    ALL_ANSWERS_OUT.write_text(
        json.dumps({"_warning": "PLAINTEXT ANSWERS. Instructor only. Never deploy or share with players.", "cases": all_answers}, indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )

    for case_id, answers in all_answers.items():
        print(f"[make_flags] case: {case_id}")
        for qid, ans in answers.items():
            print(f"  {qid:<4} {ans}")
    print(f"[make_flags] wrote {SECRETS_OUT.relative_to(ROOT)} (server-only; gitignored)")
    print(f"[make_flags] wrote {ALL_ANSWERS_OUT.relative_to(ROOT)} (plaintext; do not deploy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
