#!/usr/bin/env bash
# Official solver for IncidentLab case "first-shift" (the tutorial case).
# Derives every answer from the evidence files only, with stock tools (grep, sed, POSIX awk, sort, uniq, cut).
# Usage: solutions/first-shift/solve.sh [evidence_dir]   (default: build/evidence/first-shift)
# Compares with build/truth/first-shift.answers.json when present; exits 1 on any FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EV="${1:-$ROOT/build/evidence/first-shift}"
EV="$(cd "$EV" && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/first-shift.answers.json}"

ACCESS="$EV/access.log"
DEPLOY="$EV/deploy.log"
for f in "$ACCESS" "$DEPLOY"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done

# nginx combined format: $1 client IP, $4 [time, $7 path (with any query string), $9 status.
# ---------- q1: the path with the most 404s (query strings stripped) ----------
Q1="$(awk '$9 == 404 { sub(/\?.*/, "", $7); print $7 }' "$ACCESS" | sort | uniq -c | sort -rn | awk 'NR == 1 { print $2 }')"
[[ -n "$Q1" ]] || { echo "no 404 found" >&2; exit 3; }

# Every 404 line for that path, in file order (the log is in time order, UTC).
hits() { awk -v p="$Q1" '$9 == 404 { path = $7; sub(/\?.*/, "", path); if (path == p) print }' "$ACCESS"; }

# ---------- q2: the first 404 for that path ----------
Q2="$(hits | awk 'NR == 1 { print $4 }' | cut -d: -f2-4)"
[[ -n "$Q2" ]] || { echo "no first 404" >&2; exit 3; }

# ---------- q3: the last deploy that finished before that first 404 ----------
# deploy.log is ISO-8601 UTC on the same day, so HH:MM:SS compares as text.
Q3="$(grep 'deploy finished' "$DEPLOY" \
  | awk -v t="$Q2" '{ split($1, a, "T"); hm = substr(a[2], 1, 8); if (hm <= t) last = $0 } END { print last }' \
  | grep -o 'commit=[0-9a-f]*' | cut -d= -f2)"
[[ -n "$Q3" ]] || { echo "no deploy before the first 404" >&2; exit 3; }

# ---------- q4: how many 404 responses that path got ----------
Q4="$(hits | awk 'END { print NR }')"

# ---------- q5: the client that got the most of those 404s ----------
Q5="$(hits | awk '{ print $1 }' | sort | uniq -c | sort -rn | awk 'NR == 1 { print $2 }')"

# ---------- q6: what that deploy renamed the page to ----------
dep_id="$(grep "deploy started" "$DEPLOY" | grep "commit=$Q3" | grep -o 'id=dep-[0-9]*' | sed -n 1p)"
Q6="$(grep "$dep_id " "$DEPLOY" | grep " R ${Q1#/} -> " | sed -E 's/.* -> //')"
[[ -n "$Q6" ]] || { echo "no rename of $Q1 in $dep_id" >&2; exit 3; }
grep -q "\"GET /$Q6 HTTP/1.1\" 200 " "$ACCESS" || { echo "the new page /$Q6 is never served" >&2; exit 3; }

echo "q1=$Q1"
echo "q2=$Q2"
echo "q3=$Q3"
echo "q4=$Q4"
echo "q5=$Q5"
echo "q6=$Q6"

if [[ -f "$TRUTH" ]]; then
  norm() { tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g'; }
  # The truth file is flat {"answers": {"q1": "...", ...}}: read each value with grep/sed, no jq.
  truth_of() { tr -d '\n' <"$TRUTH" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}[^\",}]*" | sed -n 1p | sed -E 's/^[^:]*:[[:space:]]*"?//'; }
  fail=0
  for q in q1 q2 q3 q4 q5 q6; do
    want="$(truth_of "$q")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
