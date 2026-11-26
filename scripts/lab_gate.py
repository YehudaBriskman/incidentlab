#!/usr/bin/env python3
"""Leak gate for lab images (#148). Stdlib only.

A lab image is public and fully inspectable, so its /case must hold exactly the public evidence zip and
nothing else. Two checks:
  1. equality: the files under /case (path + sha256) equal the zip's files, one for one;
  2. names (defence in depth): no path looks like one of our secret build artefacts (the answer keys,
     server secrets, fingerprints, case packages, solvers, sealed content).

Usage:
  lab_gate.py manifest <dir>                      print "sha256  path" for every file under <dir>, sorted
  lab_gate.py check <evidence.zip> <listing>      compare the zip with a listing (the `manifest` output,
                                                  or `sha256sum` output run inside the image at /case)
  lab_gate.py --self-test                         prove the gate fails on a planted answers file
Exit 0 when clean, 1 on any difference or forbidden name.
"""
import hashlib
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

# Our secret artefacts by name (not by loose words: real evidence has names like `*_resolve.txt`, `access-keys.csv`).
FORBIDDEN_NAME = re.compile(r"^(secrets\.json|fingerprints\.json|[^/]*answers[^/]*\.json|solve\.sh|[^/]*\.case\.zip)$", re.I)
FORBIDDEN_DIR = {"truth", "solutions", "content-sealed", "sealed", "generated"}


def forbidden(path: str) -> bool:
    parts = path.strip("./").split("/")
    return bool(FORBIDDEN_NAME.match(parts[-1])) or any(p in FORBIDDEN_DIR for p in parts[:-1])


def zip_manifest(zip_path: str) -> dict[str, str]:
    """path (without the zip's single top-level folder) -> sha256."""
    out: dict[str, str] = {}
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if not n.endswith("/")]
        tops = {n.split("/", 1)[0] for n in names}
        if len(tops) != 1:
            raise SystemExit(f"[lab-gate] {zip_path}: expected one top-level folder, found {sorted(tops)}")
        for name in names:
            out[name.split("/", 1)[1]] = hashlib.sha256(zf.read(name)).hexdigest()
    return out


def dir_manifest(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    base = Path(root)
    for path in sorted(p for p in base.rglob("*") if p.is_file()):
        out[path.relative_to(base).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def parse_listing(text: str) -> dict[str, str]:
    """`sha256sum` / `manifest` lines: "<sha256>  <path>" (path may start with ./)."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        sha, _, path = line.partition("  ")
        out[path.strip().removeprefix("./")] = sha.strip()
    return out


def compare(expected: dict[str, str], actual: dict[str, str]) -> list[str]:
    problems = [f"forbidden name: {p}" for p in sorted(actual) if forbidden(p)]
    problems += [f"extra file not in the public zip: {p}" for p in sorted(set(actual) - set(expected))]
    problems += [f"missing from the image: {p}" for p in sorted(set(expected) - set(actual))]
    problems += [f"content differs from the zip: {p}" for p in sorted(set(expected) & set(actual)) if expected[p] != actual[p]]
    return problems


def self_test() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        case = Path(tmp, "demo")
        (case / "logs").mkdir(parents=True)
        (case / "logs" / "app.log").write_text("hello\n")
        (case / "dns").mkdir()
        (case / "dns" / "zf_crc64_resolve.txt").write_text("not a solver\n")
        zip_path = Path(tmp, "demo-evidence.zip")
        with zipfile.ZipFile(zip_path, "w") as zf:
            for p in sorted(case.rglob("*")):
                if p.is_file():
                    zf.write(p, p.relative_to(tmp).as_posix())
        expected = zip_manifest(str(zip_path))
        assert compare(expected, dir_manifest(str(case))) == [], "a clean copy must pass"
        (case / "answers.json").write_text('{"q1": "x"}')
        planted = compare(expected, dir_manifest(str(case)))
        assert "forbidden name: answers.json" in planted and "extra file not in the public zip: answers.json" in planted, planted
        (case / "answers.json").unlink()
        (case / "logs" / "app.log").write_text("changed\n")
        assert compare(expected, dir_manifest(str(case))) == ["content differs from the zip: logs/app.log"]
        assert forbidden("solutions/x/solve.sh") and forbidden("truth/x.json") and not forbidden("iam/access-keys.csv")
    print("[lab-gate] self-test OK")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--self-test"]:
        return self_test()
    if len(argv) == 2 and argv[0] == "manifest":
        for path, sha in sorted(dir_manifest(argv[1]).items()):
            print(f"{sha}  {path}")
        return 0
    if len(argv) == 3 and argv[0] == "check":
        expected = zip_manifest(argv[1])
        actual = parse_listing(Path(argv[2]).read_text())
        problems = compare(expected, actual)
        for p in problems:
            print(f"[lab-gate] {p}")
        if problems:
            print(f"[lab-gate] FAIL: {len(problems)} problem(s)")
            return 1
        print(f"[lab-gate] OK: {len(expected)} files, identical to the public zip, no forbidden names")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
