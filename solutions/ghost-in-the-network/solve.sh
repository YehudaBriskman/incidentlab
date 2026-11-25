#!/usr/bin/env bash
# Official solver for IncidentLab case "ghost-in-the-network".
# Derives every answer from the evidence files only, using stock tools that ship with
# Linux/WSL, Git Bash and macOS (grep, sed, POSIX awk, sort, uniq, cut, comm, wc, tr).
# No jq, no GNU-only `date -d`: JSON lines are read as flat "key":"value" text and all
# time arithmetic is done in awk.
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

# POSIX awk helper: civil date/time (UTC) -> Unix epoch seconds (days-from-civil algorithm).
EPOCH_FN='function ep(Y, M, D, h, mi, s,   y, era, yoe, mp, doy, doe) {
  y = Y - (M <= 2); era = int(y / 400); yoe = y - era * 400; mp = (M + 9) % 12
  doy = int((153 * mp + 2) / 5) + D - 1; doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return (era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + s
}'
# ISO-8601 "YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)" -> epoch seconds (UTC).
iso_epoch() {
  awk "$EPOCH_FN"'
    { t = $0; off = 0
      if (t ~ /[+-][0-9][0-9]:[0-9][0-9]$/) {
        sg = substr(t, length(t) - 5, 1); off = substr(t, length(t) - 4, 2) * 3600 + substr(t, length(t) - 1, 2) * 60
        if (sg == "-") off = -off
      }
      print ep(substr(t,1,4)+0, substr(t,6,2)+0, substr(t,9,2)+0, substr(t,12,2)+0, substr(t,15,2)+0, substr(t,18,2)+0) - off }'
}
# Syslog "Mon DD HH:MM:SS" plus a year, taken as UTC -> epoch seconds.
syslog_epoch() {
  awk -v year="$1" "$EPOCH_FN"'
    { m = (index("JanFebMarAprMayJunJulAugSepOctNovDec", $1) + 2) / 3; split($3, c, ":")
      print ep(year, m, $2 + 0, c[1] + 0, c[2] + 0, c[3] + 0) }'
}
hms() { awk '{ s = $1 % 86400; printf "%02d:%02d:%02d\n", int(s / 3600), int(s % 3600 / 60), s % 60 }'; }

# ---------- q1: first request that connected, then hung (logged time, converted to UTC) ----------
# The app logs local time (+02:00) when a request ENDS. phase=connect failures are a different
# problem (they never reached the ledger), so only phase=response counts.
first_hang_local="$(grep '"phase":"response"' "$APP" | grep -o '"ts":"[^"]*"' | cut -d'"' -f4 | sort | sed -n 1p)"
[[ -n "$first_hang_local" ]] || { echo "no phase=response failure found" >&2; exit 3; }
first_hang_epoch="$(iso_epoch <<<"$first_hang_local")"
Q1="$(hms <<<"$first_hang_epoch")"

# ---------- q2: the change that started dropping ICMP "fragmentation needed" ----------
# 1) first need-to-frag drop in the host firewall log (syslog, UTC, no year: it's 2026)
first_drop="$(grep 'IN-DROP-ICMP:' "$KERN" | grep 'TYPE=3 CODE=4' | awk '{print $1" "$2" "$3}' | sort -k3 | sed -n 1p)"
first_drop_epoch="$(syslog_epoch 2026 <<<"$first_drop")"
# 2) the tag on the iptables rule that drops ICMP
tag="$(grep -E -- '-p icmp .*-j DROP' "$IPT_AFTER" | sed -nE 's/.*--comment "([^:"]+):.*/\1/p' | sed -n 1p)"
[[ -n "$tag" ]] || { echo "no tagged ICMP DROP rule" >&2; exit 3; }
# 3) the latest change that shipped that tag and started before the first drop
Q2="$(grep -F "$tag" "$CHANGES" | grep -E '^CHG-' | sort -t, -k2,2 \
  | awk -F, -v limit="$first_drop_epoch" "$EPOCH_FN"'
      { t = $2; e = ep(substr(t,1,4)+0, substr(t,6,2)+0, substr(t,9,2)+0, substr(t,12,2)+0, substr(t,15,2)+0, substr(t,18,2)+0)
        if (e <= limit) id = $1 }
      END { print id }')"
[[ -n "$Q2" ]] || { echo "no change carrying tag $tag" >&2; exit 3; }
(( first_drop_epoch <= first_hang_epoch )) || echo "WARN: first drop after first hang" >&2

# ---------- q3: MSS that fits the tunnel = path MTU - 20 (IPv4) - 20 (TCP) ----------
mtu_fw="$(grep -o 'MTU=[0-9]*' "$KERN" | sort | uniq -c | sort -rn | awk 'NR==1{sub("MTU=","",$2); print $2}')"
mtu_pcap="$(grep -o 'need to frag (mtu [0-9]*)' "$LARGE" | grep -o '[0-9][0-9]*' | sort -u | sed -n 1p)"
[[ "$mtu_fw" == "$mtu_pcap" ]] || echo "WARN: firewall MTU $mtu_fw != capture MTU $mtu_pcap" >&2
Q3=$(( mtu_fw - 40 ))

# ---------- q4: the address hosts connect to that no longer answers ----------
peers="$(grep '"phase":"connect"' "$APP" | grep -o '"peer":"[^"]*"' | cut -d'"' -f4 | sort -u)"
[[ "$(wc -l <<<"$peers" | tr -d ' ')" -eq 1 ]] || { echo "expected one connect-phase peer, got: $peers" >&2; exit 3; }
Q4="$peers"

# ---------- q5: how many app hosts were still talking to it ----------
Q5="$(grep -F "\"peer\":\"$Q4\"" "$APP" | grep -o '"host":"[^"]*"' | sort -u | wc -l | tr -d ' ')"

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
