#!/usr/bin/env python3
"""Run every player-facing command against the evidence with STOCK tools only.

Players must never have to install anything. This checker builds a sandbox bin/ that contains only
tools present on stock Linux/WSL, Git Bash for Windows and macOS, then runs, from inside the case's
evidence folder:
  * every toolbox `command` (bash) that has no <placeholder>,
  * every fenced ```sh / ```bash block in the hints,
  * the case solver solutions/<id>/solve.sh (solutions/solve.sh for 3am-outage), with that same PATH.
It also lints every bash and PowerShell command for tools and flags that aren't universally available.
PowerShell commands run too when `pwsh` is installed (POSIX paths only; the content uses Windows paths
with backslashes, which pwsh on Linux also accepts).

Usage: scripts/check_commands.py [case-id ...]   (default: every case)   [--verbose]
Exit 1 on any failure. Python 3 stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = ROOT / "site" / "src" / "content" / "cases"
EVIDENCE = ROOT / "build" / "evidence"
TIMEOUT_S = 30

# Present on stock Ubuntu/Debian/WSL, Git Bash for Windows and macOS.
ALLOWED_TOOLS = [
    "bash", "sh", "cat", "grep", "sed", "sort", "uniq", "cut", "tr", "head", "tail", "wc", "paste", "comm",
    "join", "date", "find", "xargs", "ls", "printf", "echo", "test", "[", "expr", "basename", "dirname", "tee",
    "nl", "od", "seq", "env", "true", "false", "mkdir", "rm", "cp", "mv", "touch", "sleep", "unzip", "fold",
    "diff", "cmp", "file", "stat", "du", "split", "pwd", "mktemp", "chmod", "uname", "id", "wait",
]
# Never allowed in player commands (need an install on at least one of the three platforms).
FORBIDDEN_TOOLS = [
    "jq", "git", "python", "python3", "node", "perl", "ruby", "tcpdump", "tshark", "wireshark", "dig", "nslookup",
    "kubectl", "helm", "aws", "column", "tac", "rev", "gawk", "xxd", "strings", "nm", "objdump", "readelf", "curl",
    "wget", "yq", "rg", "fd", "bc", "numfmt", "shuf", "timeout", "watch",
]
# Flags/features that differ between GNU and BSD/macOS or need newer versions.
BASH_LINT = [
    (re.compile(r"\bgrep\b[^|;]*\s-[a-zA-Z]*P"), "grep -P (not on macOS)"),
    (re.compile(r"\bsed\b[^|;]*\s-i\b"), "sed -i (GNU and BSD differ)"),
    (re.compile(r"\b(gensub|strftime|mktime|systime|asort|asorti|PROCINFO|patsplit)\b"), "gawk-only awk function"),
    (re.compile(r"\bmatch\([^)]*,[^)]*,[^)]*\)"), "gawk-only match() with array"),
    (re.compile(r"\bsort\b[^|;]*\s-[a-zA-Z]*V"), "sort -V (not on older macOS)"),
    (re.compile(r"\bhead\s+-n\s+-\d"), "head -n -N (GNU only)"),
    (re.compile(r"\bless\b"), "less (fine interactively, but prefer head/grep in commands players copy)"),
]
PS_LINT = [
    (re.compile(r"&&|\|\|"), "&& / || pipeline chains (PowerShell 7 only)"),
    (re.compile(r"\?\?|\?\."), "?? / ?. operators (PowerShell 7 only)"),
    (re.compile(r"\s\?\s[^:]+\s:\s"), "ternary operator (PowerShell 7 only)"),
    (re.compile(r"-Parallel\b"), "ForEach-Object -Parallel (PowerShell 7 only)"),
    (re.compile(r"-AsHashtable\b"), "ConvertFrom-Json -AsHashtable (PowerShell 6+)"),
    (re.compile(r"Select-String[^|]*-Raw\b"), "Select-String -Raw (PowerShell 7 only)"),
    (re.compile(r"-NoEmphasis\b"), "-NoEmphasis (PowerShell 7 only)"),
    (re.compile(r"Out-Host\s+-Paging|\|\s*more\b"), "interactive paging (fails in ISE and redirected output; use Select-Object -First)"),
    (re.compile(r"Join-String\b|Get-Error\b|ConvertFrom-Markdown\b|Test-Json\b"), "PowerShell 6+/7 cmdlet"),
    # Only in command position (start, or after | ; & ( { ), so file names like git-log.txt don't count.
    (re.compile(r"(?:^|[|;&({]\s*)&?\s*(jq|git|python3?|node|tcpdump|tshark|dig|kubectl|aws|curl)(?:\.exe)?(?=\s|$)", re.M), "needs an installed tool"),
]
PLACEHOLDER = re.compile(r"<[A-Za-z][\w .:/-]*>")
FENCE = re.compile(r"```(?:sh|bash|shell)?\n(.*?)```", re.S)


def build_sandbox() -> Path:
    sandbox = Path(tempfile.mkdtemp(prefix="il-stock-bin-"))
    for tool in ALLOWED_TOOLS:
        found = shutil.which(tool)
        if found:
            (sandbox / tool).symlink_to(found)
    gawk = shutil.which("gawk")
    awk = shutil.which("awk")
    if gawk:
        # --posix: reject gawk extensions, so what passes here also runs on mawk (Ubuntu) and BSD awk (macOS).
        (sandbox / "awk").write_text(f'#!/bin/sh\nexec "{gawk}" --posix "$@"\n')
        (sandbox / "awk").chmod(0o755)
    elif awk:
        (sandbox / "awk").symlink_to(awk)
    return sandbox


def tool_tokens(command: str) -> set[str]:
    """Words in command position: first word, and words after | ; && || $( ` and xargs."""
    names: set[str] = set()
    for segment in re.split(r"\|\|?|;|&&|\$\(|`|\bxargs\b|\n", command):
        words = segment.strip().split()
        while words and re.fullmatch(r"[A-Za-z_]\w*=\S*", words[0]):
            words = words[1:]  # VAR=value prefix
        if words:
            names.add(os.path.basename(words[0]))
    return names


def run_bash(command: str, cwd: Path, sandbox: Path) -> tuple[str, str]:
    env = {"PATH": str(sandbox), "LC_ALL": "C", "HOME": str(cwd), "TZ": "UTC"}
    try:
        proc = subprocess.run(["bash", "--noprofile", "--norc", "-c", command], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=TIMEOUT_S, errors="replace")
    except subprocess.TimeoutExpired:
        return "FAIL", f"timed out after {TIMEOUT_S}s"
    err = proc.stderr.strip().splitlines()
    if "command not found" in proc.stderr:
        return "MISSING", next((l for l in err if "command not found" in l), "")
    out = proc.stdout.strip()
    # grep exits 1 on "no match" and diff/cmp exit 1 on "files differ": both are answers, not errors.
    is_no_match = proc.returncode == 1 and out == "" and re.search(r"\bgrep\b", command)
    is_difference = proc.returncode == 1 and out != "" and re.search(r"\b(diff|cmp)\b", command)
    if proc.returncode not in (0, 141) and not is_no_match and not is_difference:
        return "FAIL", f"exit {proc.returncode}: {err[-1] if err else ''}"
    if out == "":
        return "EMPTY", "no output"
    return "OK", out.splitlines()[0][:100]


def run_pwsh(command: str, cwd: Path) -> tuple[str, str]:
    pwsh = shutil.which("pwsh")
    if not pwsh:
        return "SKIP", "pwsh not installed"
    try:
        proc = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-Command", command], cwd=cwd, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=TIMEOUT_S * 2, errors="replace")
    except subprocess.TimeoutExpired:
        return "FAIL", "timed out"
    if proc.returncode != 0 or proc.stderr.strip():
        return "FAIL", (proc.stderr.strip().splitlines() or [f"exit {proc.returncode}"])[0][:160]
    return ("OK", proc.stdout.strip().splitlines()[0][:100]) if proc.stdout.strip() else ("EMPTY", "no output")


def case_ids(argv: list[str]) -> list[str]:
    ids = [a for a in argv if not a.startswith("-")]
    if ids:
        return ids
    return sorted(p.stem for p in CASES_DIR.glob("*.json") if not p.name.startswith("_") and not p.name.endswith(".he.json"))


def check_case(case_id: str, sandbox: Path, verbose: bool) -> int:
    data = json.loads((CASES_DIR / f"{case_id}.json").read_text(encoding="utf-8"))
    evidence = EVIDENCE / case_id
    if not evidence.is_dir():
        print(f"[{case_id}] evidence missing: run scripts/build-all.sh first")
        return 1
    problems = 0
    counts: dict[str, int] = {}

    def report(kind: str, label: str, status: str, detail: str) -> None:
        nonlocal problems
        counts[status] = counts.get(status, 0) + 1
        bad = status in ("FAIL", "MISSING", "FORBIDDEN", "LINT")
        problems += bad
        if bad or verbose or status == "EMPTY":
            print(f"  {status:<9} {kind:<10} {label}: {detail}")

    print(f"[{case_id}]")
    for section in data["toolbox"]:
        for item in section["items"]:
            tid = item.get("id", item["title"])
            cmd = item.get("command", "")
            ps = item.get("powershell")
            forbidden = sorted(tool_tokens(cmd) & set(FORBIDDEN_TOOLS))
            if forbidden:
                report("bash", tid, "FORBIDDEN", ", ".join(forbidden))
            for pattern, why in BASH_LINT:
                if pattern.search(cmd) and not why.startswith("less"):
                    report("bash", tid, "LINT", why)
            if ps:
                for pattern, why in PS_LINT:
                    if pattern.search(ps):
                        report("powershell", tid, "LINT", why)
            if re.search(r"\b(unzip|Expand-Archive)\b|^cd\b", cmd) or PLACEHOLDER.search(cmd):
                counts["TEMPLATE"] = counts.get("TEMPLATE", 0) + 1
            elif not forbidden:
                report("bash", tid, *run_bash(cmd, evidence, sandbox))
                if ps and not PLACEHOLDER.search(ps):
                    status, detail = run_pwsh(ps, evidence)
                    if status != "SKIP":
                        report("powershell", tid, status, detail)
    for q in data["questions"]:
        for i, hint in enumerate(q["hints"], 1):
            for block in FENCE.findall(hint.get("text", "")):
                label = f"{q['id']} hint {i}"
                forbidden = sorted(tool_tokens(block) & set(FORBIDDEN_TOOLS))
                if forbidden:
                    report("hint", label, "FORBIDDEN", ", ".join(forbidden))
                elif not PLACEHOLDER.search(block) and not re.search(r"\b(Expand-Archive|Get-Content|Select-String|ForEach-Object)\b", block):
                    report("hint", label, *run_bash(block, evidence, sandbox))

    solver = ROOT / "solutions" / ("solve.sh" if case_id == "3am-outage" else f"{case_id}/solve.sh")
    if solver.is_file():
        env = {"PATH": str(sandbox), "LC_ALL": "C", "HOME": tempfile.gettempdir(), "TZ": "UTC"}
        proc = subprocess.run(["bash", str(solver), str(evidence)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300, errors="replace")
        fails = [l for l in proc.stdout.splitlines() if " FAIL" in l]
        if proc.returncode != 0 or fails:
            tail = (proc.stderr.strip().splitlines() or fails or [f"exit {proc.returncode}"])[-1]
            report("solver", solver.relative_to(ROOT).as_posix(), "FAIL", tail[:160])
        else:
            report("solver", solver.relative_to(ROOT).as_posix(), "OK", f"{sum(' PASS' in l for l in proc.stdout.splitlines())} PASS")
    print("  summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return problems


def main() -> int:
    verbose = "--verbose" in sys.argv
    sandbox = build_sandbox()
    try:
        total = sum(check_case(cid, sandbox, verbose) for cid in case_ids(sys.argv[1:]))
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)
    print(f"[check_commands] {'FAIL: ' + str(total) + ' problems' if total else 'OK'}")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
