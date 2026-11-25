#!/usr/bin/env bash
# Official solver for IncidentLab case "3am-outage".
# Derives every answer from the evidence files only, with STOCK tools (bash, grep, sed, POSIX awk,
# sort, comm, wc, tr, mktemp): no jq, no git, no GNU-only date. Code history comes from
# repo/git-log.txt (the `git log -p --decorate --all --date=iso` text export), never from the bundle.
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
GITLOG="$EV/repo/git-log.txt"

for f in "$ACCESS" "$APPLOG" "$DEPLOYS" "$GITLOG"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Civil date -> unix epoch in POSIX awk (no mktime): days-from-civil, proleptic Gregorian.
AWK_EPOCH='
function epoch(y, mo, d, h, mi, s,   era, yoe, doy, doe) {
  y -= (mo <= 2); era = int(y / 400); yoe = y - era * 400
  doy = int((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return (era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + s
}
function iso(e,   s, d, z, era, doe, yoe, y, doy, mp, dd, mo) {   # epoch -> YYYY-MM-DDTHH:MM:SSZ
  d = int(e / 86400); s = e - d * 86400; z = d + 719468; era = int(z / 146097); doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153); dd = doy - int((153 * mp + 2) / 5) + 1; mo = mp + (mp < 10 ? 3 : -9)
  return sprintf("%04d-%02d-%02dT%02d:%02d:%02dZ", y + (mo <= 2), mo, dd, int(s / 3600), int(s % 3600 / 60), s % 60)
}'

# Parse the access log with awk -F'"' so the quoted user agent (which contains
# spaces) cannot shift fields:
#   $1 = 'ip - - [13/Nov/2026:01:13:14 +0000] '
#   $2 = 'POST /api/checkout HTTP/1.1'
#   $3 = ' 504 167 '            -> status, bytes
#   $NF = ' rt=... urt=... rid=... cid=cus_4417'

# ---------- q1: first 5xx (UTC, HH:MM:SS) ----------
# nginx logs the request END time; lines are not guaranteed to be sorted, so take the minimum epoch.
q1_epoch="$(awk -F'"' "$AWK_EPOCH"'
  { split($3, s, " ") }
  s[1] ~ /^5[0-9][0-9]$/ {
    match($1, /\[[^]]+\]/); t = substr($1, RSTART + 1, RLENGTH - 2)   # 13/Nov/2026:01:13:14 +0000
    split(t, a, "[/: ]")                                              # 13 Nov 2026 01 13 14 +0000
    mo = (index("JanFebMarAprMayJunJulAugSepOctNovDec", a[2]) + 2) / 3
    e = epoch(a[3], mo, a[1], a[4], a[5], a[6])
    if (min == "" || e < min) min = e
  }
  END { if (min != "") print min }' "$ACCESS")"
[[ -n "$q1_epoch" ]] || { echo "no 5xx found in access log" >&2; exit 3; }
q1_iso="$(awk "$AWK_EPOCH"' BEGIN { print iso('"$q1_epoch"') }')"
Q1="$(echo "$q1_iso" | cut -c12-19)"

# ---------- q2: short SHA of the checkout version running at q1 ----------
# Last checkout DEPLOY/ROLLBACK at or before the first 5xx (ISO-8601 Z sorts lexicographically).
deploy_line="$(grep -E '^[0-9TZ:-]+ +(DEPLOY|ROLLBACK) +service=checkout ' "$DEPLOYS" \
  | sort | awk -v t="$q1_iso" '$1 <= t' | tail -n1)"
[[ -n "$deploy_line" ]] || { echo "no checkout deploy before $q1_iso" >&2; exit 3; }
bad_version="$(sed -E 's/.*version=([^ ]+).*/\1/' <<<"$deploy_line")"
deploy_commit="$(sed -nE 's/.*commit=([0-9a-f]+).*/\1/p' <<<"$deploy_line")"
deploy_time="$(awk '{print $1}' <<<"$deploy_line")"

# The tag decorates its commit line: "commit <sha> (HEAD -> main, tag: v2.14.1)".
tag_line="$(grep -E "^commit [0-9a-f]+ \(.*tag: ${bad_version//./\\.}[,)]" "$GITLOG" | head -n1 || true)"
[[ -n "$tag_line" ]] || { echo "tag $bad_version not found in git-log.txt" >&2; exit 3; }
Q2="$(awk '{print substr($2, 1, 7)}' <<<"$tag_line")"
if [[ -n "$deploy_commit" && "$deploy_commit" != "$Q2"* && "$Q2" != "$deploy_commit"* ]]; then
  echo "WARN: deploys.log commit=$deploy_commit != tag $bad_version -> $Q2" >&2
fi

# ---------- q3: the poison order (started, never finished, right at onset) ----------
# The app log is JSON lines in LOCAL time (+02:00). Pull ts/msg/order from the flat text, convert
# to epoch in awk, then look for checkout.start orders with no checkout.done whose start is in the
# 2 minutes before the first 5xx (nginx times out after 30 s).
Q3="$(grep -E '"msg":"checkout\.(start|done)"' "$APPLOG" \
  | sed -nE 's/.*"ts":"([^"]*)".*"msg":"([^"]*)".*"order":"([^"]*)".*/\1 \2 \3/p' \
  | awk -v q1="$q1_epoch" "$AWK_EPOCH"'
    {
      # 2026-11-13T03:12:44.118+02:00  (or ...Z)
      ts = $1; off = 0
      if (ts ~ /Z$/) sub(/Z$/, "", ts)
      else if (match(ts, /[+-][0-9][0-9]:?[0-9][0-9]$/)) {
        z = substr(ts, RSTART); ts = substr(ts, 1, RSTART - 1); gsub(/:/, "", z)
        off = (substr(z, 2, 2) * 3600 + substr(z, 4, 2) * 60) * (substr(z, 1, 1) == "-" ? -1 : 1)
      }
      split(ts, p, "[-T:]")
      e = epoch(p[1], p[2], p[3], p[4], p[5], int(p[6])) - off
      if ($2 == "checkout.done") done[$3] = 1
      else if (e <= q1 && e >= q1 - 120 && (!($3 in first) || e < first[$3])) first[$3] = e
    }
    END {
      for (o in first) if (!(o in done) && (best == "" || first[o] < first[best])) best = o
      if (best != "") print best
    }')"
[[ -n "$Q3" ]] || { echo "could not find an unfinished order near onset" >&2; exit 3; }

# ---------- q4: function containing the dangerous regex ----------
# Walk git-log.txt (newest first) from the bad tag down to the previous tag. For each source file the
# release touched, rebuild the newest post-image of its hunks (context + added lines), then look for a
# nested quantifier and the function that contains (or uses) it.
POST="$WORK/post"; mkdir -p "$POST"
awk -v tag="tag: $bad_version" -v out="$POST" '
  /^commit / {
    if (on && index($0, "tag: ")) { on = 0; exit }          # reached the previous release
    if (index($0, tag "," ) || index($0, tag ")")) on = 1
    next
  }
  !on { next }
  /^diff --git / { f = $4; sub(/^b\//, "", f); keep = !(f in seen); seen[f] = 1
                   gsub(/\//, "__", f); hunk = 0; next }
  /^@@ / { hunk = 1; next }
  !hunk || !keep { next }
  /^[+ ]/ { print substr($0, 2) > (out "/" f) }
' "$GITLOG"

# Nested quantifier: a group that itself contains + or * , followed by + or *  e.g. (\w+\s?)*
NESTED='\([^()]*[+*][^()]*\)[*+]'
Q4=""
for path in "$POST"/*; do
  [[ -f "$path" ]] || continue
  name="${path##*/}"
  [[ "$name" == *.ts || "$name" == *.js ]] || continue
  grep -qiE '(test|spec)' <<<"$name" && continue
  grep -qE "$NESTED" "$path" || continue
  regex_line="$(grep -nE -m1 "$NESTED" "$path")"
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
    }' "$path")"
  [[ -n "$Q4" ]] && break
done
[[ -n "$Q4" ]] || { echo "could not locate the dangerous function" >&2; exit 3; }

# ---------- q5: how many times was the poison order submitted ----------
Q5="$(grep '"msg":"checkout.start"' "$APPLOG" | grep -c "\"order\":\"$Q3\"" || true)"

# ---------- q6: unique real customers with >=1 5xx on POST /api/checkout ----------
Q6="$(awk -F'"' '
  { split($3, s, " ") }
  $2 ~ /^POST \/api\/checkout[ ?]/ && s[1] ~ /^5[0-9][0-9]$/ {
    if (match($NF, /cid=[^ ]+/)) print substr($NF, RSTART + 4, RLENGTH - 4)
  }' "$ACCESS" | grep -vxE -- '-|cus_synthetic' | sort -u | wc -l | tr -d ' ')"

echo "# version running at first 5xx: $bad_version (deployed $deploy_time, deploys.log commit=$deploy_commit)"
echo "q1=$Q1"
echo "q2=$Q2"
echo "q3=$Q3"
echo "q4=$Q4"
echo "q5=$Q5"
echo "q6=$Q6"

# ---------- optional self-check against the truth file ----------
# answers.json is {"answers": {"q1": "...", ...}, ...}; read it with awk (no jq).
if [[ -f "$TRUTH" ]]; then
  norm() { tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g'; }
  fail=0
  for q in q1 q2 q3 q4 q5 q6; do
    want="$(awk -v key="\"$q\"" '
      /"answers"[ \t]*:/ { inside = 1 }
      inside && index($0, key ":") {
        v = substr($0, index($0, key ":") + length(key) + 1)
        sub(/^[ \t]*"?/, "", v); sub(/"?[ \t]*,?[ \t]*$/, "", v); print v; exit
      }
      inside && /}/ { inside = 0 }' "$TRUTH")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
