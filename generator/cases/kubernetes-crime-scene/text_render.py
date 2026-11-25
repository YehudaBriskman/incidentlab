"""Journals, ingress, Flux, git, helm, app logs, metrics and chat for `kubernetes-crime-scene`."""
from __future__ import annotations

import difflib
import json
import math
import random
from datetime import datetime, timedelta

import story as S
from kube_render import SEARCH_PID, all_pricing
from story import LOCAL_TZ, UTC, Pod, World, sec


def klog_ts(t: datetime) -> str:
    t = t.astimezone(UTC)
    return t.strftime("%m%d %H:%M:%S.") + f"{t.microsecond:06d}"


def syslog_ts(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%b %d %H:%M:%S")


def memcg(uid: str, cid: str, qos: str = "burstable") -> str:
    return f"/kubepods.slice/kubepods-{qos}.slice/kubepods-{qos}-pod{uid.replace('-', '_')}.slice/cri-containerd-{cid}.scope"


# ================================================================ node journals
def journals(world: World) -> tuple[dict[str, str], int]:
    r = random.Random(S.SEED + 21)
    lines: dict[str, list[tuple[datetime, str]]] = {n: [] for n in S.NODES}
    oom_written = 0

    def kl(node, t, level, src, msg):
        pid = S.NODES[node]["pid"]
        lines[node].append((t, f"{syslog_ts(t)} {node} kubelet[{pid}]: {level}{klog_ts(t)}    {pid} {src}] {msg}"))

    def kern(node, t, msg):
        lines[node].append((t, f"{syslog_ts(t)} {node} kernel: {msg}"))

    def ctrd(node, t, msg):
        cpid = S.NODES[node]["cpid"]
        ts = t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond * 1000:09d}Z"
        lines[node].append((t, f'{syslog_ts(t)} {node} containerd[{cpid}]: time="{ts}" level=info msg="{msg}"'))

    def oom_block(node, t, task, pid, uid, cid, limit_kb, rss_kb, score, qos="burstable", uidn=10001):
        nonlocal oom_written
        mg = memcg(uid, cid, qos)
        kern(node, t, f"{task} invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj={score}")
        kern(node, t, f"memory: usage {limit_kb}kB, limit {limit_kb}kB, failcnt {r.randint(40, 2200)}")
        kern(node, t, f"swap: usage 0kB, limit 9007199254740988kB, failcnt 0")
        kern(node, t, f"oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=cri-containerd-{cid}.scope,"
                      f"mems_allowed=0,oom_memcg={mg},task_memcg={mg},task={task},pid={pid},uid={uidn}")
        kern(node, t + sec(0.002), f"Memory cgroup out of memory: Killed process {pid} ({task}) total-vm:{r.randint(4700000, 4990000) if task == 'java' else 812344}kB, "
                                   f"anon-rss:{rss_kb}kB, file-rss:{r.randint(12000, 26000)}kB, shmem-rss:0kB, UID:{uidn} "
                                   f"pgtables:{r.randint(1900, 2600)}kB oom_score_adj:{score}")
        oom_written += 1

    def pleg(node, t, ns, pod, uid, typ, cid):
        kl(node, t, "I", "kubelet.go:2477", f'"SyncLoop (PLEG): event for pod" pod="{ns}/{pod}" '
                                            f'event={{"ID":"{uid}","Type":"{typ}","Data":"{cid}"}}')

    # ------------------------------------------------ background noise
    for node in S.NODES:
        t = S.JOURNAL_START + sec(r.uniform(1, 30))
        while t < S.JOURNAL_END:
            k = r.random()
            if k < 0.30:
                kl(node, t, "I", "kubelet.go:2563", '"SyncLoop (probe)" probe="readiness" status="ready" pod="kube-system/'
                   + {S.N1: "coredns-5d78c9869d-8kxqz", S.N2: "coredns-5d78c9869d-mz4wt", S.N3: "metrics-server-6d94bc8694-r2wzs"}[node] + '"')
            elif k < 0.45:
                kl(node, t, "I", "container_gc.go:88", '"Attempting to delete unused containers"')
            elif k < 0.55:
                kl(node, t, "I", "image_gc_manager.go:383", f'"Disk usage on image filesystem is over the high threshold, trying to free bytes down to the low threshold" usage={r.randint(41, 58)} highThreshold=85 amountToFree=0 lowThreshold=80'
                   if False else f'"Image garbage collection succeeded"')
            elif k < 0.70:
                lines[node].append((t, f"{syslog_ts(t)} {node} systemd[1]: run-containerd-runc-k8s.io-{S.hexstr(64, r)}-runc.{''.join(r.choice('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789') for _ in range(6))}.mount: Deactivated successfully."))
            elif k < 0.80:
                lines[node].append((t, f"{syslog_ts(t)} {node} chronyd[812]: Selected source 10.20.0.2 (ntp.lumenmart.internal)"))
            elif k < 0.90:
                kl(node, t, "I", "kubelet_volumes.go:163", '"Cleaned up orphaned pod volumes dir" podUID="' + S.new_uid(r) + '" path="/var/lib/kubelet/pods/' + S.new_uid(r) + '/volumes"')
            else:
                ctrd(node, t, f'ImageUpdate event name:\\"registry.lumenmart.internal/platform/pause:3.10\\" labels:{{key:\\"io.cri-containerd.image\\" value:\\"managed\\"}}')
            t += sec(r.uniform(25, 95))
        for hh in range(3, 9):
            for mm in (0, 30):
                tt = S.utc(hh, mm, 0) + sec(r.uniform(0.1, 2))
                if S.JOURNAL_START < tt < S.JOURNAL_END:
                    lines[node].append((tt, f"{syslog_ts(tt)} {node} systemd[1]: Starting sysstat-collect.service - system activity accounting tool..."))
                    lines[node].append((tt + sec(0.3), f"{syslog_ts(tt + sec(0.3))} {node} systemd[1]: sysstat-collect.service: Deactivated successfully."))

    # ------------------------------------------------ red herrings
    fb_uid, fb_cid = "8c2d4e6f-1a3b-4c5d-9e7f-0a1b2c3d4e5f", S.hexstr(64, r)
    oom_block(S.N1, S.FLUENTBIT_OOM, "fluent-bit", 3471, fb_uid, fb_cid, 200 * 1024, 203812, 993, uidn=0)
    pleg(S.N1, S.FLUENTBIT_OOM + sec(0.61), "logging", S.FLUENTBIT_POD, fb_uid, "ContainerDied", fb_cid)
    nfb = S.hexstr(64, r)
    pleg(S.N1, S.FLUENTBIT_OOM + sec(1.9), "logging", S.FLUENTBIT_POD, fb_uid, "ContainerStarted", nfb)

    ci_uid = "5e1f7a2b-9c3d-4e8f-a1b2-c3d4e5f6a7b8"
    t = S.CI_RUNNER_EVICT
    kl(S.N3, t - sec(10.2), "W", "eviction_manager.go:369", '"Eviction manager: attempting to reclaim" resourceName="ephemeral-storage"')
    kl(S.N3, t - sec(10.1), "I", "eviction_manager.go:380", '"Eviction manager: must evict pod(s) to reclaim" resourceName="ephemeral-storage"')
    kl(S.N3, t - sec(10.0), "I", "eviction_manager.go:398", f'"Eviction manager: pods ranked for eviction" pods=["ci/{S.CI_RUNNER_POD}","search/{S.SEARCH_POD}","monitoring/prometheus-k8s-0","logging/fluent-bit-wv4hn"]')
    kl(S.N3, t, "I", "eviction_manager.go:627", f'"Eviction manager: pod is evicted successfully" pod="ci/{S.CI_RUNNER_POD}"')
    kl(S.N3, t + sec(0.1), "I", "eviction_manager.go:208", f'"Eviction manager: pods evicted, waiting for pod to be cleaned up" pods=["ci/{S.CI_RUNNER_POD}"]')
    kl(S.N3, t + sec(30.2), "I", "eviction_manager.go:441", '"Eviction manager: pods successfully cleaned up" pods=["ci/' + S.CI_RUNNER_POD + '"]')

    s_uid, s_cid = "3f0c9b2e-41d7-4a8e-b6c5-9e2a7d18f4c0", S.hexstr(64, r)
    oom_block(S.N3, S.SEARCH_OOM, "java", SEARCH_PID, s_uid, s_cid, 3 * 1024 * 1024, 3141877, 939)
    pleg(S.N3, S.SEARCH_OOM + sec(0.55), "search", S.SEARCH_POD, s_uid, "ContainerDied", s_cid)
    kl(S.N3, S.SEARCH_OOM + sec(1.2), "E", "pod_workers.go:1301",
       f'"Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"indexer\\" with CrashLoopBackOff: \\"back-off 10s restarting failed container=indexer pod={S.SEARCH_POD}_search({s_uid})\\"" pod="search/{S.SEARCH_POD}" podUID="{s_uid}"')
    pleg(S.N3, S.SEARCH_OOM + sec(11.6), "search", S.SEARCH_POD, s_uid, "ContainerStarted", S.hexstr(64, r))

    # ------------------------------------------------ the memory pressure on k2m9
    rec_uid = "b7e4c1d9-2f6a-4b3c-8d5e-1a9f0c7b2e46"
    t = S.MEM_PRESSURE_ON
    kl(S.N1, t, "I", "kubelet_node_status.go:724", f'"Recording event message for node" node="{S.N1}" event="NodeHasInsufficientMemory"')
    kl(S.N1, S.EVICTION - sec(0.4), "W", "eviction_manager.go:369", '"Eviction manager: attempting to reclaim" resourceName="memory"')
    kl(S.N1, S.EVICTION - sec(0.3), "I", "eviction_manager.go:380", '"Eviction manager: must evict pod(s) to reclaim" resourceName="memory"')
    ranked = [f"{S.EVICTED_NS}/{S.EVICTED_POD}", "logging/fluent-bit-7xk2d", "flux-system/source-controller-7c6d9b8f4-l4vmq"]
    ranked += [f"shop/{p.name}" for p in world.bad_pods if p.node == S.N1 and p.created <= t and (p.deleted is None or p.deleted > t)]
    ranked += ["shop/catalog-api-7f8b9c6d4-5mbkn", "shop/checkout-web-5b7d8f9c6-kd9wf", "kube-system/coredns-5d78c9869d-8kxqz"]
    kl(S.N1, S.EVICTION - sec(0.2), "I", "eviction_manager.go:398", '"Eviction manager: pods ranked for eviction" pods=[' + ",".join(f'"{x}"' for x in ranked) + "]")
    kl(S.N1, S.EVICTION, "I", "eviction_manager.go:627", f'"Eviction manager: pod is evicted successfully" pod="{S.EVICTED_NS}/{S.EVICTED_POD}"')
    kl(S.N1, S.EVICTION + sec(0.1), "I", "eviction_manager.go:208", f'"Eviction manager: pods evicted, waiting for pod to be cleaned up" pods=["{S.EVICTED_NS}/{S.EVICTED_POD}"]')
    pleg(S.N1, S.EVICTION + sec(0.9), S.EVICTED_NS, S.EVICTED_POD, rec_uid, "ContainerDied", S.hexstr(64, r))
    kl(S.N1, S.EVICTION + sec(4.2), "I", "eviction_manager.go:441", f'"Eviction manager: pods successfully cleaned up" pods=["{S.EVICTED_NS}/{S.EVICTED_POD}"]')
    kl(S.N1, S.MEM_PRESSURE_OFF, "I", "kubelet_node_status.go:724", f'"Recording event message for node" node="{S.N1}" event="NodeHasSufficientMemory"')

    # ------------------------------------------------ pricing-api pods
    for p in all_pricing(world):
        node = p.node
        if p.created >= S.JOURNAL_START:
            kl(node, p.created + sec(0.08), "I", "kubelet.go:2402", f'"SyncLoop ADD" source="api" pods=["shop/{p.name}"]')
        for i, run in enumerate(p.runs):
            ctrd(node, run.start - sec(0.25), f"CreateContainer within sandbox \\\"{S.hexstr(64, random.Random(p.uid))}\\\" for container &ContainerMetadata{{Name:pricing-api,Attempt:{i},}} returns container id \\\"{run.cid}\\\"")
            ctrd(node, run.start - sec(0.05), f"StartContainer for \\\"{run.cid}\\\" returns successfully")
            pleg(node, run.start + sec(0.35), "shop", p.name, p.uid, "ContainerStarted", run.cid)
            if p.rs_hash == S.BAD_HASH:
                for k in (30, 40, 50):
                    at = run.start + sec(k + 0.05)
                    if (run.ready is None or at < run.ready) and run.end and at < run.end:
                        kl(node, at, "I", "prober.go:107",
                           f'"Probe failed" probeType="Liveness" pod="shop/{p.name}" podUID="{p.uid}" containerName="pricing-api" '
                           f'probeResult="failure" output="Get \\"http://{p.ip}:8080/actuator/health/liveness\\": dial tcp {p.ip}:8080: connect: connection refused"')
            if run.ready and (run.end is None or run.ready < run.end):
                kl(node, run.ready + sec(0.02), "I", "kubelet.go:2563", f'"SyncLoop (probe)" probe="readiness" status="ready" pod="shop/{p.name}"')
            if run.outcome == "liveness":
                kt = run.start + sec(S.LIVENESS_KILL_AFTER + 0.3)
                kl(node, kt, "I", "kubelet.go:2556", f'"SyncLoop (probe)" probe="liveness" status="unhealthy" pod="shop/{p.name}"')
                kl(node, kt + sec(0.01), "I", "kuberuntime_manager.go:1056",
                   f'"Message for Container of pod" containerName="pricing-api" containerStatusID={{"Type":"containerd","ID":"{run.cid}"}} '
                   f'pod="shop/{p.name}" containerMessage="Container pricing-api failed liveness probe, will be restarted"')
                kl(node, kt + sec(0.02), "I", "kuberuntime_container.go:779",
                   f'"Killing container with a grace period" pod="shop/{p.name}" podUID="{p.uid}" containerName="pricing-api" '
                   f'containerID="containerd://{run.cid}" gracePeriod=30')
                ctrd(node, run.end - sec(0.1), f"received exit event container_id:\\\"{run.cid}\\\" id:\\\"{run.cid}\\\" pid:{run.pid} exit_status:143")
                pleg(node, run.end + sec(0.5), "shop", p.name, p.uid, "ContainerDied", run.cid)
            elif run.outcome == "oom":
                oom_block(node, run.end, "java", run.pid, p.uid, run.cid, S.NEW_LIMIT_KB, run.rss_kb, 968)
                ctrd(node, run.end + sec(0.04), f"received exit event container_id:\\\"{run.cid}\\\" id:\\\"{run.cid}\\\" pid:{run.pid} exit_status:137")
                pleg(node, run.end + sec(r.uniform(0.3, 0.9)), "shop", p.name, p.uid, "ContainerDied", run.cid)
            elif run.outcome == "deleted":
                ctrd(node, run.end - sec(0.1), f"received exit event container_id:\\\"{run.cid}\\\" id:\\\"{run.cid}\\\" pid:{run.pid} exit_status:143")
                pleg(node, run.end + sec(0.4), "shop", p.name, p.uid, "ContainerDied", run.cid)
            if run.outcome in ("oom", "liveness"):
                fails = i + 1
                nxt = p.runs[i + 1].start if i + 1 < len(p.runs) else (p.deleted or S.JOURNAL_END)
                bt = run.end + sec(r.uniform(0.6, 1.4))
                while bt < nxt - sec(0.5):
                    kl(node, bt, "E", "pod_workers.go:1301",
                       f'"Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"pricing-api\\" with CrashLoopBackOff: '
                       f'\\"back-off {int(S.backoff(fails))}s restarting failed container=pricing-api pod={p.name}_shop({p.uid})\\"" '
                       f'pod="shop/{p.name}" podUID="{p.uid}"')
                    bt += sec(r.uniform(9.5, 14.0))
        if p.deleted is not None and p.deleted >= S.JOURNAL_START:
            kl(node, p.deleted + sec(0.06), "I", "kubelet.go:2418", f'"SyncLoop DELETE" source="api" pods=["shop/{p.name}"]')
            kl(node, p.deleted + sec(0.09), "I", "kubelet.go:2412", f'"SyncLoop REMOVE" source="api" pods=["shop/{p.name}"]')

    # cordon is an API-side action; kubelet only logs the event
    kl(S.N1, S.CORDON, "I", "kubelet_node_status.go:724", f'"Recording event message for node" node="{S.N1}" event="NodeNotSchedulable"')
    kl(S.N1, S.UNCORDON, "I", "kubelet_node_status.go:724", f'"Recording event message for node" node="{S.N1}" event="NodeSchedulable"')

    out = {}
    for node, ls in lines.items():
        ls = [x for x in ls if S.JOURNAL_START <= x[0] <= S.JOURNAL_END]
        ls.sort(key=lambda x: x[0])
        out[node] = "".join(f"{s}\n" for _, s in ls)
    return out, oom_written


# ================================================================ ingress
UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Lumenmart-iOS/6.31.0 (iPhone15,3; iOS 18.1)",
    "Lumenmart-Android/6.30.2 (Pixel 8; Android 15)",
]


def ingress(world: World) -> str:
    r = random.Random(S.SEED + 31)
    out: list[tuple[datetime, str]] = []
    static_up = {
        "shop-cart-api-80": ["10.244.2.9:8080", "10.244.3.12:8080"],
        "shop-catalog-api-80": ["10.244.1.14:8080", "10.244.2.11:8080", "10.244.3.15:8080"],
        "shop-checkout-web-80": ["10.244.1.19:8080", "10.244.3.21:8080"],
    }
    clients = [f"198.51.100.{i}" for i in range(2, 250, 3)] + [f"203.0.113.{i}" for i in range(5, 250, 4)]
    t = S.WINDOW_START
    while t < S.WINDOW_END:
        t += sec(r.expovariate(2.6))
        k = r.random()
        if k < 0.38:
            sku = r.randint(10000, 99999)
            path = f"/api/v2/price/quote?sku=SKU-{sku}&qty={r.choice([1, 1, 1, 2, 3])}"
            meth, up = "GET", "shop-pricing-api-80"
        elif k < 0.45:
            path, meth, up = "/api/v2/price/bulk", "POST", "shop-pricing-api-80"
        elif k < 0.70:
            path, meth, up = f"/api/v1/catalog/items/{r.randint(1000, 9999)}", "GET", "shop-catalog-api-80"
        elif k < 0.88:
            path, meth, up = r.choice(["/api/v1/cart", "/api/v1/cart/items"]), r.choice(["GET", "GET", "POST"]), "shop-cart-api-80"
        else:
            path, meth, up = r.choice(["/", "/cart", "/checkout", "/c/kitchen", "/c/garden"]), "GET", "shop-checkout-web-80"
        ip = r.choice(clients)
        ua = r.choice(UAS)
        rid = S.hexstr(32, r)
        reqlen = r.randint(380, 720)
        if up == "shop-pricing-api-80":
            eps = S.endpoints_at(world, t)
            if not eps:
                line = (f'{ip} - - [{t.strftime("%d/%b/%Y:%H:%M:%S")} +0000] "{meth} {path} HTTP/1.1" 503 190 '
                        f'"https://shop.lumenmart.example/" "{ua}" {reqlen} 0.000 [{up}] [] - - - - {rid}')
            else:
                addr = f"{r.choice(eps).ip}:8080"
                rt = round(r.uniform(0.008, 0.060), 3)
                size = r.randint(240, 1900)
                line = (f'{ip} - - [{t.strftime("%d/%b/%Y:%H:%M:%S")} +0000] "{meth} {path} HTTP/1.1" 200 {size} '
                        f'"https://shop.lumenmart.example/" "{ua}" {reqlen} {rt:.3f} [{up}] [] {addr} {size} {rt - 0.001:.3f} 200 {rid}')
        else:
            addr = r.choice(static_up[up])
            status = 200 if r.random() > 0.004 else r.choice([404, 499])
            rt = round(r.uniform(0.004, 0.090), 3)
            size = r.randint(180, 14000)
            line = (f'{ip} - - [{t.strftime("%d/%b/%Y:%H:%M:%S")} +0000] "{meth} {path} HTTP/1.1" {status} {size} '
                    f'"https://shop.lumenmart.example/" "{ua}" {reqlen} {rt:.3f} [{up}] [] {addr} {size} {rt - 0.001:.3f} {status} {rid}')
        out.append((t, line))
    # controller warnings
    t = S.OUTAGE_START + sec(0.61)
    while t < S.OUTAGE_END:
        out.append((t, f'W{klog_ts(t)}       7 controller.go:1216] Service "shop/pricing-api" does not have any active Endpoint.'))
        t += sec(r.uniform(20, 75))
    for tt in (S.utc(7, 33, 11, 200), S.EVICTION + sec(3.1)):
        out.append((tt, f'I{klog_ts(tt)}       7 controller.go:214] "Configuration changes detected, backend reload required"'))
        out.append((tt + sec(0.4), f'I{klog_ts(tt + sec(0.4))}       7 controller.go:231] "Backend successfully reloaded"'))
    out.sort(key=lambda x: x[0])
    return "".join(f"{s}\n" for _, s in out)


# ================================================================ GitOps repo, Flux, helm
VALUES_V2 = """    image:
      repository: registry.lumenmart.internal/pricing/pricing-api
      tag: "4.12.3"
    priorityClassName: shop-critical
    service:
      enabled: false  # the Service is service.yaml (shared with the legacy ingress)
    extraPodLabels:
      app: pricing-api
      tier: backend
{annotations}    javaOpts: "-Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError"
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: "2"
        memory: 1536Mi
    probes:
      liveness:
        initialDelaySeconds: 120
        periodSeconds: 10
        failureThreshold: 3
      readiness:
        initialDelaySeconds: 20
        periodSeconds: 5
    autoscaling:
      enabled: true
      minReplicas: 4
      maxReplicas: 8
      targetCPUUtilizationPercentage: 70
"""

ANNOT = """    podAnnotations:
      prometheus.io/scrape: "true"
      prometheus.io/port: "8081"
"""

VALUES_V3 = """    image:
      repository: registry.lumenmart.internal/pricing/pricing-api
      tag: "4.12.3"
    priorityClassName: shop-critical
    service:
      enabled: false  # the Service is service.yaml (shared with the legacy ingress)
    # chart v3: standard app.kubernetes.io/* labels are added by the chart
    podLabels:
      tier: backend
    podAnnotations:
      prometheus.io/scrape: "true"
      prometheus.io/port: "8081"
    javaOpts: "-Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError"
    # resources as in the platform-charts v3 example values
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: "1"
        memory: 768Mi
    probes:
      liveness:
        initialDelaySeconds: 120
        periodSeconds: 10
        failureThreshold: 3
      readiness:
        initialDelaySeconds: 20
        periodSeconds: 5
    autoscaling:
      enabled: true
      minReplicas: 4
      maxReplicas: {maxr}
      targetCPUUtilizationPercentage: 70
"""

VALUES_V3_FIX = """    image:
      repository: registry.lumenmart.internal/pricing/pricing-api
      tag: "4.12.3"
    priorityClassName: shop-critical
    service:
      enabled: false  # the Service is service.yaml (shared with the legacy ingress)
    # chart v3: standard app.kubernetes.io/* labels are added by the chart.
    # service.yaml still selects on the legacy app label: keep it here.
    podLabels:
      app: pricing-api
      tier: backend
    podAnnotations:
      prometheus.io/scrape: "true"
      prometheus.io/port: "8081"
    javaOpts: "-Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError"
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: "2"
        memory: 1536Mi
    livenessProbe:
      initialDelaySeconds: 120
      periodSeconds: 10
      failureThreshold: 3
    readinessProbe:
      initialDelaySeconds: 20
      periodSeconds: 5
    autoscaling:
      enabled: true
      minReplicas: 4
      maxReplicas: 12
      targetCPUUtilizationPercentage: 70
"""


def helmrelease(version: str, values: str) -> str:
    return f"""apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: pricing-api
  namespace: shop
spec:
  interval: 10m
  chart:
    spec:
      chart: pricing-api
      version: "{version}"
      sourceRef:
        kind: HelmRepository
        name: platform-charts
        namespace: flux-system
  upgrade:
    timeout: 5m
  values:
{values}"""


SERVICE_YAML = """apiVersion: v1
kind: Service
metadata:
  name: pricing-api
  namespace: shop
  labels:
    app: pricing-api
spec:
  type: ClusterIP
  selector:
    app: pricing-api
    tier: backend
  ports:
    - name: http
      port: 80
      targetPort: http
"""

INV_OLD = """apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: inventory-api
  namespace: shop
spec:
  interval: 10m
  chart:
    spec:
      chart: inventory-api
      version: "3.2.0"
      sourceRef:
        kind: HelmRepository
        name: platform-charts
        namespace: flux-system
  values:
    image:
      repository: registry.lumenmart.internal/inventory/inventory-api
      tag: "{tag}"
    replicaCount: 2
    resources:
      requests:
        cpu: 200m
        memory: 384Mi
      limits:
        memory: 768Mi
"""

RECS_OLD = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: recs-feature-sync
  namespace: recommendations
spec:
  replicas: 1
  selector:
    matchLabels:
      app: recs-feature-sync
  template:
    metadata:
      labels:
        app: recs-feature-sync
    spec:
      containers:
        - name: feature-sync
          image: registry.lumenmart.internal/recs/feature-sync:1.19.0
          args: ["--batch-size={bs}", "--interval=30s"]
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
"""


def commits():
    """Oldest first. Each: (time_utc, author, subject, body, path, before, after)."""
    hr_v2_noann = helmrelease("2.7.4", VALUES_V2.format(annotations=""))
    hr_v2 = helmrelease("2.7.4", VALUES_V2.format(annotations=ANNOT))
    hr_v3 = helmrelease("3.0.1", VALUES_V3.format(maxr=8))
    hr_v3_12 = helmrelease("3.0.1", VALUES_V3.format(maxr=12))
    hr_fix = helmrelease("3.0.1", VALUES_V3_FIX)
    hr_v2_old = hr_v2_noann.replace('tag: "4.12.3"', 'tag: "4.12.1"')
    return [
        (datetime(2026, 11, 9, 11, 58, 40, tzinfo=UTC), "ronen.g", "pricing-api: bump image to 4.12.1", "",
         "apps/shop/pricing-api/helmrelease.yaml", hr_v2_old.replace('tag: "4.12.1"', 'tag: "4.12.0"'), hr_v2_old),
        (datetime(2026, 11, 12, 8, 12, 2, tzinfo=UTC), "ronen.g", "pricing-api: bump image to 4.12.3",
         "Fixes rounding on bulk quotes (PRICE-2231).", "apps/shop/pricing-api/helmrelease.yaml", hr_v2_old, hr_v2_noann),
        (datetime(2026, 11, 16, 14, 22, 31, tzinfo=UTC), "shira.k", "recommendations: raise feature-sync batch size to 5000",
         "Halves the sync time. Memory use goes up a bit, still well inside the node.",
         "apps/recommendations/feature-sync/deployment.yaml", RECS_OLD.format(bs=2000), RECS_OLD.format(bs=5000)),
        (S.utc(7, 19, 55), "ronen.g", "pricing-api: add prometheus scrape annotations", "",
         "apps/shop/pricing-api/helmrelease.yaml", hr_v2_noann, hr_v2),
        (S.utc(7, 31, 40), "tamar.l", "inventory-api: bump image to 2.8.1", "Adds the warehouse-B stock feed.",
         "apps/shop/inventory-api/helmrelease.yaml", INV_OLD.format(tag="2.8.0"), INV_OLD.format(tag="2.8.1")),
        (S.BAD_COMMIT_TIME, "ronen.g", "pricing-api: migrate values to chart v3 schema",
         "platform-charts 2.x is deprecated at the end of the month. Chart 3.x\nrenames extraPodLabels to podLabels and adds the standard\napp.kubernetes.io/* labels itself. Values copied from the v3 example\nvalues and adjusted for pricing. No functional change intended.",
         "apps/shop/pricing-api/helmrelease.yaml", hr_v2, hr_v3),
        (S.HPA_COMMIT_TIME, "noam.s", "pricing-api: raise HPA maxReplicas to 12",
         "INC-4127: pods keep dying, give the HPA more room.", "apps/shop/pricing-api/helmrelease.yaml", hr_v3, hr_v3_12),
        (S.FIX_COMMIT_TIME, "noam.s", "pricing-api: restore v2 resources, app label and probe delays",
         "INC-4127. Brings back the memory/cpu values from before the chart v3\nmigration, re-adds the app label that service.yaml selects on, and moves\nthe probe settings to the keys chart v3 actually reads.",
         "apps/shop/pricing-api/helmrelease.yaml", hr_v3_12, hr_fix),
    ]


AUTHORS = {"ronen.g": "Ronen Gold", "shira.k": "Shira Katz", "tamar.l": "Tamar Levi", "noam.s": "Noam Segal"}


def commit_shas() -> list[str]:
    shas = []
    parent = "0" * 40
    for c in commits():
        sha = S.fake_sha(f"{parent}|{c[0].isoformat()}|{c[1]}|{c[2]}|{c[6]}")
        shas.append(sha)
        parent = sha
    if len({s[:7] for s in shas}) != len(shas):
        raise SystemExit("short SHA collision in gitops history")
    return shas


def git_log_p() -> str:
    cs = commits()
    shas = commit_shas()
    out = []
    for i in range(len(cs) - 1, -1, -1):
        t, who, subj, body, path, before, after = cs[i]
        lt = t.astimezone(LOCAL_TZ)
        dec = " (HEAD -> main, origin/main)" if i == len(cs) - 1 else ""
        out.append(f"commit {shas[i]}{dec}\n")
        out.append(f"Author: {AUTHORS[who]} <{who}@lumenmart.example>\n")
        out.append(f"Date:   {lt.strftime('%a %b')} {lt.day} {lt.strftime('%H:%M:%S %Y')} +0200\n\n")
        out.append(f"    {subj}\n")
        if body:
            out.append("\n" + "".join(f"    {l}\n" for l in body.splitlines()))
        out.append("\n")
        a = S.fake_sha("blob" + before)[:7]
        b = S.fake_sha("blob" + after)[:7]
        out.append(f"diff --git a/{path} b/{path}\nindex {a}..{b} 100644\n")
        diff = list(difflib.unified_diff(before.splitlines(), after.splitlines(), f"a/{path}", f"b/{path}", n=3, lineterm=""))
        out.append("".join(l + "\n" for l in diff))
        out.append("\n")
    return "".join(out)


def helm_history() -> str:
    rows = [
        (11, datetime(2026, 11, 9, 12, 3, 22, tzinfo=UTC), "superseded", "pricing-api-2.7.4", "4.12.1", "Upgrade complete"),
        (12, S.REV12_TIME, "superseded", "pricing-api-2.7.4", "4.12.3", "Upgrade complete"),
        (13, S.REV13_TIME, "superseded", "pricing-api-2.7.4", "4.12.3", "Upgrade complete"),
        (14, S.REV14_TIME, "superseded", "pricing-api-3.0.1", "4.12.3", "Upgrade complete"),
        (15, S.REV15_TIME, "failed", "pricing-api-3.0.1", "4.12.3", 'Upgrade "pricing-api" failed: context deadline exceeded'),
        (16, S.REV16_TIME, "deployed", "pricing-api-3.0.1", "4.12.3", "Upgrade complete"),
    ]
    out = ["$ helm -n shop history pricing-api\n",
           "REVISION\tUPDATED                 \tSTATUS    \tCHART            \tAPP VERSION\tDESCRIPTION\n"]
    for rev, t, st, ch, av, desc in rows:
        lt = t.astimezone(LOCAL_TZ)
        upd = f"{lt.strftime('%a %b')} {lt.day:>2} {lt.strftime('%H:%M:%S %Y')}"
        out.append(f"{rev:<8}\t{upd}\t{st:<10}\t{ch:<17}\t{av:<11}\t{desc}\n")
    return "".join(out)


def helm_values(rev: int) -> str:
    """`helm get values` prints user-supplied values with sorted keys."""
    if rev == 13:
        return f"""$ helm -n shop get values pricing-api --revision 13
USER-SUPPLIED VALUES:
autoscaling:
  enabled: true
  maxReplicas: 8
  minReplicas: 4
  targetCPUUtilizationPercentage: 70
extraPodLabels:
  app: pricing-api
  tier: backend
image:
  repository: registry.lumenmart.internal/pricing/pricing-api
  tag: 4.12.3
javaOpts: -Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError
podAnnotations:
  prometheus.io/port: "8081"
  prometheus.io/scrape: "true"
priorityClassName: shop-critical
probes:
  liveness:
    failureThreshold: 3
    initialDelaySeconds: 120
    periodSeconds: 10
  readiness:
    initialDelaySeconds: 20
    periodSeconds: 5
resources:
  limits:
    cpu: "2"
    memory: {S.OLD_LIMIT}
  requests:
    cpu: 500m
    memory: 1Gi
service:
  enabled: false
"""
    return f"""$ helm -n shop get values pricing-api --revision 14
USER-SUPPLIED VALUES:
autoscaling:
  enabled: true
  maxReplicas: 8
  minReplicas: 4
  targetCPUUtilizationPercentage: 70
image:
  repository: registry.lumenmart.internal/pricing/pricing-api
  tag: 4.12.3
javaOpts: -Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError
podAnnotations:
  prometheus.io/port: "8081"
  prometheus.io/scrape: "true"
podLabels:
  tier: backend
priorityClassName: shop-critical
probes:
  liveness:
    failureThreshold: 3
    initialDelaySeconds: 120
    periodSeconds: 10
  readiness:
    initialDelaySeconds: 20
    periodSeconds: 5
resources:
  limits:
    cpu: "1"
    memory: {S.NEW_LIMIT}
  requests:
    cpu: 250m
    memory: {S.NEW_REQUEST}
service:
  enabled: false
"""


def flux_log() -> str:
    r = random.Random(S.SEED + 41)
    cs = commits()
    shas = commit_shas()
    out: list[tuple[datetime, dict]] = []

    def rid():
        return S.new_uid(r)

    def ts(t):
        return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"

    def add(t, d):
        out.append((t, d))

    def rev_at(t):
        cur = None
        for c, s in zip(cs, shas):
            if c[0] + sec(35) <= t:
                cur = s
        return cur

    start, end = S.utc(7, 0, 0), S.utc(8, 50, 0)
    # periodic no-op reconciles
    t = start + sec(14.2)
    while t < end:
        add(t, {"level": "info", "ts": ts(t), "msg": f"no changes since last reconcilation: observed revision 'main@sha1:{rev_at(t)}'",
                "controller": "gitrepository", "controllerGroup": "source.toolkit.fluxcd.io", "controllerKind": "GitRepository",
                "GitRepository": {"name": "platform-gitops", "namespace": "flux-system"}, "namespace": "flux-system",
                "name": "platform-gitops", "reconcileID": rid()})
        t += sec(60 + r.uniform(-0.5, 0.5))
    for ks, off in (("apps-shop", 21.3), ("apps-recommendations", 37.9), ("infra-logging", 49.1), ("infra-ingress", 52.6)):
        t = start + sec(off)
        while t < end:
            add(t, {"level": "info", "ts": ts(t), "msg": "server-side apply completed", "controller": "kustomization",
                    "controllerGroup": "kustomize.toolkit.fluxcd.io", "controllerKind": "Kustomization",
                    "Kustomization": {"name": ks, "namespace": "flux-system"}, "namespace": "flux-system", "name": ks,
                    "reconcileID": rid(), "output": {}, "revision": f"main@sha1:{rev_at(t)}"})
            t += sec(600 + r.uniform(-1, 1))
    # real changes
    for c, s in zip(cs, shas):
        if c[0] < start:
            continue
        ft = c[0] + sec(38 + r.uniform(0, 3))
        if c[0] == S.BAD_COMMIT_TIME:
            ft = S.BAD_SOURCE_FETCH
        if c[0] == S.FIX_COMMIT_TIME:
            ft = S.FIX_SOURCE_FETCH
        if c[0] == S.HPA_COMMIT_TIME:
            ft = S.HPA_COMMIT_TIME + sec(8.4)
        add(ft, {"level": "info", "ts": ts(ft), "msg": f"stored artifact for commit '{c[2]}'", "controller": "gitrepository",
                 "controllerGroup": "source.toolkit.fluxcd.io", "controllerKind": "GitRepository",
                 "GitRepository": {"name": "platform-gitops", "namespace": "flux-system"}, "namespace": "flux-system",
                 "name": "platform-gitops", "reconcileID": rid(), "revision": f"main@sha1:{s}"})
        ks = "apps-recommendations" if "recommendations" in c[4] else "apps-shop"
        obj = {"apps/shop/pricing-api/helmrelease.yaml": "HelmRelease/shop/pricing-api",
               "apps/shop/inventory-api/helmrelease.yaml": "HelmRelease/shop/inventory-api"}.get(c[4], "Deployment/recommendations/recs-feature-sync")
        at = ft + sec(8 + r.uniform(0, 1))
        if c[0] == S.BAD_COMMIT_TIME:
            at = S.BAD_KUSTOMIZE_APPLY
        if c[0] == S.FIX_COMMIT_TIME:
            at = S.FIX_KUSTOMIZE_APPLY
        add(at, {"level": "info", "ts": ts(at), "msg": "server-side apply completed", "controller": "kustomization",
                 "controllerGroup": "kustomize.toolkit.fluxcd.io", "controllerKind": "Kustomization",
                 "Kustomization": {"name": ks, "namespace": "flux-system"}, "namespace": "flux-system", "name": ks,
                 "reconcileID": rid(), "output": {obj: "configured"}, "revision": f"main@sha1:{s}"})
    # helm-controller
    def hc(t, name, ns, msg, level="info"):
        add(t, {"level": level, "ts": ts(t), "msg": msg, "controller": "helmrelease", "controllerGroup": "helm.toolkit.fluxcd.io",
                "controllerKind": "HelmRelease", "HelmRelease": {"name": name, "namespace": ns}, "namespace": ns, "name": name,
                "reconcileID": rid()})
    hc(S.utc(7, 21, 39, 512), "pricing-api", "shop", "release out-of-sync with desired state: release config values changed")
    hc(S.REV13_TIME + sec(0.2), "pricing-api", "shop", "running 'upgrade' action with timeout of 5m0s")
    hc(S.utc(7, 25, 31, 7), "pricing-api", "shop", "release in-sync with desired state")
    hc(S.utc(7, 33, 4, 640), "inventory-api", "shop", "release out-of-sync with desired state: release config values changed")
    hc(S.INVENTORY_SYNC + sec(0.2), "inventory-api", "shop", "running 'upgrade' action with timeout of 5m0s")
    hc(S.utc(7, 34, 41, 380), "inventory-api", "shop", "release in-sync with desired state")
    hc(S.REV14_TIME - sec(0.6), "pricing-api", "shop", "release out-of-sync with desired state: chart version changed from 2.7.4 to 3.0.1")
    hc(S.REV14_TIME + sec(0.2), "pricing-api", "shop", "running 'upgrade' action with timeout of 5m0s")
    hc(S.REV14_DONE, "pricing-api", "shop", "release in-sync with desired state")
    hc(S.REV15_TIME - sec(0.5), "pricing-api", "shop", "release out-of-sync with desired state: release config values changed")
    hc(S.REV15_TIME + sec(0.2), "pricing-api", "shop", "running 'upgrade' action with timeout of 5m0s")
    hc(S.REV15_TIME + sec(300.4), "pricing-api", "shop",
       "Helm upgrade failed for release shop/pricing-api with chart pricing-api@3.0.1: context deadline exceeded", "error")
    hc(S.REV16_TIME - sec(0.5), "pricing-api", "shop", "release out-of-sync with desired state: release config values changed")
    hc(S.REV16_TIME + sec(0.2), "pricing-api", "shop", "running 'upgrade' action with timeout of 5m0s")
    hc(S.REV16_DONE, "pricing-api", "shop", "release in-sync with desired state")
    out.sort(key=lambda x: x[0])
    return "".join(json.dumps(d, separators=(",", ":")) + "\n" for _, d in out)


# ================================================================ container logs
def spring(t: datetime, level: str, thread: str, logger: str, msg: str) -> str:
    ts = t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"
    return f"{ts} {level:>5} 1 --- [pricing-api] [{thread:>15}] {logger:<40} : {msg}\n"


def run_log(p: Pod, run, until: datetime, seed: int) -> str:
    r = random.Random(seed)
    st = run.start + sec(0.9)
    end = min(until, run.end) if run.end else until
    L = []

    def add(t, *a):
        if t < end:
            L.append(spring(t, *a))
    add(st, "INFO", "main", "c.l.pricing.PricingApiApplication",
        "Starting PricingApiApplication v4.12.3 using Java 21.0.5 with PID 1 (/app/pricing-api.jar started by app in /app)")
    add(st + sec(0.02), "INFO", "main", "c.l.pricing.PricingApiApplication", 'The following 1 profile is active: "prod"')
    add(st + sec(0.31), "INFO", "main", "c.l.pricing.config.RuntimeInfo",
        "runtime: availableProcessors=1 maxHeap=1024m cgroupMemoryLimitBytes=805306368")
    add(st + sec(2.8), "INFO", "main", "o.s.b.w.embedded.tomcat.TomcatWebServer", "Tomcat initialized with port 8080 (http)")
    add(st + sec(3.4), "INFO", "main", "c.l.pricing.catalog.CatalogCache", "warmup started: loading price book pb-2026-11-eu (1240511 SKUs)")
    warm = run.warmup
    for pct in (25, 50, 75):
        heap = 140 + pct * 6 + r.randint(-12, 12)
        add(st + sec(3.4 + (warm - 8) * pct / 100), "INFO", "catalog-loader", "c.l.pricing.catalog.CatalogCache",
            f"warmup progress {pct}% heapUsed={heap}m")
    if run.outcome == "liveness" or (run.outcome == "deleted" and run.ready is None):
        kill = run.end - sec(1.6)
        add(kill, "INFO", "ionShutdownHook", "o.s.b.w.embedded.tomcat.GracefulShutdown",
            "Commencing graceful shutdown. Waiting for active requests to complete")
        add(kill + sec(0.05), "WARN", "catalog-loader", "c.l.pricing.catalog.CatalogCache", "warmup aborted: shutdown requested")
        add(kill + sec(0.4), "INFO", "tomcat-shutdown", "o.s.b.w.embedded.tomcat.GracefulShutdown", "Graceful shutdown complete")
        return "".join(L)
    ready = run.ready
    add(ready - sec(1.9), "INFO", "catalog-loader", "c.l.pricing.catalog.CatalogCache",
        f"warmup complete in {warm - 6.1:.1f}s: 1240511 SKUs, heapUsed={600 + r.randint(0, 30)}m")
    add(ready - sec(1.2), "INFO", "main", "o.s.b.w.embedded.tomcat.TomcatWebServer", "Tomcat started on port 8080 (http) with context path '/'")
    add(ready - sec(1.1), "INFO", "main", "c.l.pricing.PricingApiApplication",
        f"Started PricingApiApplication in {warm - 1.2:.3f} seconds (process running for {warm - 0.6:.3f})")
    life = (run.end - ready).total_seconds() if run.end else 600
    delta_at = life - r.uniform(14, 22)
    add(ready + sec(0.3), "INFO", "scheduling-1", "c.l.pricing.catalog.CatalogCache", f"delta refresh scheduled in {int(delta_at)}s (jitter)")
    k = 60.0
    while k < delta_at:
        add(ready + sec(k), "INFO", "metrics-1", "c.l.pricing.metrics.TrafficReporter",
            f"quote requests last 60s: 0, heapUsed={640 + int(k / 8) + r.randint(-5, 5)}m")
        k += 60
    add(ready + sec(delta_at), "INFO", "scheduling-1", "c.l.pricing.catalog.CatalogCache",
        f"delta refresh started: {r.randint(15000, 21000)} changed SKUs, heapUsed={700 + r.randint(0, 20)}m")
    add(ready + sec(delta_at + 6.2), "INFO", "scheduling-1", "c.l.pricing.catalog.CatalogCache", "delta refresh: rebuilding price index (copy-on-write)")
    return "".join(L)


# ================================================================ metrics
def pod_mem_mi(p: Pod, t: datetime) -> float:
    if p.created > t or (p.deleted and p.deleted <= t):
        return 0.0
    for run in p.runs:
        if run.start <= t and (run.end is None or t < run.end):
            el = (t - run.start).total_seconds()
            if p.rs_hash != S.BAD_HASH:
                return min(1150.0, 200 + el * 18)
            if run.ready is None or t < run.ready:
                return 180 + min(el, run.warmup) / run.warmup * 520
            span = (run.end - run.ready).total_seconds() if run.end else 600
            return 700 + (t - run.ready).total_seconds() / span * 66
    return 0.0


def metrics(world: World) -> tuple[str, str]:
    r = random.Random(S.SEED + 51)
    # HPA
    replicas_at = []
    cur = 4
    sched = sorted(world.scale_events)
    hpa = ["ts_epoch,spec_replicas,desired_replicas,ready_pods,cpu_utilization_pct,pods_with_metrics\n"]
    t = S.WINDOW_START
    while t <= S.WINDOW_END:
        for st, frm, to in sched:
            if st <= t:
                cur = to
        if t < S.ROLLOUT_START:
            cur_r = 4
        elif t >= S.FIX_ROLLOUT:
            cur_r = 9
        else:
            cur_r = cur
        pods = [p for p in world.old_pods + world.bad_pods + world.fix_pods
                if p.created <= t and (p.deleted is None or p.deleted > t)]
        ready = [p for p in pods if any(run.ready and run.ready <= t and (run.end is None or run.end > t) for run in p.runs)]
        if not ready:
            util = ""
        else:
            vals = []
            for p in ready:
                if p.rs_hash == S.BAD_HASH:
                    vals.append(r.uniform(150, 260))
                else:
                    vals.append(r.uniform(38, 56))
            util = str(int(sum(vals) / len(vals)))
        desired = cur_r
        for st, frm, to in sched:
            if st - sec(15) < t < st:
                desired = to
        hpa.append(f"{int(t.timestamp())},{cur_r},{desired},{len(ready)},{util},{len(ready)}\n")
        t += sec(15)
    # node memory
    base = {S.N1: 2350, S.N2: 2600, S.N3: 2200}
    nm = ["ts_epoch,node,memory_working_set_mib,memory_available_mib,eviction_threshold_mib\n"]
    cap = 7936
    t = S.WINDOW_START
    while t <= S.WINDOW_END:
        for node in S.NODES:
            ws = base[node] + r.uniform(-40, 40)
            for p in all_pricing(world):
                if p.node == node:
                    ws += pod_mem_mi(p, t)
            if node == S.N1 and t < S.EVICTION:
                ws += 1600 + min(240, (t - S.WINDOW_START).total_seconds() / 20)
            if node == S.N2 and t >= S.EVICTION:
                ws += 1100
            if node == S.N3:
                ws += 2700 if not (S.SEARCH_OOM - sec(60) <= t < S.SEARCH_OOM) else 3050
                if S.SEARCH_OOM <= t < S.SEARCH_OOM + sec(40):
                    ws -= 2400
            pressure = node == S.N1 and S.MEM_PRESSURE_ON - sec(1) <= t < S.EVICTION + sec(1)
            ramp = node == S.N1 and S.HPA_UP_2 <= t < S.MEM_PRESSURE_ON - sec(1)
            if ramp:
                span = (S.MEM_PRESSURE_ON - S.HPA_UP_2).total_seconds()
                frac = (t - S.HPA_UP_2).total_seconds() / span
                ws = max(ws, cap - (2300 - 1750 * frac) - r.uniform(-25, 25))
            if pressure:
                ws = cap - r.uniform(405, 470)
            if node == S.N1 and S.EVICTION + sec(1) <= t < S.MEM_PRESSURE_OFF:
                ws = min(ws, cap - r.uniform(1300, 1700))
            if not pressure:
                ws = min(ws, cap - 560)
            nm.append(f"{int(t.timestamp())},{node},{int(ws)},{int(cap - ws)},{S.EVICTION_HARD_MI}\n")
        t += sec(15)
    return "".join(hpa), "".join(nm)


# ================================================================ chat
def chat(world: World) -> str:
    first_oom = S.oom_runs(world)[0][1].end
    msgs = [
        (S.ALERT_FIRED, "alertmanager", "[FIRING:1] PricingApi5xxRate shop/pricing-api: 100% of /api/v2/price requests failing (503) for 2m. Runbook: https://runbooks.lumenmart.example/pricing-api"),
        (S.utc(7, 58, 30), "noam.s", "ack, on it. ingress says 503, no upstream for pricing"),
        (S.utc(7, 59, 52), "noam.s", "pricing pods are restarting, saw OOMKilled on one of them. Did anyone ship pricing today?"),
        (S.utc(8, 0, 40), "ronen.g", "only some housekeeping in the gitops repo this morning, the image is the same 4.12.3 we've run since Thursday"),
        (S.utc(8, 1, 15), "tamar.l", "inventory-api 2.8.1 went out at 09:33, but inventory doesn't call pricing. Pretty sure it's not us"),
        (S.utc(8, 2, 3), "avi.p", "k2m9 already had an OOM kill at 05:12 this morning (fluent-bit). That node has been weird all week. I'd cordon it"),
        (S.utc(8, 3, 40), "noam.s", "HPA just went 4 -> 8. cpu shows ~200% of request?? the pods aren't even getting traffic"),
        (S.utc(8, 5, 10), "dalia.m", "status page updated: prices not loading in app and web. ETA?"),
        (S.utc(8, 6, 30), "avi.p", "svc pricing-api has no endpoints at all. Even pods that are Running 1/1. readiness gate stuck?"),
        (S.utc(8, 7, 2), "noam.s", "readiness is passing on the ones that are up, I checked the probe. endpoints still empty. weird"),
        (S.utc(8, 8, 15), "ronen.g", "could be a memory leak in the catalog cache. 4.12.3 added the bulk quote path. But it was fine for 5 days..."),
        (S.utc(8, 9, 50), "noam.s", "pushing maxReplicas 8 -> 12 so the HPA has room while we dig"),
        (S.utc(8, 12, 30), "shira.k", "our feature-sync pod just got evicted on k2m9. who is eating all the memory on that node?"),
        (S.utc(8, 13, 20), "avi.p", "told you, k2m9. cordoning it now"),
        (S.utc(8, 15, 5), "noam.s", "flux says the helm upgrade for my HPA change FAILED (context deadline exceeded). so is that the problem? helm is broken?"),
        (S.utc(8, 16, 40), "avi.p", "helm --wait timed out because the deployment never became available. that's a symptom, not a cause"),
        (S.utc(8, 18, 2), "noam.s", "HPA now going 12 -> 7. it can't make up its mind. metrics-server broken?"),
        (S.utc(8, 19, 30), "tamar.l", "metrics-server is fine, inventory HPA reads metrics normally"),
        (S.utc(8, 21, 0), "shira.k", "fwiw search-indexer also got OOMKilled on w3zx a minute ago. cluster-wide memory issue?"),
        (S.utc(8, 22, 10), "avi.p", "search-indexer does that every couple of weeks on reindex, ignore"),
        (S.utc(8, 25, 45), "dalia.m", "what changed between yesterday and today? not 'what is broken', what CHANGED"),
        (S.utc(8, 28, 12), "noam.s", "helm history shows 3 revisions today. rev 13 was annotations, rev 15 is mine. looking at 14"),
        (S.utc(8, 31, 40), "ronen.g", "14 is my chart v3 migration. it was supposed to be values-only, no functional change"),
        (S.utc(8, 33, 5), "noam.s", "diffing helm get values 13 vs 14 now"),
        (S.utc(8, 35, 0), "avi.p", "uncordoning k2m9, the node itself looks healthy"),
        (S.utc(8, 36, 50), "noam.s", "ok I see at least two things in that diff. writing a fix commit that restores the old values"),
        (S.utc(8, 40, 20), "noam.s", "fix pushed, flux picking it up"),
        (S.utc(8, 42, 30), "noam.s", "endpoints are back. 200s on /api/v2/price. watching"),
        (S.utc(8, 46, 0), "dalia.m", "thanks all. RCA please, including why it looked like 5 different problems"),
    ]
    assert first_oom < S.utc(7, 59, 52)
    out = ["# #inc-4127-pricing-api  (export, times are Asia/Jerusalem local time, UTC+02:00)\n\n"]
    for t, who, text in msgs:
        out.append(f"[{t.astimezone(LOCAL_TZ).strftime('%Y-%m-%d %H:%M:%S')}] <{who}> {text}\n")
    return "".join(out)
