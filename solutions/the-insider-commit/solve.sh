#!/usr/bin/env bash
# Official solver for IncidentLab case "the-insider-commit".
# Derives every answer from the evidence files only, with stock tools (grep/awk/sed/sort/cut/comm).
# No git, no GNU-only date/sort/xargs flags: the git history is read from repo/git-log.txt.
# Usage: solutions/the-insider-commit/solve.sh [evidence_dir]   (default: build/evidence/the-insider-commit)
# Compares with build/truth/the-insider-commit.answers.json and exits 1 on any mismatch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EV="${1:-$ROOT/build/evidence/the-insider-commit}"
EV="$(cd "$EV" && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/the-insider-commit.answers.json}"

TIMING="$EV/perf/sshd-auth-timing.csv"
DPKG="$EV/fleet/dpkg-all-hosts.log"
DIFF="$EV/release/tarball-vs-git-tag.diff"
STRINGS="$EV/release/fixture-strings.txt"
GOT="$EV/perf/gdb-got-audit.txt"
GITLOG="$EV/repo/git-log.txt"
for f in "$TIMING" "$DPKG" "$DIFF" "$STRINGS" "$GOT" "$GITLOG"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- q1: which zfold version brought the slowdown? ----------
# First probe on bench-01 that starts a run of 6 consecutive slow logins (> 300 ms auth):
# a sustained shift, not a one-off network blip.
jump="$(awk -F, '$2=="bench-01" && $4=="ok" {print $1, $6}' "$TIMING" | sort -n | awk '
  { ts[NR] = $1; a[NR] = $2 }
  END { for (i = 1; i <= NR - 5; i++) { ok = 1; for (j = 0; j < 6; j++) if (a[i+j] <= 300) ok = 0
        if (ok) { print ts[i]; exit } } }')"
[[ -n "$jump" ]] || { echo "q1: no sustained slowdown on bench-01" >&2; exit 3; }
# dpkg.log is CET (UTC+01:00): convert each libzfold5 install to epoch in awk (days-from-civil, no GNU
# date needed), keep the last one at or before the jump.
Q1_FULL="$(awk -v jump="$jump" '
  function epoch(d, t,   a, h, y, m, days) {
    split(d, a, "-"); y = a[1] + 0; m = a[2] + 0
    if (m <= 2) { y--; m += 12 }
    days = 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + a[3] - 719469
    split(t, h, ":")
    return days * 86400 + h[1] * 3600 + h[2] * 60 + h[3] - 3600      # CET -> UTC
  }
  $1=="bench-01" && $4=="status" && $5=="installed" && $6=="libzfold5:amd64" && epoch($2, $3) <= jump + 0 { v = $7 }
  END { print v }' "$DPKG")"
[[ -n "$Q1_FULL" ]] || { echo "q1: no libzfold5 install before the jump" >&2; exit 3; }
Q1="${Q1_FULL%-*}"          # strip the distro revision: 5.x.y-1 -> 5.x.y

# ---------- q2: file in the release tarball that is not in git and is new in this release ----------
# A file that exists only in the tarball is diffed against an empty 1970-01-01 file on the left.
only_in_tarball() {          # $1 = upstream version; prints paths relative to the tarball root
  awk -v hdr="######## zfold $1 :" '
    index($0, "######## ") == 1 { on = (index($0, hdr) == 1); next }
    on && /^--- / && /1970-01-01 00:00:00/ { want = 1; next }
    on && want && /^\+\+\+ / { p = $2; sub(/^[^\/]*\//, "", p); print p; want = 0 }' "$DIFF" | sort -u
}
prev="$(grep -oE '^######## zfold [0-9.]+ ' "$DIFF" | awk '{print $3}' | grep -vxF "$Q1" \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)"
only_in_tarball "$prev" > "$WORK/prev.txt"
only_in_tarball "$Q1"   > "$WORK/bad.txt"
Q2="$(comm -13 "$WORK/prev.txt" "$WORK/bad.txt" | grep -E '\.m4$' || true)"
[[ "$(wc -l <<<"$Q2")" -eq 1 && -n "$Q2" ]] || { echo "q2: expected one new m4 file, got: $Q2" >&2; exit 3; }

# ---------- q3: the test file the macro goes looking for ----------
# The macro finds its input with grep -aErls "<regex>": apply that regex to the strings dump.
regex="$(awk -v f="$Q2" '
  /^diff -ruN / { on = (index($0, "/" f " ") > 0) } on' "$DIFF" \
  | sed -nE 's/.*grep -aErls "([^"]+)".*/\1/p' | head -n1)"
[[ -n "$regex" ]] || { echo "q3: no grep pattern in $Q2" >&2; exit 3; }
# Lines look like "<file>: <string>"; the regex is end-anchored, so it can run on whole lines.
Q3="$(grep -E -- "$regex" "$STRINGS" | cut -d: -f1 | sort -u | sed 's|.*/||')"
[[ "$(wc -l <<<"$Q3")" -eq 1 && -n "$Q3" ]] || { echo "q3: expected one fixture, got: $Q3" >&2; exit 3; }

# ---------- q4: the sshd import whose GOT slot points into libzfold ----------
read -r zlo zhi < <(awk '/libzfold\.so/ && $1 ~ /^0x/ {print $1, $2; exit}' "$GOT")
Q4=""
while read -r slot name target; do
  t=$((16#${target#0x})); lo=$((16#${zlo#0x})); hi=$((16#${zhi#0x}))
  (( t >= lo && t < hi )) && Q4="${Q4:+$Q4 }$name"
done < <(awk '$1 ~ /^0x[0-9a-f]+$/ && NF == 3 && $3 ~ /^0x/' "$GOT")
[[ -n "$Q4" && "$Q4" != *" "* ]] || { echo "q4: expected one hooked import, got: $Q4" >&2; exit 3; }

# ---------- q5: commit that first added the payload test file ----------
# git-log.txt is `git log -p --all`, newest first: an added file shows "new file mode" after its
# "diff --git a/<p> b/<p>" line; the last such hit is the oldest commit that added it.
Q5="$(awk -v f="tests/files/$Q3" '
  /^commit / { sha = substr($2, 1, 7) }
  /^diff --git / { p = substr($4, 3) }
  /^new file mode/ && p == f { print sha }' "$GITLOG" | tail -n1)"
[[ "$Q5" =~ ^[0-9a-f]{7}$ ]] || { echo "q5: bad sha '$Q5'" >&2; exit 3; }

# ---------- q6: hosts that ever had the bad build installed ----------
Q6="$(awk -v v="$Q1_FULL" '$4=="status" && $5=="installed" && $6=="libzfold5:amd64" && $7==v {print $1}' "$DPKG" \
  | sort -u | wc -l | tr -d ' ')"

echo "# bench-01 slowdown starts at epoch $jump; installed at that time: libzfold5 $Q1_FULL"
echo "q1=$Q1"
echo "q2=$Q2"
echo "q3=$Q3"
echo "q4=$Q4"
echo "q5=$Q5"
echo "q6=$Q6"

[[ -f "$TRUTH" ]] || { echo "no truth file at $TRUTH, skipping comparison"; exit 0; }
norm() { tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g'; }
fail=0
for q in q1 q2 q3 q4 q5 q6; do
  want="$(sed -nE "s/^ *\"$q\": *\"(.*)\",?$/\1/p" "$TRUTH")"
  got_var="Q${q#q}"; got="${!got_var}"
  if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
    echo "$q PASS ($got)"
  else
    echo "$q FAIL (got '$got', expected '$want')"; fail=1
  fi
done
exit "$fail"
