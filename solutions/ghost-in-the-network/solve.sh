#!/usr/bin/env bash
# Official solver for IncidentLab case "ghost-in-the-network".
# Derives every answer from the evidence files only (grep/awk/sed/sort/uniq/jq/date).
# Usage: solutions/ghost-in-the-network/solve.sh [evidence_dir]   (default: build/evidence/ghost-in-the-network)
# Compares with build/truth/ghost-in-the-network.answers.json when present; exits 1 on any FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EV="${1:-$ROOT/build/evidence/ghost-in-the-network}"
EV="$(cd "$EV" && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/ghost-in-the-network.answers.json}"

APP="$EV/app/manifest-sync.log"
KERN="$EV/firewall/kern-app-hosts.log"
IPT_AFTER="$EV/firewall/app-03_iptables-save_after.txt"
CHANGES="$EV/changes/change-log.csv"
LARGE="$EV/pcap/app-03_large-request.txt"
V1="$EV/dns/unbound/node-dns-v1.conf"
V2="$EV/dns/unbound/node-dns-v2.conf"
for f in "$APP" "$KERN" "$IPT_AFTER" "$CHANGES" "$LARGE" "$V1" "$V2"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done

# ---------- q1: first request that connected, then hung (logged time, converted to UTC) ----------
# The app logs local time (+02:00) when a request ENDS. phase=connect failures are a different
# problem (they never reached the ledger), so only phase=response counts.
first_hang_local="$(jq -r 'select(.phase == "response") | .ts' "$APP" | sort | sed -n 1p)"
[[ -n "$first_hang_local" ]] || { echo "no phase=response failure found" >&2; exit 3; }
Q1="$(date -u -d "$first_hang_local" +%H:%M:%S)"
first_hang_epoch="$(date -u -d "$first_hang_local" +%s)"

# ---------- q2: the change that started dropping ICMP "fragmentation needed" ----------
# 1) first need-to-frag drop in the host firewall log (syslog, UTC, no year: it's 2026)
first_drop="$(grep 'IN-DROP-ICMP:' "$KERN" | grep 'TYPE=3 CODE=4' | awk '{print $1" "$2" "$3}' | sort -k3 | sed -n 1p)"
first_drop_epoch="$(date -u -d "$first_drop 2026 UTC" +%s)"
# 2) the tag on the iptables rule that drops ICMP
tag="$(grep -E -- '-p icmp .*-j DROP' "$IPT_AFTER" | sed -nE 's/.*--comment "([^:"]+):.*/\1/p' | sed -n 1p)"
[[ -n "$tag" ]] || { echo "no tagged ICMP DROP rule" >&2; exit 3; }
# 3) the change that shipped that tag, before the first drop
Q2=""
while IFS=, read -r cid start _rest; do
  s_epoch="$(date -u -d "$start" +%s)"
  if (( s_epoch <= first_drop_epoch )); then Q2="$cid"; fi
done < <(grep -F "$tag" "$CHANGES" | grep -E '^CHG-' | sort -t, -k2,2)
[[ -n "$Q2" ]] || { echo "no change carrying tag $tag" >&2; exit 3; }
(( first_drop_epoch <= first_hang_epoch )) || echo "WARN: first drop after first hang" >&2

# ---------- q3: MSS that fits the tunnel = path MTU - 20 (IPv4) - 20 (TCP) ----------
mtu_fw="$(grep -o 'MTU=[0-9]*' "$KERN" | sort | uniq -c | sort -rn | awk 'NR==1{sub("MTU=","",$2); print $2}')"
mtu_pcap="$(grep -o 'need to frag (mtu [0-9]*)' "$LARGE" | grep -o '[0-9]*' | sort -u | sed -n 1p)"
[[ "$mtu_fw" == "$mtu_pcap" ]] || echo "WARN: firewall MTU $mtu_fw != capture MTU $mtu_pcap" >&2
Q3=$(( mtu_fw - 40 ))

# ---------- q4: the address hosts connect to that no longer answers ----------
peers="$(jq -r 'select(.phase == "connect") | .peer' "$APP" | sort -u)"
[[ "$(wc -l <<<"$peers")" -eq 1 ]] || { echo "expected one connect-phase peer, got: $peers" >&2; exit 3; }
Q4="$peers"

# ---------- q5: how many app hosts were still talking to it ----------
Q5="$(jq -r --arg ip "$Q4" 'select(.peer == $ip) | .host' "$APP" | sort -u | wc -l | tr -d ' ')"

# ---------- q6: the resolver option that kept the record alive ----------
# Stale answers in dig carry a TTL far above the zone's TTL, so something raised the TTL.
# Among TTL options that v2 added or changed, keep the one whose value covers the observed TTL.
max_ttl="$(grep -h -E "^[a-z0-9.-]+\.[[:space:]]+[0-9]+[[:space:]]+IN[[:space:]]+A[[:space:]]+$Q4\$" "$EV"/dns/dig/*.txt \
  | awk '{print $2}' | sort -n | tail -n1)"
[[ -n "$max_ttl" ]] || { echo "no stale dig answer found" >&2; exit 3; }
norm_conf() { sed -E 's/#.*//; s/^[[:space:]]+//; s/[[:space:]]+$//' "$1" | grep -E '^[a-z-]+:' | sort; }
Q6="$(comm -13 <(norm_conf "$V1") <(norm_conf "$V2") | grep -E '^[a-z-]*ttl[a-z-]*:' \
  | awk -F': *' -v m="$max_ttl" '$2+0 >= m {print $1}' | sed -n 1p)"
[[ -n "$Q6" ]] || { echo "no TTL option explains TTL $max_ttl" >&2; exit 3; }

echo "# first need-to-frag drop: $first_drop UTC; firewall tag: $tag; stale TTL seen: $max_ttl"
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
    want="$(jq -r --arg q "$q" '.answers[$q] // empty | tostring' "$TRUTH")"
    got_var="Q${q#q}"; got="${!got_var}"
    if [[ "$(norm <<<"$got")" == "$(norm <<<"$want")" ]]; then
      echo "$q PASS ($got)"
    else
      echo "$q FAIL (got '$got', expected '$want')"; fail=1
    fi
  done
  exit "$fail"
fi
