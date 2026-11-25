#!/usr/bin/env bash
# Official solver for IncidentLab case "who-deleted-prod".
# Derives every answer from the evidence files only, with stock tools only: grep, sed, POSIX awk,
# sort, uniq, cut, paste, wc, tr (no jq, no GNU date -d), like the players' Toolbox.
# Usage: solutions/who-deleted-prod/solve.sh [evidence_dir]   (default: build/evidence/who-deleted-prod)
# Compares with build/truth/who-deleted-prod.answers.json when present; exits 1 on any FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EV="${1:-$ROOT/build/evidence/who-deleted-prod}"
EV="$(cd "$EV" && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/who-deleted-prod.answers.json}"

WAF="$EV/waf/access.log"
EC2="$EV/ec2/describe-instances.json"
S3DIR="$EV/s3-access-logs"
shopt -s nullglob
CT=("$EV"/cloudtrail/*.jsonl)
ROLEFILES=("$EV"/iam/roles/*.json)
for f in "$WAF" "$EC2" "$S3DIR" "${CT[@]}" "${ROLEFILES[@]}"; do
  [[ -e "$f" ]] || { echo "missing evidence: $f" >&2; exit 2; }
done
(( ${#CT[@]} > 0 )) || { echo "no CloudTrail files" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- q1: who got a 200 from the metadata service through the WAF? ----------
# $upstream_addr shows where nginx actually connected. The request itself may spell the
# address in any form (decimal, encoded...), so match on the upstream, not on the URL.
grep -E '" 200 [0-9]+ ' "$WAF" | grep -F 'upstream=169.254.169.254:' > "$WORK/imds_ok" || true
ips="$(awk '{print $1}' "$WORK/imds_ok" | sort -u)"
[[ "$(wc -l <<<"$ips")" -eq 1 && -n "$ips" ]] || { echo "expected one IP with IMDS 200s, got: $ips" >&2; exit 3; }
Q1="$ips"

# ---------- q2: first successful fetch of the role credentials, in UTC ----------
# security-credentials/<role> (non-empty role) returns the keys; the bare listing only returns the role name.
awk '$7 ~ /security-credentials\/[^\/ ]+$/' "$WORK/imds_ok" > "$WORK/creds"
[[ -s "$WORK/creds" ]] || { echo "no credential fetch found" >&2; exit 3; }
ROLE="$(head -n1 "$WORK/creds" | awk '{print $7}' | sed -E 's#.*security-credentials/##')"
# [17/Nov/2026:22:27:19 -0500]: build a sortable UTC key in POSIX awk (no GNU date -d), keep the smallest,
# and print its UTC time of day. The day number only has to be monotonic, not a real calendar.
Q2="$(awk '
  BEGIN { split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " "); for (i = 1; i <= 12; i++) mon[m[i]] = i }
  {
    ts = substr($4, 2); off = substr($5, 1, 5)
    split(ts, a, "[/:]")   # a[1]=dd a[2]=Mon a[3]=yyyy a[4]=HH a[5]=MM a[6]=SS
    offs = (substr(off, 2, 2) * 3600 + substr(off, 4, 2) * 60) * (substr(off, 1, 1) == "-" ? -1 : 1)
    key = ((a[3] * 12 + mon[a[2]]) * 31 + a[1]) * 86400 + a[4] * 3600 + a[5] * 60 + a[6] - offs
    if (best == "" || key < best) best = key
  }
  END { t = best % 86400; if (t < 0) t += 86400; printf "%02d:%02d:%02d\n", int(t / 3600), int(t % 3600 / 60), t % 60 }
' "$WORK/creds")"

# ---------- the instance that owns that role: its own addresses ----------
ROLEFILE=""
for f in "${ROLEFILES[@]}"; do
  grep -q -F "\"RoleName\": \"$ROLE\"" "$f" && ROLEFILE="$f"
done
[[ -n "$ROLEFILE" ]] || { echo "no IAM file for role $ROLE" >&2; exit 3; }
PROFILES="$(grep -o '"Arn": "arn:aws:iam::[0-9]*:instance-profile/[^"]*"' "$ROLEFILE" | cut -d'"' -f4)"
[[ -n "$PROFILES" ]] || { echo "no instance profile for role $ROLE" >&2; exit 3; }
# describe-instances is pretty-printed: one key per line. Collect each instance's own IPs and its profile.
OWN_IPS="$(awk -F'"' -v profiles="$PROFILES" '
  BEGIN { n = split(profiles, p, "\n"); for (i = 1; i <= n; i++) want[p[i]] = 1 }
  $2 == "InstanceId" { id = $4 }
  $2 == "PrivateIpAddress" || $2 == "PublicIpAddress" { ips[id] = ips[id] " " $4 }
  $2 == "Arn" && ($4 in want) { hit[id] = 1 }
  END { for (id in hit) { n = split(ips[id], v, " "); for (i = 1; i <= n; i++) print v[i] } }
' "$EC2" | sort -u | paste -sd, -)"
[[ -n "$OWN_IPS" ]] || { echo "no instance wears role $ROLE" >&2; exit 3; }

# CloudTrail lines are flat text: with -F'"' a string value sits two fields after its key. f[key] keeps the
# FIRST occurrence (userIdentity.type, not sessionIssuer.type). ct_fields prints the keys asked for, tab-separated.
ct_fields() {
  awk -F'"' -v keys="$1" '
    BEGIN { n = split(keys, k, ",") }
    {
      for (i = 1; i < NF; i++) if (!($i in f)) f[$i] = $(i + 2)
      f["readOnly"] = index($0, "\"readOnly\":false") ? "false" : "true"
      out = f[k[1]]; for (j = 2; j <= n; j++) out = out "\t" f[k[j]]
      print out; split("", f)
    }'
}

# All CloudTrail events signed by the role but NOT coming from the instance itself.
cat "${CT[@]}" | awk -F'"' -v r="$ROLE" -v own="$OWN_IPS" '
  BEGIN { n = split(own, o, ","); for (i = 1; i <= n; i++) mine[o[i]] = 1 }
  {
    for (i = 1; i < NF; i++) if (!($i in f)) f[$i] = $(i + 2)
    if (f["type"] == "AssumedRole" && f["userName"] == r && !(f["sourceIPAddress"] in mine)) print
    split("", f)
  }' > "$WORK/foreign.jsonl"
[[ -s "$WORK/foreign.jsonl" ]] || { echo "no foreign use of $ROLE" >&2; exit 3; }

# ---------- q3: the access key id used from outside ----------
keys="$(ct_fields accessKeyId < "$WORK/foreign.jsonl" | sort -u)"
[[ "$(wc -l <<<"$keys")" -eq 1 ]] || { echo "expected one foreign key, got: $keys" >&2; exit 3; }
Q3="$keys"
API_IPS="$(ct_fields sourceIPAddress < "$WORK/foreign.jsonl" | sort -u | paste -sd, -)"

# ---------- q4: distinct objects successfully downloaded with the stolen credentials ----------
Q4="$(ct_fields eventName,errorCode,bucketName,key < "$WORK/foreign.jsonl" \
  | awk -F'\t' '$1 == "GetObject" && $2 == "" {print $3 "/" $4}' | sort -u | wc -l | tr -d ' ')"

# ---------- q5: the call that actually deleted prod ----------
# The bucket that lost objects: S3.EXPIRE.OBJECT in its server access log (lifecycle, not a person).
DEL_BUCKET="$(cat "$S3DIR"/*/*.log | awk '$8=="S3.EXPIRE.OBJECT" {print $2}' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
[[ -n "$DEL_BUCKET" ]] || { echo "no expirations found" >&2; exit 3; }
Q5="$(ct_fields bucketName,readOnly,errorCode,eventName < "$WORK/foreign.jsonl" \
  | awk -F'\t' -v b="$DEL_BUCKET" '$1 == b && $2 == "false" && $3 == "" {print $4}' | sort -u)"
[[ "$(wc -l <<<"$Q5")" -eq 1 && -n "$Q5" ]] || { echo "expected one successful write, got: $Q5" >&2; exit 3; }

# ---------- q6: which policy statement allowed it ----------
# CloudTrail eventName -> IAM action (S3 names differ for the bucket-configuration APIs).
case "$Q5" in
  PutBucketLifecycle) ACTION="s3:PutLifecycleConfiguration" ;;
  DeleteBucketLifecycle) ACTION="s3:PutLifecycleConfiguration" ;;
  PutBucketPolicy) ACTION="s3:PutBucketPolicy" ;;
  *) ACTION="s3:$Q5" ;;
esac
RES="arn:aws:s3:::$DEL_BUCKET"
# Walk the pretty-printed inline policy statement by statement; IAM globs: * = any run, actions case-insensitive.
MATCHES="$(awk -F'"' -v act="$ACTION" -v res="$RES" '
  function glob(p,   r, i, c) {
    r = "^"
    for (i = 1; i <= length(p); i++) {
      c = substr(p, i, 1)
      if (c == "*") r = r ".*"; else if (index("\\^$.[]|()+?{}/", c)) r = r "\\" c; else r = r c
    }
    return r "$"
  }
  function check(key, v) {
    if (key == "Action" && tolower(act) ~ tolower(glob(v))) am = 1
    if (key == "Resource" && res ~ glob(v)) rm = 1
  }
  function flush() { if (sid != "" && am && rm) print eff, sid; sid = ""; eff = ""; am = 0; rm = 0; k = "" }
  /"RolePolicies"/ { on = 1 }
  !on { next }
  $2 == "Sid" { flush(); sid = $4; next }
  $2 == "Effect" { eff = $4; next }
  $2 == "Action" || $2 == "Resource" { k = $2; if (NF >= 5) check(k, $4); next }
  NF == 3 && $3 ~ /^,?$/ && k != "" { check(k, $2) }
  /\]/ { k = "" }
  END { flush() }
' "$ROLEFILE")"
if grep -q '^Deny ' <<<"$MATCHES"; then echo "an explicit Deny covers $ACTION: $MATCHES" >&2; exit 3; fi
Q6="$(awk '$1 == "Allow" {print $2}' <<<"$MATCHES")"
[[ "$(wc -l <<<"$Q6")" -eq 1 && -n "$Q6" ]] || { echo "expected one matching statement, got: $Q6" >&2; exit 3; }

echo "# role=$ROLE instance_ips=$OWN_IPS api_ips=$API_IPS deleted_bucket=$DEL_BUCKET iam_action=$ACTION"
echo "q1=$Q1"
echo "q2=$Q2"
echo "q3=$Q3"
echo "q4=$Q4"
echo "q5=$Q5"
echo "q6=$Q6"

if [[ -f "$TRUTH" ]]; then
  norm() { tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g'; }
  fail=0
  for q in q1 q2 q3 q4 q5 q6; do
    want="$(sed -n -E "s/^ *\"$q\": \"(.*)\",?\$/\\1/p" "$TRUTH")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
