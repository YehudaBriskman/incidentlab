#!/usr/bin/env python3
"""Build the evidence pack + truth file for IncidentLab case `kubernetes-crime-scene`.

Usage: python3 generator/cases/kubernetes-crime-scene/build.py
Stdlib only, fixed seed, deterministic. See docs/cases/kubernetes-crime-scene.md (SPOILERS).
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import story as S  # noqa: E402
import kube_render as K  # noqa: E402
import text_render as T  # noqa: E402


def fail(msg: str) -> None:
    print(f"[{S.CASE_ID}] CROSS-CHECK FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def write(rel: str, content: str) -> None:
    p = S.EVIDENCE_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


README = """LUMENMART // INC-4127 // FOLLOW-UP PACK
=======================================

Tuesday 17 November 2026, late morning. You weren't on call. Now you own the RCA.

Around 10:00 local time the pricing API in the `shop` namespace of our prod
cluster (prod-eu1) went dark: the app and the website could not show prices.
For about three quarters of an hour the incident channel chased a crashlooping
deployment, a node that "looked sick", an evicted pod from another team, an HPA
that kept changing its mind and a Service with no endpoints. Then someone pushed
a fix commit to the GitOps repo and prices came back.

Everyone has a theory. Your job is to separate the cause from the symptoms, from
the evidence only. The questions are on the IncidentLab site.

Cluster facts: three worker nodes (prod-eu1-general-6b4f-k2m9, -r7tq, -w3zx),
Kubernetes v1.31, containerd, Flux CD watching the `platform-gitops` repo, Helm
charts from `platform-charts`. pricing-api is a Spring Boot (Java 21) service.


WHAT'S IN THE PACK
------------------
README_FIRST.txt                              this file
kubectl/get-events-A-wide.txt                 `kubectl get events -A -o wide` as on-call ran it (default order)
kubectl/get-events-A.json                     the same events as JSON (`-o json`)
kubectl/get-pods-shop-snapshots.txt           `kubectl -n shop get pods -o wide`, run several times during the incident
kubectl/get-pods-A.txt                        every pod in the cluster, near the end of the incident
kubectl/get-pods-shop-labels.txt              shop pods with their labels, plus the Deployment selector
kubectl/get-endpoints-pricing-api.txt         Endpoints / EndpointSlices of the pricing-api Service at three moments
kubectl/describe-svc-pricing-api.txt          the pricing-api Service, plus every Service in shop
{describe_pods}
kubectl/describe-nodes.txt                    all three worker nodes, during the incident
kubectl/describe-hpa-pricing-api.txt          the pricing-api HorizontalPodAutoscaler
helm/history-pricing-api.txt                  `helm history` for the pricing-api release
helm/values-rev13.yaml                        `helm get values --revision 13`
helm/values-rev14.yaml                        `helm get values --revision 14`
gitops/git-log-p.txt                          `git log -p` of the platform-gitops repo (recent history)
gitops/apps/shop/pricing-api/service.yaml     the pricing-api Service manifest (plain YAML, not part of the chart)
flux/flux-controllers.log                     source-, kustomize- and helm-controller logs (JSON lines)
nodes/<node>.journal.log                      `journalctl -k -u kubelet -u containerd` from each worker node
ingress/ingress-nginx-controller.log          ingress controller log (access log + controller warnings)
logs/*.log                                    `kubectl logs` of pricing-api containers ({logs_note})
metrics/hpa-pricing-api.csv                   HPA status scraped every 15 s
metrics/node-memory.csv                       node memory working set / available, every 15 s
chat/inc-4127-pricing-api.txt                 export of the incident channel


TIME ZONES AND FORMATS (read this)
----------------------------------
- Node journals: UTC. Syslog prefix `Nov 17 07:56:52` (no year, no zone) and
  klog prefix `I1117 07:56:52.123456` (I/W/E = info/warning/error, MMDD).
- kubectl events JSON, flux logs, container logs: UTC, ISO-8601 with `Z`.
- `kubectl get events -A -o wide` and `kubectl get pods`: ages are RELATIVE
  ("5m3s", "47m") to the moment the command ran. Every block starts with the
  `date -u` on-call ran first, so you can turn ages back into times.
- `kubectl describe`: kubectl prints times in the laptop's zone, +0200.
- helm history: the laptop's local time (Asia/Jerusalem, UTC+02:00), no zone shown.
- git log: author dates with their offset (+0200).
- ingress log: [17/Nov/2026:07:55:37 +0000], UTC.
- metrics CSVs: unix epoch seconds.
- chat: Asia/Jerusalem local time (UTC+02:00).
- Kubernetes keeps events for one hour only. Anything older survives only in the
  node journals.


TIPS
----
- kubectl output is just text: grep, awk, sed and sort work fine on it, and
  nothing needs installing. The events JSON has a plain-text twin
  (get-events-A-wide.txt) if you would rather not parse JSON.
- A pod's RESTARTS count includes every kind of restart, not only OOM kills.
- The people in the chat were busy and some of them were wrong.

Good luck. Find the one change that explains everything.
"""


def main() -> None:
    if S.EVIDENCE_DIR.exists():
        shutil.rmtree(S.EVIDENCE_DIR)
    S.EVIDENCE_DIR.mkdir(parents=True)
    S.TRUTH_DIR.mkdir(parents=True, exist_ok=True)

    world = S.simulate()
    store = K.build_events(world)

    ooms = S.oom_runs(world)
    lives = S.liveness_runs(world)
    if not ooms:
        fail("no OOM kills simulated")
    first_pod, first_run = ooms[0]
    if first_pod.short != "m5rjc":
        fail(f"first OOM is {first_pod.name}, expected m5rjc")
    if len(ooms) > 1 and (ooms[1][1].end - first_run.end).total_seconds() < 5:
        fail("first two OOMs too close together")
    if any(run.end >= S.FIX_ROLLOUT for _, run in ooms):
        fail("OOM after the fix rollout")
    if len(lives) < 5:
        fail(f"only {len(lives)} liveness kills, the restart-count trap needs more")
    if S.endpoints_at(world, S.OUTAGE_START + K.sec(1)):
        fail("endpoints not empty after outage start")
    if not S.endpoints_at(world, S.OUTAGE_END + K.sec(1)):
        fail("endpoints still empty after outage end")
    if any(run.end and run.end < S.OUTAGE_START and run.outcome == "oom" for p in world.bad_pods for run in p.runs):
        fail("OOM before outage start")

    # describe targets: alive at capture, one whose last death was OOM, one liveness
    cap = S.utc(8, 38, 47)

    def last_death(p):
        ds = [run for run in p.runs if run.end and run.end <= cap and run.outcome in ("oom", "liveness")]
        return ds[-1] if ds else None

    def running_at(p):
        return any(run.start <= cap and (run.end is None or run.end > cap) for run in p.runs)

    alive = [p for p in world.bad_pods if p.created <= cap and (p.deleted is None or p.deleted > cap)]
    oom_pick = next((p for p in sorted(alive, key=lambda p: p.name)
                     if last_death(p) and last_death(p).outcome == "oom" and running_at(p)
                     and last_death(p) is not p.runs[0]), None)
    live_pick = next((p for p in sorted(alive, key=lambda p: p.name)
                      if last_death(p) and last_death(p).outcome == "liveness" and p is not oom_pick), None)
    if oom_pick is None or live_pick is None:
        fail("could not pick describe targets")
    if first_pod in (oom_pick, live_pick):
        fail("describe target is the first-OOM pod (would make q1 trivial)")

    # ---------------- evidence
    write("kubectl/get-events-A-wide.txt", K.events_wide(store))
    write("kubectl/get-events-A.json", K.events_json(store))
    write("kubectl/get-pods-shop-snapshots.txt", K.get_pods_snapshots(world))
    write("kubectl/get-pods-A.txt", K.get_pods_all(world, cap))
    write("kubectl/get-pods-shop-labels.txt", K.get_pods_labels(world, S.utc(8, 6, 40)))
    write("kubectl/get-endpoints-pricing-api.txt", K.endpoints_file(world))
    write("kubectl/describe-svc-pricing-api.txt", K.describe_svc(world))
    write(f"kubectl/describe-pod-{oom_pick.name}.txt", K.describe_pod(world, store, oom_pick, cap))
    write(f"kubectl/describe-pod-{live_pick.name}.txt", K.describe_pod(world, store, live_pick, cap))
    write("kubectl/describe-nodes.txt", K.describe_nodes(world, store))
    write("kubectl/describe-hpa-pricing-api.txt", K.describe_hpa(world, store))
    write("helm/history-pricing-api.txt", T.helm_history())
    write("helm/values-rev13.yaml", T.helm_values(13))
    write("helm/values-rev14.yaml", T.helm_values(14))
    write("gitops/git-log-p.txt", T.git_log_p())
    write("gitops/apps/shop/pricing-api/service.yaml", T.SERVICE_YAML)
    write("flux/flux-controllers.log", T.flux_log())
    journals, oom_lines = T.journals(world)
    for node, text in journals.items():
        write(f"nodes/{node}.journal.log", text)
    write("ingress/ingress-nginx-controller.log", T.ingress(world))

    # container logs
    ld = last_death(oom_pick)
    cur = next(run for run in oom_pick.runs if run.start <= cap and (run.end is None or run.end > cap))
    write(f"logs/{oom_pick.name}.log", T.run_log(oom_pick, cur, cap, 1))
    write(f"logs/{oom_pick.name}.previous.log", T.run_log(oom_pick, ld, cap, 2))
    lld = last_death(live_pick)
    write(f"logs/{live_pick.name}.previous.log", T.run_log(live_pick, lld, cap, 3))

    hpa_csv, node_csv = T.metrics(world)
    write("metrics/hpa-pricing-api.csv", hpa_csv)
    write("metrics/node-memory.csv", node_csv)
    write("chat/inc-4127-pricing-api.txt", T.chat(world))

    dp = (f"kubectl/describe-pod-{oom_pick.name}.txt\n"
          f"kubectl/describe-pod-{live_pick.name}.txt   two pricing-api pods, during the incident")
    write("README_FIRST.txt", README.format(
        describe_pods=dp, logs_note="current and --previous containers"))

    # ---------------- answers + cross-checks against what was written
    shas = T.commit_shas()
    bad_idx = [c[0] for c in T.commits()].index(S.BAD_COMMIT_TIME)
    q2 = shas[bad_idx][:7]
    answers = {
        "q1": first_pod.name,
        "q2": q2,
        "q3": S.NEW_LIMIT,
        "q4": "app=pricing-api",
        "q5": S.EVICTED_POD,
        "q6": str(len(ooms)),
    }
    # the kernel lines written must match the simulated count (+2 red herrings)
    jtxt = "".join(journals.values())
    killed = re.findall(r"Memory cgroup out of memory: Killed process \d+ \((\w[\w-]*)\)", jtxt)
    if len(killed) != len(ooms) + 2 or oom_lines != len(ooms) + 2:
        fail(f"kernel OOM lines {len(killed)} != simulated {len(ooms)} + 2 red herrings")
    if f"main@sha1:{shas[bad_idx]}" not in (S.EVIDENCE_DIR / "flux/flux-controllers.log").read_text():
        fail("bad revision missing from flux log")
    evj = json.loads((S.EVIDENCE_DIR / "kubectl/get-events-A.json").read_text())
    ev_pods = [i["involvedObject"]["name"] for i in evj["items"] if i["reason"] == "Evicted"]
    if ev_pods != [S.EVICTED_POD]:
        fail(f"evicted pods in events: {ev_pods}")
    restarts_total = sum(1 for p in world.bad_pods for run in p.runs if run.outcome in ("oom", "liveness"))
    if restarts_total == len(ooms):
        fail("restart total equals OOM count, trap would not work")
    readme = (S.EVIDENCE_DIR / "README_FIRST.txt").read_text()
    for k, v in answers.items():
        if v.lower() in readme.lower():
            fail(f"answer {k} leaks into README_FIRST.txt")
    total = sum(f.stat().st_size for f in S.EVIDENCE_DIR.rglob("*") if f.is_file())
    if total > 40 * 1024 * 1024:
        fail(f"evidence too large: {total}")

    truth = {"caseId": S.CASE_ID, "answers": answers}
    with open(S.TRUTH_DIR / f"{S.CASE_ID}.answers.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(truth, f, indent=2)
        f.write("\n")
    print(f"[{S.CASE_ID}] evidence -> {S.EVIDENCE_DIR} ({total // 1024} KiB); "
          f"OOM kills={len(ooms)}, liveness kills={len(lives)}, pods={len(world.bad_pods)}")


if __name__ == "__main__":
    main()
