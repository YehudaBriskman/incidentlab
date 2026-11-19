#!/usr/bin/env bash
# Official solver for IncidentLab case "3am-outage".
# Derives every answer from the evidence files only (grep/awk/sort/jq/git/date).
# Usage: solutions/solve.sh [evidence_dir]   (default: build/evidence/3am-outage)
# If build/truth/answers.json exists, compares and exits 1 on any FAIL.
set -euo pipefail

EV="${1:-build/evidence/3am-outage}"
EV="$(cd "$EV" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/answers.json}"

ACCESS="$EV/nginx/access.log"
APPLOG="$EV/app/checkout-service.log"
DEPLOYS="$EV/deploys/deploys.log"
BUNDLE="$EV/repo/shipfast-checkout.bundle"

for f in "$ACCESS" "$APPLOG" "$DEPLOYS" "$BUNDLE"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Parse the access log with awk -F'"' so the quoted user agent (which contains
# spaces) cannot shift fields:
#   $1 = 'ip - - [13/Nov/2026:01:13:14 +0000] '
#   $2 = 'POST /api/checkout HTTP/1.1'
#   $3 = ' 504 167 '            -> status, bytes
#   $NF = ' rt=… urt=… rid=… cid=cus_4417'

# ---------- q1: first 5xx (UTC, HH:MM:SS) ----------
# nginx logs the request END time; lines are not guaranteed to be sorted, so take the minimum.
first5xx_ts="$(awk -F'"' '
  { split($3, s, " ") }
  s[1] ~ /^5[0-9][0-9]$/ {
    match($1, /\[[^]]+\]/); t = substr($1, RSTART+1, RLENGTH-2)   # 13/Nov/2026:01:13:14 +0000
    split(t, a, ":"); sub(/ .*/, "", a[4])
    print a[1] " " a[2] ":" a[3] ":" a[4]                          # 13/Nov/2026 01:13:14
  }' "$ACCESS" | sort -k1,1 -k2,2 | awk 'NR==1')"
[[ -n "$first5xx_ts" ]] || { echo "no 5xx found in access log" >&2; exit 3; }
Q1="${first5xx_ts#* }"
q1_date="${first5xx_ts% *}"                                        # 13/Nov/2026
q1_epoch="$(date -u -d "$(echo "$q1_date" | tr '/' ' ') $Q1 UTC" +%s)"
q1_iso="$(date -u -d "@$q1_epoch" +%Y-%m-%dT%H:%M:%SZ)"

# ---------- q2: short SHA of the checkout version running at q1 ----------
# Last checkout DEPLOY/ROLLBACK at or before the first 5xx (ISO-8601 Z sorts lexicographically).
deploy_line="$(grep -E '^[0-9TZ:-]+ +(DEPLOY|ROLLBACK) +service=checkout ' "$DEPLOYS" \
  | sort | awk -v t="$q1_iso" '$1 <= t' | tail -n1)"
[[ -n "$deploy_line" ]] || { echo "no checkout deploy before $q1_iso" >&2; exit 3; }
bad_version="$(sed -E 's/.*version=([^ ]+).*/\1/' <<<"$deploy_line")"
deploy_commit="$(sed -nE 's/.*commit=([0-9a-f]+).*/\1/p' <<<"$deploy_line")"
deploy_time="$(awk '{print $1}' <<<"$deploy_line")"

git clone -q "$BUNDLE" "$WORK/repo" 2>/dev/null
REPO="$WORK/repo"
Q2="$(git -C "$REPO" rev-parse --short=7 "${bad_version}^{commit}")"
if [[ -n "$deploy_commit" && "$deploy_commit" != "$Q2"* && "$Q2" != "$deploy_commit"* ]]; then
  echo "WARN: deploys.log commit=$deploy_commit != git tag $bad_version -> $Q2" >&2
fi

# ---------- q3: the poison order (started, never finished, right at onset) ----------
# The app log is in LOCAL time (+02:00). Convert to epoch in jq, then look for
# checkout.start orders with no checkout.done whose start is ~30s (nginx timeout)
# before the first 5xx.
jq -c -R --argjson q1 "$q1_epoch" '
  fromjson? | select(.msg == "checkout.start" or .msg == "checkout.done")
  | (.ts | capture("^(?<b>[0-9-]{10}T[0-9:]{8})(?:\\.[0-9]+)?(?<z>Z|(?<sg>[+-])(?<h>[0-9]{2}):?(?<m>[0-9]{2}))$")) as $c
  | ((($c.b + "Z") | fromdateiso8601)
     - (if $c.z == "Z" then 0
        else ((if $c.sg == "-" then -1 else 1 end) * (($c.h|tonumber)*3600 + ($c.m|tonumber)*60)) end)) as $e
  | {msg, order, customer, epoch: $e}' "$APPLOG" > "$WORK/checkouts.jsonl"

Q3="$(jq -rs --argjson q1 "$q1_epoch" '
  (map(select(.msg=="checkout.done") | .order) | unique) as $done
  | map(select(.msg=="checkout.start" and ((.order) as $o | $done | index($o) | not)))
  | map(select(.epoch <= $q1 and .epoch >= $q1 - 120))     # started in the 2 min before the first 5xx
  | sort_by(.epoch) | .[0].order // empty' "$WORK/checkouts.jsonl")"
[[ -n "$Q3" ]] || { echo "could not find an unfinished order near onset" >&2; exit 3; }

# ---------- q4: function containing the dangerous regex ----------
prev_tag="$(git -C "$REPO" describe --tags --abbrev=0 "${bad_version}^" 2>/dev/null || true)"
range="${prev_tag:+$prev_tag..}$bad_version"
[[ -n "$prev_tag" ]] || range="${bad_version}^..${bad_version}"
git -C "$REPO" checkout -q "$bad_version" 2>/dev/null
# Nested quantifier: a group that itself contains + or * , followed by + or *  e.g. (\w+\s?)*
NESTED='\([^()]*[+*][^()]*\)[*+]'
Q4=""
while IFS= read -r f; do
  [[ -f "$REPO/$f" ]] || continue
  grep -qE "$NESTED" "$REPO/$f" || continue
  regex_line="$(grep -nE -m1 "$NESTED" "$REPO/$f")"
  regex_lno="${regex_line%%:*}"
  # Name of the const holding the regex, if any (const FOO_RE = /.../)
  const_name="$(sed -nE 's/.*(const|let|var) +([A-Za-z_$][A-Za-z0-9_$]*) *=.*/\2/p' <<<"${regex_line#*:}")"
  Q4="$(awk -v target="$regex_lno" -v cname="$const_name" '
    function fname(line,   m) {
      if (match(line, /function[ \t]+[A-Za-z_$][A-Za-z0-9_$]*/)) { m = substr(line, RSTART, RLENGTH); sub(/function[ \t]+/, "", m); return m }
      if (match(line, /(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*(async[ \t]*)?(\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*(:[^=]*)?=>/)) {
        m = substr(line, RSTART, RLENGTH); sub(/^(const|let|var)[ \t]+/, "", m); sub(/[ \t]*=.*/, "", m); return m }
      return ""
    }
    { n = fname($0); if (n != "") cur = n
      if (cur != "" && depth > 0) {
        if (NR == target) { print cur; exit }
        if (cname != "" && index($0, cname) && NR != target) { print cur; exit }
      }
      o = gsub(/\{/, "{"); c = gsub(/\}/, "}"); depth += o - c
      if (depth <= 0) { depth = 0; cur = "" }
    }' "$REPO/$f")"
  [[ -n "$Q4" ]] && break
done < <(git -C "$REPO" diff --name-only "$range" -- '*.ts' '*.js' | grep -viE '(test|spec)')
[[ -n "$Q4" ]] || { echo "could not locate the dangerous function" >&2; exit 3; }

# ---------- q5: how many times was the poison order submitted ----------
Q5="$(jq -r --arg o "$Q3" 'select(.msg=="checkout.start" and .order==$o) | .order' "$APPLOG" 2>/dev/null | wc -l | tr -d ' ')"

# ---------- q6: unique real customers with >=1 5xx on POST /api/checkout ----------
Q6="$(awk -F'"' '
  { split($3, s, " ") }
  $2 ~ /^POST \/api\/checkout[ ?]/ && s[1] ~ /^5[0-9][0-9]$/ {
    if (match($NF, /cid=[^ ]+/)) print substr($NF, RSTART+4, RLENGTH-4)
  }' "$ACCESS" | grep -vxE -- '-|cus_synthetic' | sort -u | wc -l | tr -d ' ')"

echo "# version running at first 5xx: $bad_version (deployed $deploy_time, deploys.log commit=$deploy_commit)"
echo "q1=$Q1"
echo "q2=$Q2"
echo "q3=$Q3"
echo "q4=$Q4"
echo "q5=$Q5"
echo "q6=$Q6"

# ---------- optional self-check against the truth file ----------
if [[ -f "$TRUTH" ]]; then
  norm() { tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g'; }
  fail=0
  for q in q1 q2 q3 q4 q5 q6; do
    want="$(jq -r --arg q "$q" '
      ( .[$q] // .answers[$q] // .flags[$q] // empty )
      | if type=="object" then (.answer // .value // empty) else . end | tostring' "$TRUTH")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
