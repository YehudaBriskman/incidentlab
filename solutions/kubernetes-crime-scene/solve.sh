#!/usr/bin/env bash
# Official solver for IncidentLab case "kubernetes-crime-scene".
# Derives every answer from the evidence files only (grep/awk/sed/sort/jq/date).
# Usage: solutions/kubernetes-crime-scene/solve.sh [evidence_dir]
#        (default: build/evidence/kubernetes-crime-scene)
# If build/truth/kubernetes-crime-scene.answers.json exists, compares and exits 1 on any FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EV="${1:-$ROOT/build/evidence/kubernetes-crime-scene}"
EV="$(cd "$EV" && pwd)"
TRUTH="${TRUTH:-$ROOT/build/truth/kubernetes-crime-scene.answers.json}"

JOURNALS=("$EV"/nodes/*.journal.log)
HELM_HIST="$EV/helm/history-pricing-api.txt"
FLUX="$EV/flux/flux-controllers.log"
SVC="$EV/kubectl/describe-svc-pricing-api.txt"
LABELS="$EV/kubectl/get-pods-shop-labels.txt"
NODES="$EV/kubectl/describe-nodes.txt"
EVENTS="$EV/kubectl/get-events-A.json"
for f in "${JOURNALS[@]}" "$HELM_HIST" "$FLUX" "$SVC" "$LABELS" "$NODES" "$EVENTS"; do
  [[ -f "$f" ]] || { echo "missing evidence file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- shared: every kernel OOM kill, joined to the pod that owned the container ----------
# kernel:  "... oom-kill:constraint=...,task_memcg=/kubepods.slice/...cri-containerd-<cid>.scope,task=java,..."
# kubelet: "SyncLoop (PLEG): event for pod" pod="<ns>/<pod>" event={...,"Type":"ContainerDied","Data":"<cid>"}
# Output: "<HH:MM:SS> <ns>/<pod> <task>" for every OOM kill (journals are UTC).
awk '
  /"Type":"ContainerDied"/ {
    match($0, /pod="[^"]+"/); p = substr($0, RSTART + 5, RLENGTH - 6)
    match($0, /"Data":"[0-9a-f]+"/); c = substr($0, RSTART + 8, RLENGTH - 9)
    owner[c] = p; next
  }
  /kernel: oom-kill:/ {
    match($0, /task_memcg=[^,]*cri-containerd-[0-9a-f]+\.scope/); m = substr($0, RSTART, RLENGTH)
    sub(/.*cri-containerd-/, "", m); sub(/\.scope$/, "", m)
    match($0, /task=[^,]+/); task = substr($0, RSTART + 5, RLENGTH - 5)
    n++; t[n] = $3; cid[n] = m; tk[n] = task
  }
  END { for (i = 1; i <= n; i++) print t[i], (cid[i] in owner ? owner[cid[i]] : "?"), tk[i] }
' "${JOURNALS[@]}" | sort > "$WORK/ooms.txt"

grep -E ' shop/pricing-api-' "$WORK/ooms.txt" > "$WORK/pricing-ooms.txt" || true
[[ -s "$WORK/pricing-ooms.txt" ]] || { echo "no pricing-api OOM kills found" >&2; exit 3; }

# ---------- q1: first pricing-api pod to be OOM-killed ----------
first_line="$(head -n1 "$WORK/pricing-ooms.txt")"
Q1="$(awk '{print $2}' <<<"$first_line" | sed 's#^shop/##')"
q1_time="$(awk '{print $1}' <<<"$first_line")"                 # HH:MM:SS UTC on 2026-11-17
q1_epoch="$(date -u -d "2026-11-17 $q1_time" +%s)"

# ---------- q2: GitOps commit behind the Helm revision that was live at the first OOM ----------
# helm history UPDATED is laptop local time (UTC+02:00). Find the last revision before the first OOM.
# "Tue Nov 17 09:52:29 2026" -> "2026-11-17 09:52:29"
rev_line="$(awk -F'\t' 'NR > 2 {
    split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " "); for (i in mn) mon[mn[i]] = i
    gsub(/^ +| +$/, "", $1); split($2, d, " +")
    printf "%s\t%s-%02d-%02d %s\n", $1, d[5], mon[d[2]], d[3], d[4]
  }' "$HELM_HIST" \
  | while IFS=$'\t' read -r rev upd; do
      e="$(date -u -d "$upd +0200" +%s)"
      if (( e <= q1_epoch )); then printf "%s %s\n" "$e" "$rev"; fi
    done | sort -n | tail -n1)"
rev_epoch="${rev_line%% *}"
rev_iso="$(date -u -d "@$rev_epoch" +%Y-%m-%dT%H:%M:%S)"
# The kustomize-controller apply that changed HelmRelease/shop/pricing-api just before that helm upgrade.
Q2="$(jq -r --arg t "$rev_iso" '
  select(.controller == "kustomization" and ((.output // {}) | has("HelmRelease/shop/pricing-api")))
  | select(.ts[0:19] <= $t) | .revision' "$FLUX" | tail -n1 | sed -E 's/.*sha1:([0-9a-f]{7}).*/\1/')"

# ---------- q3: memory limit of the OOM-killed containers ----------
desc="$(grep -l 'Reason:       OOMKilled' "$EV"/kubectl/describe-pod-pricing-api-*.txt | head -n1)"
Q3="$(awk '/^    Limits:/ {inlim = 1; next} inlim && /memory:/ {print $2; exit} /^    Requests:/ {inlim = 0}' "$desc")"

# ---------- q4: Service selector pair that no pricing-api pod carries ----------
selector="$(awk '/^Selector:/ {print $2; exit}' "$SVC")"
awk '$1 ~ /^pricing-api-/ {print $NF}' "$LABELS" | tr ',' '\n' | sort -u > "$WORK/pod-labels.txt"
Q4=""
IFS=',' read -ra pairs <<<"$selector"
for pair in "${pairs[@]}"; do
  grep -qxF "$pair" "$WORK/pod-labels.txt" || Q4="$pair"
done

# ---------- q5: pod evicted by the node that reported MemoryPressure ----------
pressure_node="$(awk '/^Name:/ {n = $2} /^  MemoryPressure +True/ {print n; exit}' "$NODES")"
Q5="$(jq -r --arg n "$pressure_node" '.items[]
  | select(.reason == "Evicted" and .source.host == $n and (.message | test("low on resource: memory")))
  | .involvedObject.name' "$EVENTS" | head -n1)"

# ---------- q6: total OOM kills of pricing-api containers ----------
Q6="$(wc -l < "$WORK/pricing-ooms.txt" | tr -d ' ')"

echo "# first OOM at $q1_time UTC; helm revision live then: $(awk '{print $2}' <<<"$rev_line") ($rev_iso UTC)"
echo "# all OOM kills in the journals: $(wc -l < "$WORK/ooms.txt"), MemoryPressure node: $pressure_node"
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
