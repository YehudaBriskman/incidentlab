#!/usr/bin/env python3
"""Build the evidence pack and answer key for IncidentLab case `the-insider-commit`.

Run from anywhere: python3 generator/cases/the-insider-commit/build.py
Outputs (recreated every run):
  build/evidence/the-insider-commit/...           evidence pack (text, plus a git bundle)
  build/truth/the-insider-commit.answers.json     answer key
  build/repo/the-insider-commit/zfold             working git repo (scratch)
Stdlib only, fixed seeds, pinned git dates: output is byte-identical between runs.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))

import artifacts as A  # noqa: E402
import ops as O  # noqa: E402
import repo as R  # noqa: E402

CASE_ID = "the-insider-commit"
ROOT = HERE.parents[2]
BUILD = ROOT / "build"
EV = BUILD / "evidence" / CASE_ID
TRUTH = BUILD / "truth" / f"{CASE_ID}.answers.json"
REPO_WORK = BUILD / "repo" / CASE_ID / "zfold"

FILES: list[tuple[str, str]] = [
    ("README_FIRST.txt", "this file"),
    ("perf/sshd-auth-timing.csv", "probe logins to bench-01..04 every 10 min (epoch)"),
    ("perf/hyperfine-ssh-login.txt", "client-side login benchmarks, before/after"),
    ("perf/perf-report-before.txt", "perf report of sshd on bench-01, 2026-11-10"),
    ("perf/perf-report-after.txt", "perf report of sshd on bench-01, 2026-11-17"),
    ("perf/gdb-got-audit.txt", "where each sshd GOT slot points (live process)"),
    ("perf/valgrind-zf.txt", "valgrind on distro build vs git build"),
    ("fleet/dpkg-all-hosts.log", "dpkg.log of every host, merged (CET)"),
    ("release/SHA256SUMS.txt", "tarball hashes and signature checks"),
    ("release/tarball-vs-git-tag.diff", "diff -ruN: git tag export vs release tarball, two releases"),
    ("release/fixture-strings.txt", "strings -a -f of the tarball's tests/files/*.zf"),
    ("release/stage1-recovered.txt", "SecOps sandbox capture, defanged"),
    ("binary/nm-libzfold.txt", "symbol tables of two libzfold builds"),
    ("binary/objdump-zf_crc64_resolve.txt", "disassembly of the CRC64 ifunc resolver"),
    ("distro/changelog", "Corvid zfold package changelog"),
    ("distro/buildd-logs.txt", "Corvid package build logs, two versions"),
    ("distro/bug-10442.txt", "Corvid bug asking for the new release"),
    ("mail/zfold-devel.mbox", "upstream mailing list archive (excerpt)"),
    ("chat/incident-channel.json", "Halyard incident chat"),
    ("repo/git-log.txt", "upstream git log -p --all (text)"),
    ("repo/zfold.bundle", "same history as a git bundle (binary)"),
]


def die(msg: str) -> None:
    raise SystemExit(f"[{CASE_ID}] CROSS-CHECK FAILED: {msg}")


def write(rel: str, data: str | bytes) -> None:
    p = EV / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data.encode() if isinstance(data, str) else data)


def main() -> None:
    if EV.exists():
        shutil.rmtree(EV)
    EV.mkdir(parents=True)
    TRUTH.parent.mkdir(parents=True, exist_ok=True)

    # ---- upstream repo ----------------------------------------------------------------------
    rr = R.build_repo(REPO_WORK)
    (EV / "repo").mkdir(parents=True, exist_ok=True)
    R.export_log(REPO_WORK, EV / "repo" / "git-log.txt")
    R.make_bundle(REPO_WORK, EV / "repo" / "zfold.bundle")

    # ---- release tarballs vs tags ---------------------------------------------------------
    g550, g551 = rr.tag_trees["v5.5.0"], rr.tag_trees["v5.5.1"]
    t550 = A.tarball_tree("5.5.0", g550, evil=False)
    t551 = A.tarball_tree("5.5.1", g551, evil=True)
    d550 = A.diff_ruN("zfold-git-v5.5.0", "zfold-5.5.0", g550, t550,
                      "2026-10-27 03:02:38.000000000 +0000", "2026-10-27 03:31:14.000000000 +0000")
    d551 = A.diff_ruN("zfold-git-v5.5.1", "zfold-5.5.1", g551, t551,
                      "2026-11-09 10:05:12.000000000 +0000", "2026-11-09 10:19:46.000000000 +0000")
    write("release/tarball-vs-git-tag.diff",
          "# Halyard SecOps, 2026-11-18. For each release: git archive of the tag (left) vs the extracted\n"
          "# upstream release tarball (right), compared with: TZ=UTC diff -ruN <left> <right>\n"
          "# A file that exists on only one side is shown against an empty file dated 1970-01-01.\n\n"
          "######## zfold 5.5.0 : git tag v5.5.0 vs zfold-5.5.0.tar.gz ########\n" + d550 +
          "\n######## zfold 5.5.1 : git tag v5.5.1 vs zfold-5.5.1.tar.gz ########\n" + d551)
    only550 = {p for p in t550 if p not in g550}
    only551 = {p for p in t551 if p not in g551}
    if only551 - only550 != {A.EVIL_M4}:
        die(f"tarball-only delta is {sorted(only551 - only550)}")

    fs_text, marker_hits = A.fixture_strings(t551)
    if marker_hits != [R.PAYLOAD_FIXTURE]:
        die(f"marker regex matches {marker_hits}")
    write("release/fixture-strings.txt", fs_text)
    write("release/stage1-recovered.txt", A.STAGE1_RECOVERED)
    write("release/SHA256SUMS.txt", A.sha256sums(t550, t551, g550, g551))

    # ---- distro + binary --------------------------------------------------------------------
    write("distro/buildd-logs.txt",
          A.build_log("5.5.0", "1", "Thu, 29 Oct 2026 08:12:44 +0000", "2026-10-29T08:14:02Z", evil=False) + "\n" +
          A.build_log("5.5.1", "1", "Tue, 10 Nov 2026 16:04:31 +0000", "2026-11-10T16:05:57Z", evil=True))
    write("distro/changelog", O.CHANGELOG)
    write("distro/bug-10442.txt", O.BUG)
    write("binary/nm-libzfold.txt", A.nm_listing())
    write("binary/objdump-zf_crc64_resolve.txt", A.OBJDUMP)

    # ---- ops ----------------------------------------------------------------------------------
    plan = O.fleet_plan()
    dpkg = O.dpkg_fleet(plan)
    write("fleet/dpkg-all-hosts.log", dpkg)
    csv, first_slow = O.timing_csv(plan)
    write("perf/sshd-auth-timing.csv", csv)
    write("perf/perf-report-before.txt", O.PERF_BEFORE)
    write("perf/perf-report-after.txt", O.PERF_AFTER)
    got, hooked = O.got_audit()
    write("perf/gdb-got-audit.txt", got)
    write("perf/hyperfine-ssh-login.txt", O.HYPERFINE)
    write("perf/valgrind-zf.txt", O.VALGRIND)
    write("chat/incident-channel.json", O.chat())
    write("mail/zfold-devel.mbox", O.mbox())
    write("README_FIRST.txt", O.readme(FILES))

    # ---- cross-checks -----------------------------------------------------------------------
    bad_local = O.BENCH01_BAD.astimezone(timezone.utc)
    if not (0 < (first_slow - bad_local).total_seconds() <= 600):
        die(f"bench-01 slowdown {first_slow} does not follow the install {bad_local}")
    exposed_from_log = sorted({ln.split()[0] for ln in dpkg.splitlines()
                               if re.fullmatch(r"\S+ \S+ \S+ status installed libzfold5:amd64 5\.5\.1-1", ln)})
    exposed = O.exposed_hosts(plan)
    if exposed_from_log != exposed:
        die(f"exposed hosts mismatch: log={exposed_from_log} plan={exposed}")
    for rel, _ in FILES:
        if not (EV / rel).is_file():
            die(f"missing evidence file {rel}")
    actual = sorted(str(p.relative_to(EV)) for p in EV.rglob("*") if p.is_file())
    if actual != sorted(r for r, _ in FILES):
        die(f"unexpected evidence files: {sorted(set(actual) ^ {r for r, _ in FILES})}")
    readme = (EV / "README_FIRST.txt").read_text()
    answers = {
        "q1": "5.5.1",
        "q2": A.EVIL_M4,
        "q3": R.PAYLOAD_FIXTURE.rsplit("/", 1)[1],
        "q4": hooked,
        "q5": rr.fixture_add_sha7,
        "q6": str(len(exposed)),
    }
    for q, a in answers.items():
        if q != "q6" and a.lower() in readme.lower():
            die(f"answer {q} leaks into README_FIRST.txt")
    total = sum(p.stat().st_size for p in EV.rglob("*") if p.is_file())
    if total > 40 * 1024 * 1024:
        die(f"evidence too large: {total} bytes")

    TRUTH.write_text(json.dumps({"caseId": CASE_ID, "answers": answers}, indent=2) + "\n")
    print(f"[{CASE_ID}] evidence: {EV.relative_to(ROOT)} ({len(actual)} files, {total} bytes)")
    print(f"[{CASE_ID}] truth:    {TRUTH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
