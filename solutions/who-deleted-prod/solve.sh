#!/usr/bin/env bash
# Official solver for IncidentLab case "who-deleted-prod".
# Derives every answer from the evidence files only (grep/awk/sed/sort/uniq/jq/date).
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
first_epoch=""
while read -r ts off; do
  # [17/Nov/2026:22:27:19 -0500]  ->  "17 Nov 2026 22:27:19 -0500"
  ts="${ts#[}"; off="${off%]}"
  d="${ts%%:*}"; tm="${ts#*:}"
  e="$(date -u -d "$(tr '/' ' ' <<<"$d") $tm $off" +%s)"
  if [[ -z "$first_epoch" || "$e" -lt "$first_epoch" ]]; then first_epoch="$e"; fi
done < <(awk '{print $4, $5}' "$WORK/creds")
Q2="$(date -u -d "@$first_epoch" +%H:%M:%S)"

# ---------- the instance that owns that role: its own addresses ----------
PROFILES="$(jq -r --arg r "$ROLE" 'select(.Role.RoleName==$r) | .InstanceProfiles[].Arn' "${ROLEFILES[@]}")"
[[ -n "$PROFILES" ]] || { echo "no instance profile for role $ROLE" >&2; exit 3; }
OWN_IPS="$(jq -r --arg p "$PROFILES" '.Reservations[].Instances[]
  | select(.IamInstanceProfile.Arn as $a | ($p | split("\n") | index($a)))
  | .PrivateIpAddress, (.PublicIpAddress // empty)' "$EC2" | sort -u | paste -sd, -)"

# All CloudTrail events signed by the role but NOT coming from the instance itself.
cat "${CT[@]}" | jq -c --arg r "$ROLE" --arg own "$OWN_IPS" '
  select(.userIdentity.sessionContext.sessionIssuer.userName == $r)
  | select((.sourceIPAddress as $ip | ($own | split(",") | index($ip))) | not)' > "$WORK/foreign.jsonl"
[[ -s "$WORK/foreign.jsonl" ]] || { echo "no foreign use of $ROLE" >&2; exit 3; }

# ---------- q3: the access key id used from outside ----------
keys="$(jq -r '.userIdentity.accessKeyId' "$WORK/foreign.jsonl" | sort -u)"
[[ "$(wc -l <<<"$keys")" -eq 1 ]] || { echo "expected one foreign key, got: $keys" >&2; exit 3; }
Q3="$keys"
API_IPS="$(jq -r '.sourceIPAddress' "$WORK/foreign.jsonl" | sort -u | paste -sd, -)"

# ---------- q4: distinct objects successfully downloaded with the stolen credentials ----------
Q4="$(jq -r 'select(.eventName=="GetObject" and (has("errorCode")|not))
  | "\(.requestParameters.bucketName)/\(.requestParameters.key)"' "$WORK/foreign.jsonl" | sort -u | wc -l | tr -d ' ')"

# ---------- q5: the call that actually deleted prod ----------
# The bucket that lost objects: S3.EXPIRE.OBJECT in its server access log (lifecycle, not a person).
DEL_BUCKET="$(cat "$S3DIR"/*/*.log | awk '$8=="S3.EXPIRE.OBJECT" {print $2}' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
[[ -n "$DEL_BUCKET" ]] || { echo "no expirations found" >&2; exit 3; }
Q5="$(jq -r --arg b "$DEL_BUCKET" 'select(.requestParameters.bucketName==$b and .readOnly==false and (has("errorCode")|not))
  | .eventName' "$WORK/foreign.jsonl" | sort -u)"
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
Q6="$(jq -r --arg r "$ROLE" --arg a "$ACTION" --arg res "$RES" '
  def glob($p): ("^" + ($p | gsub("[.+?^$(){}|\\[\\]\\\\]"; "\\\(.)") | gsub("\\*"; ".*")) + "$");
  def arr: if type=="array" then . else [.] end;
  select(.Role.RoleName==$r) | .RolePolicies[].PolicyDocument.Statement[]
  | select(.Effect=="Allow")
  | select(any(.Action|arr[]; . as $p | $a | test(glob($p); "i")))
  | select(any(.Resource|arr[]; . as $p | $res | test(glob($p))))
  | .Sid' "${ROLEFILES[@]}")"
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
    want="$(jq -r --arg q "$q" '.answers[$q] // empty' "$TRUTH")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
