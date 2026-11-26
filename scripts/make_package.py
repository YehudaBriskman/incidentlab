#!/usr/bin/env python3
"""Build one upload package per case: build/packages/<id>-v<n>.case.zip (format: docs/CASE_CONTRACT.md).

  manifest.json            CasePackageManifestSchema: id, version, langs, evidence [{path, format, size, sha256, chunks, explorer}]
  content.<lang>.json      public case content (CaseContentSchema): the case JSON without hint texts or commands
  sealed/answers.json      normalized answers {qN: answer}
  sealed/hints.json        hint texts {qN: [{en, he}]}
  sealed/commands.json     runnable toolbox commands {toolId: {command, powershell}}
  sealed/scoring.json      {title, estMinutes, questions: {qN: {points, hintCosts, targetSeconds}}}
  sealed/debrief.en.md     the sealed debrief (and sealed/debrief.he.md when there is one)
  evidence.zip             the download, exactly as scripts/package.sh built it
  evidence/<path>          every raw evidence file, binaries (.pcap, .bundle) included

The sealed part is the same record make_flags.py writes to the server secrets (it reuses its functions).
Packages contain ANSWERS: they are written only under build/ (gitignored) and must never be served.

Deterministic: sorted entries, fixed timestamps and permissions, so the same inputs give the same sha256.
Needs scripts/make_flags.py's inputs plus scripts/package.sh's output (build/evidence-zips/<id>-evidence.zip).

Usage: python3 scripts/make_package.py [--version N] [case-id ...]   (default: every case)
Python 3 stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_flags  # noqa: E402

ROOT = make_flags.ROOT
EVIDENCE_DIR = ROOT / "build" / "evidence"
EVIDENCE_ZIPS = ROOT / "build" / "evidence-zips"
OUT_DIR = ROOT / "build" / "packages"

# Keep in step with site/shared/case-records.ts.
EVIDENCE_CHUNK_BYTES = 4 * 1024 * 1024
# Binary twins the Explorer skips (scripts/package.sh, docs/CASE_CONTRACT.md).
BINARY_SUFFIXES = (".bundle", ".pcap", ".tar.gz", ".bin")
BINARY_FORMATS = {".bundle": "git bundle", ".pcap": "pcap (binary)", ".tar.gz": "tar.gz archive", ".bin": "binary"}

ZIP_DATE_TIME = (2026, 11, 13, 8, 0, 0)  # the fixed mtime scripts/package.sh stamps on evidence
ZIP_FILE_MODE = 0o100644


def fail(message: str) -> "None":
    print(f"\n[make_package] FATAL: {message}\n", file=sys.stderr)
    sys.exit(1)


def strip_paid_content(raw: object) -> object:
    """Mirrors stripPaidContent() in site/shared/case-records.ts: hints keep only `cost`, toolbox items lose
    `command` and `powershell`. scripts/check-packages.mts checks the result against the TypeScript version."""
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    if isinstance(raw.get("questions"), list):
        out["questions"] = [
            {**q, "hints": [{"cost": h.get("cost")} if isinstance(h, dict) else h for h in q["hints"]]}
            if isinstance(q, dict) and isinstance(q.get("hints"), list) else q
            for q in raw["questions"]
        ]
    if isinstance(raw.get("toolbox"), list):
        out["toolbox"] = [
            {**s, "items": [
                {k: v for k, v in item.items() if k not in ("command", "powershell")} if isinstance(item, dict) else item
                for item in s["items"]
            ]}
            if isinstance(s, dict) and isinstance(s.get("items"), list) else s
            for s in raw["toolbox"]
        ]
    return out


def json_bytes(data: object) -> bytes:
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def evidence_files(case_id: str) -> list[tuple[str, Path]]:
    root = EVIDENCE_DIR / case_id
    if not (root / "README_FIRST.txt").is_file():
        fail(f"{root.relative_to(ROOT)} has no README_FIRST.txt; run the generators first (scripts/build-all.sh)")
    files = [(p.relative_to(root).as_posix(), p) for p in root.rglob("*") if p.is_file()]
    return sorted(files)


def evidence_format(rel: str, formats: dict[str, str]) -> str:
    if rel in formats:
        return formats[rel]
    for suffix, label in BINARY_FORMATS.items():
        if rel.endswith(suffix):
            return label
    return "file"


def build_package(case_id: str, answers: dict[str, str], version: int) -> Path:
    content_en_path = make_flags.CASES_JSON_DIR / f"{case_id}.json"
    content_he_path = make_flags.CASES_JSON_DIR / f"{case_id}.he.json"
    authored = {"en": make_flags.load_json(content_en_path)}
    if content_he_path.is_file():
        authored["he"] = make_flags.load_json(content_he_path)
    for lang, data in authored.items():
        if data.get("id") != case_id:
            fail(f"{case_id} ({lang}) case JSON has id={data.get('id')!r}")

    sealed = make_flags.sealed_case(case_id, answers)
    formats = {e["path"]: e["format"] for e in authored["en"].get("evidence", []) if isinstance(e, dict) and "path" in e}

    evidence_zip = EVIDENCE_ZIPS / f"{case_id}-evidence.zip"
    if not evidence_zip.is_file():
        fail(f"missing {evidence_zip.relative_to(ROOT)}; run scripts/package.sh first")

    entries: list[tuple[str, bytes, int]] = []  # (zip name, bytes, compression)
    manifest_evidence = []
    for rel, path in evidence_files(case_id):
        data = path.read_bytes()
        manifest_evidence.append({
            "path": rel,
            "format": evidence_format(rel, formats),
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "chunks": math.ceil(len(data) / EVIDENCE_CHUNK_BYTES),
            "explorer": not rel.endswith(BINARY_SUFFIXES),
        })
        entries.append((f"evidence/{rel}", data, zipfile.ZIP_DEFLATED))

    manifest = {
        "schemaVersion": 1,
        "id": case_id,
        "version": version,
        "langs": list(authored),
        "evidence": manifest_evidence,
    }
    entries.append(("manifest.json", json_bytes(manifest), zipfile.ZIP_DEFLATED))
    for lang, data in authored.items():
        entries.append((f"content.{lang}.json", json_bytes(strip_paid_content(data)), zipfile.ZIP_DEFLATED))
    entries.append(("sealed/answers.json", json_bytes(sealed["answers"]), zipfile.ZIP_DEFLATED))
    entries.append(("sealed/hints.json", json_bytes(sealed["hints"]), zipfile.ZIP_DEFLATED))
    entries.append(("sealed/commands.json", json_bytes(sealed["tools"]), zipfile.ZIP_DEFLATED))
    entries.append(("sealed/scoring.json", json_bytes({
        "title": sealed["title"], "estMinutes": sealed["estMinutes"], "questions": sealed["questions"],
    }), zipfile.ZIP_DEFLATED))
    entries.append(("sealed/debrief.en.md", sealed["debrief"].encode("utf-8"), zipfile.ZIP_DEFLATED))
    if sealed["debriefHe"] is not None:
        entries.append(("sealed/debrief.he.md", sealed["debriefHe"].encode("utf-8"), zipfile.ZIP_DEFLATED))
    entries.append(("evidence.zip", evidence_zip.read_bytes(), zipfile.ZIP_STORED))  # already compressed

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{case_id}-v{version}.case.zip"
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w") as zf:
        for name, data, compression in sorted(entries, key=lambda e: e[0]):
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE_TIME)
            info.create_system = 3  # unix, so external_attr carries the mode
            info.external_attr = ZIP_FILE_MODE << 16
            info.compress_type = compression
            zf.writestr(info, data, compress_type=compression, compresslevel=9 if compression == zipfile.ZIP_DEFLATED else None)
    os.replace(tmp, out)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Build case upload packages under build/packages/.")
    parser.add_argument("--version", type=int, default=1, help="package version (default 1)")
    parser.add_argument("cases", nargs="*", help="case ids (default: every case)")
    args = parser.parse_args()
    if args.version < 1:
        fail("--version must be at least 1")

    all_answers = make_flags.collect_answers()
    case_ids = args.cases or list(all_answers)
    for case_id in case_ids:
        if case_id not in all_answers:
            fail(f"unknown case {case_id!r} (known: {', '.join(all_answers)})")
        out = build_package(case_id, all_answers[case_id], args.version)
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        print(f"[make_package] {out.relative_to(ROOT)}  {out.stat().st_size / 1024 / 1024:.1f} MiB  sha256 {digest[:16]}")
    print(f"[make_package] {len(case_ids)} package(s) in {OUT_DIR.relative_to(ROOT)}/ (contain answers; never deploy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
