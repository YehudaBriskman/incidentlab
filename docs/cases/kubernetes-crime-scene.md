# CASE BIBLE: "Kubernetes Crime Scene" (case id: `kubernetes-crime-scene`)

> SPOILERS. Instructor/builder reference only. Never ship this file to players.
> Contract for `generator/cases/kubernetes-crime-scene/`, the case JSONs, the debriefs and
> `solutions/kubernetes-crime-scene/solve.sh`. Constants live in `generator/cases/kubernetes-crime-scene/story.py`.

Audience: working engineers. Target time: 10 min orientation + 50-60 min solve. Difficulty: hard.

## 1. The true story

**Lumenmart** (fictional e-commerce) runs `pricing-api`, a Spring Boot (Java 21) service, in namespace
`shop` of the prod cluster `prod-eu1` (3 worker nodes: `prod-eu1-general-6b4f-k2m9`, `-r7tq`, `-w3zx`).
It is deployed by **Flux** from the `platform-gitops` repo as a **HelmRelease** using the
`platform-charts/pricing-api` chart. The **Service** `shop/pricing-api` is *not* part of the chart
(`service.enabled: false`). It is a plain manifest (`apps/shop/pricing-api/service.yaml`) that selects
`app=pricing-api,tier=backend`.

Office time zone: Asia/Jerusalem, UTC+02:00. Incident date: **Tuesday 2026-11-17**.

At **07:51:12 UTC** `ronen.g` pushes commit **`pricing-api: migrate values to chart v3 schema`**
(the q2 answer is the first 7 chars of its fake SHA, currently `e7a7df7`, generated deterministically). It bumps the chart
2.7.4 -> 3.0.1 and rewrites the values "from the v3 example values". "No functional change intended."
It actually changes three things:

1. **Resources copied from the template**: memory limit **1536Mi -> 768Mi** (request 1Gi -> 512Mi, CPU
   2/500m -> 1/250m). `javaOpts` still says **`-Xmx1g`**, so the heap is allowed to grow past the cgroup
   limit. The JVM never throws `OutOfMemoryError`; the **kernel OOM-kills** it (exit 137, `OOMKilled`)
   as soon as the catalog delta refresh pushes RSS to 768 MiB, 1-3.5 min after each start.
2. **Labels**: chart v2's `extraPodLabels: {app: pricing-api, tier: backend}` became
   `podLabels: {tier: backend}`. The chart v3 adds `app.kubernetes.io/name|instance` itself, but the
   legacy **`app=pricing-api` label is gone**. The Deployment selector uses the `app.kubernetes.io/*` labels
   only, so the rollout works, but the **Service selects nothing**: endpoints are `<none>` even for pods that
   are `Running 1/1`.
3. **Probes**: the `probes:` block is a chart v2 key. Chart v3 reads `livenessProbe:`/`readinessProbe:` and
   silently ignores it, so chart defaults apply: liveness `delay=30s period=10s #failure=3` (kill at ~50 s)
   instead of 120 s. A JVM whose warmup is slower than ~50 s (crowded node, memory pressure) gets
   **liveness-killed** (exit 143, `Error`) before it is ever Ready.

Helm rev 14 starts at 07:52:29 UTC. The rolling update (maxSurge 1, maxUnavailable 0) replaces the four
rev 13 pods one at a time. Each new pod becomes Ready (warmup ~42 s), so one old pod is deleted. When the
last old pod goes at **07:55:36 UTC**, the Service has **no endpoints**: ingress returns 503 for every
`/api/v2/price*` request. That is the outage. Then the OOM kills start:

| UTC | pod | |
|---|---|---|
| **07:56:48** | **`pricing-api-6d5b8c7f9-m5rjc`** (r7tq) | **first OOM kill** (second pod created) |
| 07:57:06 | `pricing-api-6d5b8c7f9-2xkqp` (k2m9) | first pod created, second OOM |
| 07:58:22 | `pricing-api-6d5b8c7f9-bq9tz` (w3zx) | |
| 07:59:41 | `pricing-api-6d5b8c7f9-7hn4w` (k2m9) | |

Then the rest of the cascade:

- **HPA:** the CPU request was halved (500m -> 250m), so the same CPU reads as ~2x the utilization
  (150-260 % of request). The HPA scales 4 -> 8 at 08:03:12. On-call raises `maxReplicas` to 12 (commit at
  08:09:41, helm rev 15 at 08:10:02, which "fails" after 5 min because `--wait` never sees an available
  Deployment). The HPA scales 8 -> 12 (08:10:31), 12 -> 7 (08:17:02, metrics missing for unready pods),
  7 -> 12 (08:23:40) and 12 -> 9 (08:31:15). It is flapping on stale and missing metrics.
- **Node:** after the 08:10:31 scale-up, k2m9 runs 5 pricing JVMs plus `recs-feature-sync` (1.8 GiB used
  against a 256Mi request). The scheduler packed the pods by *requests* (512Mi each), but they *use* up to
  768Mi. k2m9 reports **MemoryPressure at 08:11:40**. The kubelet evicts the pod using the most memory above
  its request: **`recommendations/recs-feature-sync-6f7d9c8b4-hv2lp` at 08:11:52**. The pressure clears at
  08:16:55 (5 min transition period). k2m9 is cordoned 08:14:30 and uncordoned 08:35:10 (no effect).
  Warmups on crowded k2m9 are slow, so most pods there die by liveness rather than OOM.
- **Fix:** `noam.s` commits "restore v2 resources, app label and probe delays" at 08:39:50. Helm rev 16 runs at
  08:41:03. New ReplicaSet `7b8d4f6c5d` with 1536Mi, the `app` label back and correct probe keys. The first
  fixed pod is Ready at **08:41:58**, the endpoints are back and the 503s stop.

Totals during the incident: **50 OOM kills** (q6), **47 liveness kills**, 97 container restarts, across
17 pods of ReplicaSet `6d5b8c7f9`.

## 2. Timeline (UTC)

| UTC | Local | Event |
|---|---|---|
| 03:12:37 | 05:12:37 | red herring: `logging/fluent-bit-7xk2d` OOM-killed on k2m9 (200Mi limit) |
| 05:31:08 | 07:31:08 | red herring: `ci/ci-runner-7d4b9f8c5-xw2lm` evicted on w3zx (ephemeral-storage) |
| 07:19:55 / 07:21:40 | 09:19 / 09:21 | commit "add prometheus scrape annotations" -> helm rev 13 (harmless) |
| 07:31:40 / 07:33:05 | 09:31 / 09:33 | commit "inventory-api: bump image to 2.8.1" -> inventory-api upgrade (unrelated) |
| 07:51:12 | 09:51:12 | **bad commit pushed** |
| 07:51:50 / 07:51:58 | | Flux source fetch / kustomize apply (`HelmRelease/shop/pricing-api configured`, revision `main@sha1:<bad>`) |
| 07:52:29 | 09:52:29 | **helm rev 14** upgrade starts (`chart version changed from 2.7.4 to 3.0.1`) |
| 07:55:36 | 09:55:36 | last old pod deleted, **Service has no endpoints**, 503s begin |
| 07:56:48 | 09:56:48 | **first OOM kill: m5rjc** |
| 07:57:41 | 09:57:41 | alert fires |
| 08:03:12 | 10:03:12 | HPA 4 -> 8 |
| 08:09:41 / 08:10:02 | 10:09 / 10:10 | commit maxReplicas 12 -> helm rev 15 (fails at 08:15:02, context deadline exceeded) |
| 08:10:31 | 10:10:31 | HPA 8 -> 12 |
| 08:11:40 | 10:11:40 | **k2m9 MemoryPressure** |
| 08:11:52 | 10:11:52 | **evicted: recs-feature-sync-6f7d9c8b4-hv2lp** |
| 08:16:55 | 10:16:55 | MemoryPressure cleared |
| 08:17:02 / 08:23:40 / 08:31:15 | | HPA 12 -> 7 -> 12 -> 9 |
| 08:20:14 | 10:20:14 | red herring: `search/search-indexer-0` java OOM on w3zx (3Gi limit) |
| 08:39:50 | 10:39:50 | fix commit |
| 08:41:03 | 10:41:03 | helm rev 16 |
| 08:41:58 | 10:41:58 | first fixed pod Ready, endpoints back, outage over |

## 3. Questions and answers

Normalization: trim, lowercase, collapse whitespace.

| id | Question | Answer | Where it comes from | Pts |
|---|---|---|---|---|
| q1 | Which pricing-api pod was OOM-killed **first**? (full pod name) | `pricing-api-6d5b8c7f9-m5rjc` | Node journals: kernel `oom-kill:` lines carry `task_memcg=...cri-containerd-<cid>.scope`; the kubelet PLEG `ContainerDied` line with the same `<cid>` names the pod. The earliest pricing one is on r7tq at 07:56:48. Second route: the 07:57:10 snapshot in `get-pods-shop-snapshots.txt` shows m5rjc `1 (21s ago)` vs 2xkqp `1 (3s ago)` (2xkqp *looks* like the culprit: its STATUS reads `OOMKilled` and it was created first). | 100 |
| q2 | 7-char SHA of the GitOps commit that caused it | first 7 of the bad commit SHA (`e7a7df7`) | `helm/history-pricing-api.txt` (local time!): rev 14 at 09:52:29 local = 07:52:29 UTC is the last release before the first OOM -> `flux/flux-controllers.log`: the kustomize-controller apply with `"HelmRelease/shop/pricing-api":"configured"` at 07:51:58 carries `revision main@sha1:...` -> `gitops/git-log-p.txt` confirms the diff. | 100 |
| q3 | Memory limit the OOM-killed containers ran with (as in the pod spec) | `768Mi` | `describe-pod-*` Limits (not Requests 512Mi), `helm/values-rev14.yaml`, kernel `memory: usage 786432kB, limit 786432kB`, app log `cgroupMemoryLimitBytes=805306368`. | 100 |
| q4 | Which `key=value` of the Service selector does no pricing-api pod carry? | `app=pricing-api` | `describe-svc-pricing-api.txt` Selector `app=pricing-api,tier=backend` vs `get-pods-shop-labels.txt` (new pods have `tier=backend` but no `app=`), `service.yaml`, values diff. | 100 |
| q5 | Which unrelated pod did the kubelet evict because of memory pressure? | `recs-feature-sync-6f7d9c8b4-hv2lp` | `describe-nodes.txt`: k2m9 `MemoryPressure True` since 10:11:40 +0200 -> events JSON `Evicted` on that host, message `low on resource: memory`; k2m9 journal eviction manager. Trap: `ci-runner-7d4b9f8c5-xw2lm` also shows `Evicted` in `get-pods-A.txt` (disk, w3zx, hours earlier). | 100 |
| q6 | How many times in total were pricing-api containers OOM-killed during the incident? | `50` | Count kernel OOM kills in the three node journals whose container belongs to a `shop/pricing-api-*` pod. Traps: RESTARTS counts include 47 liveness kills (97 total); `(java)` alone also matches `search-indexer-0` (51); all `Killed process` lines also include fluent-bit (52); `SystemOOM` node events also include search-indexer. | 150 |

## 4. Evidence pack (`build/evidence/kubernetes-crime-scene/`)

| File | Format / zone | Role |
|---|---|---|
| `README_FIRST.txt` | text | briefing, file list, time zones |
| `kubectl/get-events-A-wide.txt` | relative ages, captured 08:44:12 UTC, default (namespace/name) order | trap: not time-sorted; ages older than 10 min only have minute resolution |
| `kubectl/get-events-A.json` | UTC | same events with absolute times; 1 h TTL (no fluent-bit / ci-runner) |
| `kubectl/get-pods-shop-snapshots.txt` | 7 snapshots 07:50-08:45 UTC, relative ages | q1 second route, restart counts |
| `kubectl/get-pods-A.txt` | 08:38:47 UTC | two `Evicted` pods (q5 trap) |
| `kubectl/get-pods-shop-labels.txt` | 08:06:40 UTC | q4 labels + Deployment selector |
| `kubectl/get-endpoints-pricing-api.txt` | 07:50 / 08:06 / 08:45 UTC | endpoints 4 -> none -> 9 |
| `kubectl/describe-svc-pricing-api.txt` | 08:06:15 UTC | q4 selector |
| `kubectl/describe-pod-pricing-api-6d5b8c7f9-bq9tz.txt` | +0200 | Last State OOMKilled, Limits (q3) |
| `kubectl/describe-pod-pricing-api-6d5b8c7f9-f2lsv.txt` | +0200 | Last State Error 137/143 (liveness) contrast |
| `kubectl/describe-nodes.txt` | 08:13:05 UTC, +0200 inside | q5 MemoryPressure, requests vs usage |
| `kubectl/describe-hpa-pricing-api.txt` | 08:27:30 UTC | flapping, FailedGetResourceMetric |
| `helm/history-pricing-api.txt` | laptop local time, no zone | q2 |
| `helm/values-rev13.yaml`, `values-rev14.yaml` | YAML | the diff |
| `gitops/git-log-p.txt` | +0200 | q2 confirmation, red herring commits |
| `gitops/apps/shop/pricing-api/service.yaml` | YAML | q4 |
| `flux/flux-controllers.log` | JSONL UTC | q2 revision mapping |
| `nodes/<node>.journal.log` | syslog + klog, UTC | q1, q5, q6 |
| `ingress/ingress-nginx-controller.log` | UTC | outage window (503, `does not have any active Endpoint`). Note: `$request_length` can coincidentally be 503, so grep `' 503 '` overcounts; use the status field |
| `logs/pricing-api-6d5b8c7f9-bq9tz{,.previous}.log`, `logs/...-f2lsv.previous.log` | UTC | log ends abruptly (OOM) vs graceful shutdown (liveness); `quote requests last 60s: 0` proves no traffic reached Ready pods |
| `metrics/hpa-pricing-api.csv` | epoch, 15 s | HPA flapping, CPU % doubled |
| `metrics/node-memory.csv` | epoch, 15 s | k2m9 available < 500 MiB at 08:11:45 |
| `chat/inc-4127-pricing-api.txt` | local | competing theories |

## 5. Red herrings (and why they're wrong)

- **"k2m9 is a bad node"** (avi.p): the 05:12 local OOM was fluent-bit with its own 200Mi limit, hours
  earlier. Pricing OOMs happen on all three nodes. Cordoning changed nothing.
- **"Memory leak in 4.12.3"** (ronen.g): the image tag is identical in rev 12, 13, 14 and 16. The same image
  runs fine after the fix.
- **"inventory-api deploy"** (tamar.l): different app, 20 min earlier, no dependency.
- **"Helm is broken"**: rev 15 failed because `--wait` timed out on an unavailable Deployment. That's a symptom.
- **"metrics-server is broken / HPA misconfigured"**: the HPA reacts to halved requests and to unready pods
  without metrics.
- **"Readiness gate stuck"**: pods *are* Ready; the Service just doesn't select them.
- **"Cluster-wide memory issue"** (search-indexer OOM 08:20): its own 3Gi limit, happens on reindex.
- **recs batch-size commit (Nov 16)**: it's why feature-sync uses 1.8 GiB, which explains *which* pod the
  kubelet picked, not why the node filled up.

## 6. Generator notes

- `story.py`: constants + `simulate()`. The first runs of the four rollout pods are hand-placed (to fix q1),
  the rest is seeded random: slow warmup (liveness kill at start+~50 s) on crowded k2m9 / during pressure,
  otherwise Ready at 40-48 s and OOM 65-205 s later; CrashLoopBackOff 10, 20, 40 ... 300 s.
- `build.py` cross-checks: first OOM is m5rjc, ≥5 s ahead of the next; no OOM after the fix; kernel
  `Killed process` lines = OOM count + 2 red herrings; exactly one `Evicted` event (hv2lp); the restart total
  differs from the OOM count; no answer in README_FIRST.txt; pack < 40 MB.
