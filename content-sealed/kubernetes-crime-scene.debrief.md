## What actually happened

At 09:51 local time a developer pushed a "housekeeping" commit to the GitOps repo: **`pricing-api: migrate values to chart v3 schema`**. It bumped the Helm chart from 2.7.4 to 3.0.1 and rewrote the values "from the v3 example values". The commit message said *no functional change intended*. It changed three things that mattered:

1. **Memory limit 1536Mi to 768Mi** (and requests from 1Gi to 512Mi, CPU from 2/500m to 1/250m), copied from the chart's example values. `javaOpts` still said **`-Xmx1g`**, so the JVM was allowed a heap bigger than its whole container.
2. **The `app=pricing-api` label disappeared.** Chart v2 took extra labels from `extraPodLabels`; chart v3 reads `podLabels` and adds the standard `app.kubernetes.io/*` labels itself. The migration kept `tier: backend` and dropped `app: pricing-api`. The Deployment's own selector uses the `app.kubernetes.io/*` labels, so the rollout went fine. The **Service**, however, is a separate manifest that still selects `app=pricing-api,tier=backend`.
3. **The probe settings were silently ignored.** The old `probes:` block is a chart v2 key. Chart v3 reads `livenessProbe:` / `readinessProbe:`, so the chart defaults applied: liveness after 30 s, killed after about three failures, instead of 120 s.

One commit, one root cause. Everything else was a witness.

## Timeline

| UTC | Local (UTC+2) | Event |
|---|---|---|
| 03:12 | 05:12 | `fluent-bit` OOM-killed on k2m9 (its own 200Mi limit; unrelated) |
| 05:31 | 07:31 | `ci-runner` evicted on w3zx for **ephemeral-storage** (unrelated) |
| 07:21 | 09:21 | Helm rev 13: Prometheus annotations (harmless) |
| 07:33 | 09:33 | inventory-api 2.8.1 deployed (unrelated) |
| 07:51:12 | 09:51:12 | **The values-migration commit is pushed** |
| 07:51:58 | 09:51:58 | Flux applies it (`HelmRelease/shop/pricing-api configured`) |
| 07:52:29 | 09:52:29 | **Helm rev 14** upgrade starts; the rolling update begins |
| 07:55:36 | 09:55:36 | Last old pod removed. **The Service has no endpoints**: every price request gets 503 |
| 07:56:48 | 09:56:48 | **First OOM kill: `pricing-api-6d5b8c7f9-m5rjc`** |
| 08:03:12 | 10:03:12 | HPA scales 4 to 8 |
| 08:10:02 | 10:10:02 | On-call raises `maxReplicas` to 12 (rev 15, "fails" on `--wait`) |
| 08:10:31 | 10:10:31 | HPA scales 8 to 12 |
| 08:11:40 | 10:11:40 | **k2m9 reports MemoryPressure** |
| 08:11:52 | 10:11:52 | **`recs-feature-sync-6f7d9c8b4-hv2lp` evicted** |
| 08:14 to 08:35 | 10:14 to 10:35 | k2m9 cordoned, then uncordoned (no effect) |
| 08:17 to 08:31 | 10:17 to 10:31 | HPA flaps: 12, 7, 12, 9 |
| 08:20:14 | 10:20:14 | `search-indexer-0` OOM-killed on w3zx (its own 3Gi limit; unrelated) |
| 08:39:50 | 10:39:50 | Fix commit: old resources, `app` label back, probes under the right keys |
| 08:41:58 | 10:41:58 | First fixed pod Ready, endpoints back, 503s stop |

Outage: **46 minutes**. 50 OOM kills, 47 liveness kills, 97 restarts across 17 pods.

## How one change produced five symptoms

- **OOMKilled pods.** `-Xmx1g` inside a 768Mi container. The JVM loads its 1.2 M-SKU price book, then the first delta refresh pushes the process over the cgroup limit. The kernel kills it (exit 137) before Java can throw `OutOfMemoryError`, so the container log simply stops.
- **Liveness kills.** On a crowded node, JVM warmup took longer than the chart's default liveness window, so the kubelet killed containers (exit 143) that would have been fine 30 s later. Those restarts look exactly like the OOM ones in `RESTARTS`.
- **A Service with no endpoints.** Pods that survived warmup were Ready, but they no longer carried `app=pricing-api`. A selector that matches zero pods isn't an error, just an empty Endpoints object. The app log even says `quote requests last 60s: 0`.
- **An HPA that can't make up its mind.** Halving the CPU request doubled the *utilization percentage* for the same CPU, so the HPA scaled up. When no pod was Ready it had no metrics (`FailedGetResourceMetric`), and with half the pods restarting at any moment it flapped between 7 and 12.
- **A node under pressure, and an innocent victim.** The scheduler packs by *requests* (512Mi each). Five pricing JVMs that really used up to 768Mi landed on k2m9 next to a sync job using 1.8 GiB against a 256Mi request. When available memory dropped under 500Mi, the kubelet evicted the pod furthest over its request: the other team's `recs-feature-sync`.

## Why the red herrings were wrong

- **"k2m9 is a bad node."** The early-morning OOM was fluent-bit hitting its own limit, five hours earlier. Pricing pods were OOM-killed on all three nodes, and cordoning k2m9 changed nothing.
- **"A memory leak in 4.12.3."** The image tag was the same in revisions 12, 13, 14 and 16. The same image ran fine after the fix.
- **"The inventory deploy."** Different service, 20 minutes earlier, no dependency on pricing.
- **"Helm is broken."** Rev 15 failed because `helm --wait` never saw an available Deployment. A symptom of the outage, not a cause.
- **"metrics-server is broken."** Other HPAs read metrics fine. The pricing HPA was reacting to halved requests and unready pods.
- **"Readiness gate stuck."** The pods *were* Ready. The Service just didn't select them.
- **"Cluster-wide memory problem."** `search-indexer-0` has its own 3Gi limit and OOMs on reindex now and then.

## Fixes

**Immediate:** restore the memory and CPU values, put the `app: pricing-api` label back under `podLabels`, and move the probe settings to `livenessProbe` / `readinessProbe`. That's exactly what the fix commit did.

**Structural**
- **Diff the rendered output, not the values.** Run `helm diff upgrade` / `flux diff` in CI on every HelmRelease change, and require a second reviewer when limits, labels or probes change.
- **Size the JVM from the container.** Replace `-Xmx` with `-XX:MaxRAMPercentage=75` so the heap follows the limit, and set limits from measured peak usage.
- **Keep the Service with the pods it selects.** Ship the Service in the chart (or the same kustomization) and select on the same labels as the Deployment.
- **Alert on empty endpoints.** `kube_endpoint_address_available == 0` for any Service behind an ingress pages in seconds, not minutes.
- **Validate values.** Chart v3 should ship a `values.schema.json` with `additionalProperties: false`, so an unknown key like `probes` or `extraPodLabels` fails the upgrade instead of being ignored.
- **Use startup probes for slow starters.** A `startupProbe` gives a JVM time to warm up without weakening the liveness probe.
- **Requests that reflect reality.** For critical services set memory requests equal to limits, so the scheduler can't overcommit the node.
- **Canary the GitOps change.** A rollout that waits for real traffic success (not just Ready) would have stopped at the first pod.

## The real incident: Reddit, 14 March 2023 ("Pi-Day")

Reddit upgraded one of its Kubernetes clusters from 1.23 to 1.24. That release replaced the `node-role.kubernetes.io/master` label with `control-plane`. Reddit's Calico route reflectors were configured with a node selector on the old label, so after the upgrade no route reflectors were selected, pod networking fell apart and the site was down for about **314 minutes**. The team eventually restored the cluster from a backup. Nothing crashed with a clear error; a selector quietly stopped matching anything.

Read their write-up: **"You Broke Reddit: The Pi-Day Outage"** on r/RedditEng.

## Real-world takeaways

1. **One change, many symptoms.** When five things break at once, look for the one change they share before chasing each one.
2. **"No functional change" is a claim, not a fact.** Refactors of config are deploys. Diff what gets rendered and applied.
3. **Selectors fail silently.** A label rename never errors; it just matches nothing. Alert on empty endpoints and keep selectors and their targets in one place.
4. **Restarts are not one thing.** OOM kills (137), liveness kills (143) and evictions are different killers with different fixes. Count them separately.
5. **Requests drive scheduling, usage drives eviction.** When they disagree, someone else's pod pays.
