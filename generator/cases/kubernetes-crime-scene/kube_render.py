"""kubectl-style renderers (events, get pods, describe ...) for `kubernetes-crime-scene`."""
from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta

import story as S
from story import LOCAL_TZ, UTC, Pod, World, sec


# ---------------------------------------------------------------- formatting helpers
def human(d: timedelta) -> str:
    """k8s.io/apimachinery/pkg/util/duration.HumanDuration"""
    seconds = int(d.total_seconds())
    if seconds < -1:
        return "<invalid>"
    if seconds < 0:
        return "0s"
    if seconds < 120:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 10:
        s = seconds % 60
        return f"{minutes}m" if s == 0 else f"{minutes}m{s}s"
    if minutes < 180:
        return f"{minutes}m"
    hours = seconds // 3600
    if hours < 8:
        m = minutes % 60
        return f"{hours}h" if m == 0 else f"{hours}h{m}m"
    if hours < 48:
        return f"{hours}h"
    if hours < 24 * 8:
        h = hours % 24
        return f"{hours // 24}d" if h == 0 else f"{hours // 24}d{h}h"
    return f"{hours // 24}d"


def table(header: list[str], rows: list[list[str]]) -> str:
    widths = [len(h) for h in header]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(c))
    out = []
    for r in [header] + rows:
        cells = [c.ljust(widths[i]) if i < len(r) - 1 else c for i, c in enumerate(r)]
        out.append("   ".join(cells).rstrip())
    return "\n".join(out) + "\n"


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def rfc_local(t: datetime) -> str:
    return t.astimezone(LOCAL_TZ).strftime("%a, %d %b %Y %H:%M:%S +0200")


def prompt_block(t: datetime, cmd: str) -> str:
    return f"$ date -u\n{t.astimezone(UTC).strftime('%a %b %d %H:%M:%S UTC %Y')}\n$ {cmd}\n"


# ---------------------------------------------------------------- event store
@dataclass
class Occ:
    t: datetime
    ns: str
    kind: str
    name: str
    uid: str
    fieldpath: str
    reason: str
    message: str
    etype: str
    component: str
    host: str
    api: str


class EventStore:
    def __init__(self) -> None:
        self.occ: list[Occ] = []

    def add(self, t, ns, kind, name, uid, reason, message, etype="Normal", component="kubelet",
            host="", fieldpath="", api="v1"):
        self.occ.append(Occ(t, ns, kind, name, uid, fieldpath, reason, message, etype, component, host, api))

    def aggregate(self, as_of: datetime, ttl: timedelta | None = S.EVENT_TTL) -> list[dict]:
        groups: dict[tuple, dict] = {}
        for o in sorted(self.occ, key=lambda o: o.t):
            if o.t > as_of:
                continue
            key = (o.ns, o.kind, o.name, o.fieldpath, o.reason, o.message, o.etype, o.component, o.host)
            g = groups.get(key)
            if g is None:
                groups[key] = {"o": o, "first": o.t, "last": o.t, "count": 1}
            else:
                g["last"] = o.t
                g["count"] += 1
        out = []
        used = set()
        for g in groups.values():
            if ttl is not None and g["last"] < as_of - ttl:
                continue
            o = g["o"]
            ns_epoch = int(g["first"].timestamp() * 1e9)
            name = f"{o.name}.{ns_epoch:x}"
            while name in used:
                ns_epoch += 1
                name = f"{o.name}.{ns_epoch:x}"
            used.add(name)
            g["evname"] = name
            out.append(g)
        return out


# ---------------------------------------------------------------- pod status
def pod_status(p: Pod, t: datetime):
    """Return (ready, status, restarts_str) or None if the pod does not exist at t."""
    if p.created > t:
        return None
    last_end = p.runs[-1].end if p.runs else None
    if p.deleted is not None and p.deleted <= t:
        if last_end is not None and t < last_end:
            run = p.runs[-1]
            ready = "1/1" if run.ready and run.ready <= p.deleted else "0/1"
            return ready, "Terminating", restarts(p, t)
        return None
    run_now = None
    prev_death = None
    for run in p.runs:
        if run.start <= t and (run.end is None or t < run.end):
            run_now = run
        if run.end is not None and run.end <= t and run.outcome in ("oom", "liveness"):
            prev_death = run
    if not p.runs or t < p.runs[0].start:
        return "0/1", "ContainerCreating", "0"
    if run_now is not None:
        return ("1/1" if run_now.ready and run_now.ready <= t else "0/1"), "Running", restarts(p, t)
    assert prev_death is not None
    if (t - prev_death.end).total_seconds() < 5:
        st = "OOMKilled" if prev_death.outcome == "oom" else "Error"
    else:
        st = "CrashLoopBackOff"
    return "0/1", st, restarts(p, t)


def restarts(p: Pod, t: datetime) -> str:
    deaths = [r for r in p.runs if r.end is not None and r.end <= t and r.outcome in ("oom", "liveness")]
    if not deaths:
        return "0"
    return f"{len(deaths)} ({human(t - deaths[-1].end)} ago)"


# ---------------------------------------------------------------- static background pods
STATIC_SHOP = [
    ("cart-api-6c9d7f5b8-gq4zt", S.N2, "10.244.2.9", datetime(2026, 11, 10, 9, 2, 11, tzinfo=UTC)),
    ("cart-api-6c9d7f5b8-rw2xh", S.N3, "10.244.3.12", datetime(2026, 11, 10, 9, 2, 58, tzinfo=UTC)),
    ("catalog-api-7f8b9c6d4-5mbkn", S.N1, "10.244.1.14", datetime(2026, 11, 13, 13, 40, 2, tzinfo=UTC)),
    ("catalog-api-7f8b9c6d4-jx8vr", S.N2, "10.244.2.11", datetime(2026, 11, 13, 13, 40, 49, tzinfo=UTC)),
    ("catalog-api-7f8b9c6d4-t2plq", S.N3, "10.244.3.15", datetime(2026, 11, 13, 13, 41, 37, tzinfo=UTC)),
    ("checkout-web-5b7d8f9c6-kd9wf", S.N1, "10.244.1.19", datetime(2026, 11, 11, 16, 5, 30, tzinfo=UTC)),
    ("checkout-web-5b7d8f9c6-v4hsm", S.N3, "10.244.3.21", datetime(2026, 11, 11, 16, 6, 12, tzinfo=UTC)),
    ("inventory-api-84c6d9f7b-cw7nl", S.N2, "10.244.2.15", datetime(2026, 11, 17, 7, 33, 9, tzinfo=UTC)),
    ("inventory-api-84c6d9f7b-zf5qd", S.N3, "10.244.3.38", datetime(2026, 11, 17, 7, 33, 58, tzinfo=UTC)),
]

STATIC_OTHER = [
    # ns, name, node, ip, created, status, restarts-at (list of (time)), ready
    ("ci", S.CI_RUNNER_POD, S.N3, "<none>", datetime(2026, 11, 16, 22, 4, 40, tzinfo=UTC), "Evicted", "0/1"),
    ("ci", "ci-runner-7d4b9f8c5-gn6qd", S.N2, "10.244.2.7", datetime(2026, 11, 17, 5, 31, 9, tzinfo=UTC), "Running", "1/1"),
    ("flux-system", "helm-controller-5f9c8d7b6-p2xnk", S.N2, "10.244.2.4", datetime(2026, 10, 2, 11, 0, 3, tzinfo=UTC), "Running", "1/1"),
    ("flux-system", "kustomize-controller-6b8d7c9f5-w8rzt", S.N3, "10.244.3.5", datetime(2026, 10, 2, 11, 0, 3, tzinfo=UTC), "Running", "1/1"),
    ("flux-system", "source-controller-7c6d9b8f4-l4vmq", S.N1, "10.244.1.6", datetime(2026, 10, 2, 11, 0, 4, tzinfo=UTC), "Running", "1/1"),
    ("ingress-nginx", "ingress-nginx-controller-8f6d7c9b5-bk2hs", S.N2, "10.244.2.5", datetime(2026, 11, 4, 10, 12, 0, tzinfo=UTC), "Running", "1/1"),
    ("ingress-nginx", "ingress-nginx-controller-8f6d7c9b5-tn7wd", S.N3, "10.244.3.6", datetime(2026, 11, 4, 10, 12, 41, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "coredns-5d78c9869d-8kxqz", S.N1, "10.244.1.2", datetime(2026, 9, 14, 8, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "coredns-5d78c9869d-mz4wt", S.N2, "10.244.2.2", datetime(2026, 9, 14, 8, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "kube-proxy-6tq2d", S.N1, "10.20.0.11", datetime(2026, 9, 14, 8, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "kube-proxy-h8jfk", S.N2, "10.20.0.12", datetime(2026, 9, 14, 8, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "kube-proxy-x5lnb", S.N3, "10.20.0.13", datetime(2026, 9, 14, 8, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("kube-system", "metrics-server-6d94bc8694-r2wzs", S.N3, "10.244.3.3", datetime(2026, 9, 14, 8, 1, 0, tzinfo=UTC), "Running", "1/1"),
    ("logging", S.FLUENTBIT_POD, S.N1, "10.244.1.3", datetime(2026, 11, 2, 7, 30, 0, tzinfo=UTC), "Running", "1/1"),
    ("logging", "fluent-bit-m9qzs", S.N2, "10.244.2.3", datetime(2026, 11, 2, 7, 30, 0, tzinfo=UTC), "Running", "1/1"),
    ("logging", "fluent-bit-wv4hn", S.N3, "10.244.3.4", datetime(2026, 11, 2, 7, 30, 0, tzinfo=UTC), "Running", "1/1"),
    ("monitoring", "kube-state-metrics-7b9f6c8d5-ql2xv", S.N2, "10.244.2.6", datetime(2026, 10, 20, 9, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("monitoring", "prometheus-k8s-0", S.N3, "10.244.3.8", datetime(2026, 10, 20, 9, 0, 0, tzinfo=UTC), "Running", "1/1"),
    ("recommendations", "recs-api-8c5f7d6b9-dx4kp", S.N2, "10.244.2.13", datetime(2026, 11, 16, 14, 30, 0, tzinfo=UTC), "Running", "1/1"),
    ("recommendations", "recs-api-8c5f7d6b9-sh8wm", S.N3, "10.244.3.17", datetime(2026, 11, 16, 14, 30, 40, tzinfo=UTC), "Running", "1/1"),
    ("recommendations", S.EVICTED_POD, S.N1, "<none>", datetime(2026, 11, 16, 14, 27, 12, tzinfo=UTC), "Evicted", "0/1"),
    ("recommendations", S.EVICTED_REPLACEMENT, S.N2, "10.244.2.41", S.EVICTION + sec(0.4), "Running", "1/1"),
    ("search", S.SEARCH_POD, S.N3, "10.244.3.9", datetime(2026, 11, 12, 18, 3, 0, tzinfo=UTC), "Running", "1/1"),
]


def static_other_row(item, t: datetime):
    ns, name, node, ip, created, status, ready = item
    if created > t:
        return None
    rs = "0"
    if name == S.EVICTED_POD:
        if t < S.EVICTION:
            status, ready, ip = "Running", "1/1", "10.244.1.27"
        elif t < S.EVICTION + sec(2):
            status = "Running"
    if name == S.CI_RUNNER_POD and t < S.CI_RUNNER_EVICT:
        status, ready, ip = "Running", "1/1", "10.244.3.29"
    if name == S.FLUENTBIT_POD and t > S.FLUENTBIT_OOM:
        rs = f"1 ({human(t - S.FLUENTBIT_OOM)} ago)"
    if name == S.SEARCH_POD and t > S.SEARCH_OOM:
        rs = f"1 ({human(t - S.SEARCH_OOM)} ago)"
        if t < S.SEARCH_OOM + sec(11):
            status, ready = "CrashLoopBackOff", "0/1"
        elif t < S.SEARCH_OOM + sec(95):
            ready = "0/1"
    return [ns, name, ready, status, rs, human(t - created), ip, node, "<none>", "<none>"]


def all_pricing(world: World) -> list[Pod]:
    return world.old_pods + world.bad_pods + world.fix_pods


def shop_rows(world: World, t: datetime, wide=True, labels=False) -> list[list[str]]:
    rows = []
    for name, node, ip, created in STATIC_SHOP:
        if created > t:
            continue
        rows.append([name, "1/1", "Running", "0", human(t - created), ip, node, "<none>", "<none>"])
    for p in all_pricing(world):
        st = pod_status(p, t)
        if st is None:
            continue
        ip = p.ip if st[1] != "ContainerCreating" else "<none>"
        rows.append([p.name, st[0], st[1], st[2], human(t - p.created), ip, p.node, "<none>", "<none>"])
    # labels for static shop pods are irrelevant to the case; keep them realistic though
    rows.sort(key=lambda r: r[0])
    return rows


def label_str(p: Pod) -> str:
    pairs = list(p.labels) + [("pod-template-hash", p.rs_hash)]
    pairs.sort()
    return ",".join(f"{k}={v}" for k, v in pairs)


STATIC_SHOP_LABELS = {
    "cart-api": "app=cart-api,pod-template-hash=6c9d7f5b8,tier=backend",
    "catalog-api": "app=catalog-api,pod-template-hash=7f8b9c6d4,tier=backend",
    "checkout-web": "app=checkout-web,pod-template-hash=5b7d8f9c6,tier=frontend",
    "inventory-api": "app.kubernetes.io/instance=inventory-api,app.kubernetes.io/name=inventory-api,pod-template-hash=84c6d9f7b,tier=backend",
}


# ---------------------------------------------------------------- file builders
POD_HEADER = ["NAME", "READY", "STATUS", "RESTARTS", "AGE", "IP", "NODE", "NOMINATED NODE", "READINESS GATES"]

SNAPSHOTS = [S.utc(7, 50, 2), S.utc(7, 57, 10), S.utc(8, 5, 41), S.utc(8, 12, 20),
             S.utc(8, 26, 3), S.utc(8, 38, 47), S.utc(8, 45, 30)]


def get_pods_snapshots(world: World) -> str:
    out = []
    for t in SNAPSHOTS:
        out.append(prompt_block(t, "kubectl -n shop get pods -o wide"))
        out.append(table(POD_HEADER, shop_rows(world, t)))
        out.append("\n")
    return "".join(out)


def get_pods_all(world: World, t: datetime) -> str:
    rows = []
    for r in shop_rows(world, t):
        rows.append(["shop"] + r)
    for item in STATIC_OTHER:
        r = static_other_row(item, t)
        if r:
            rows.append(r)
    rows.sort(key=lambda r: (r[0], r[1]))
    return prompt_block(t, "kubectl get pods -A -o wide") + table(["NAMESPACE"] + POD_HEADER, rows)


def get_pods_labels(world: World, t: datetime) -> str:
    rows = []
    for name, node, ip, created in STATIC_SHOP:
        if created > t:
            continue
        app = name.rsplit("-", 2)[0]
        rows.append([name, "1/1", "Running", "0", human(t - created), STATIC_SHOP_LABELS[app]])
    for p in all_pricing(world):
        st = pod_status(p, t)
        if st is None:
            continue
        rows.append([p.name, st[0], st[1], st[2], human(t - p.created), label_str(p)])
    rows.sort(key=lambda r: r[0])
    out = prompt_block(t, "kubectl -n shop get pods --show-labels")
    out += table(["NAME", "READY", "STATUS", "RESTARTS", "AGE", "LABELS"], rows)
    out += "\n$ kubectl -n shop get deploy pricing-api -o jsonpath='{.spec.selector.matchLabels}'; echo\n"
    out += '{"app.kubernetes.io/instance":"pricing-api","app.kubernetes.io/name":"pricing-api"}\n'
    return out


def endpoints_file(world: World) -> str:
    out = []
    created = datetime(2026, 4, 17, 10, 4, 0, tzinfo=UTC)
    for t in [S.utc(7, 50, 9), S.utc(8, 6, 2), S.utc(8, 45, 40)]:
        eps = S.endpoints_at(world, t)
        addrs = sorted(f"{p.ip}:8080" for p in eps)
        if not addrs:
            ep = "<none>"
        elif len(addrs) > 3:
            ep = ",".join(addrs[:3]) + f" + {len(addrs) - 3} more..."
        else:
            ep = ",".join(addrs)
        out.append(prompt_block(t, "kubectl -n shop get endpoints pricing-api"))
        out.append(table(["NAME", "ENDPOINTS", "AGE"], [["pricing-api", ep, human(t - created)]]))
        out.append("$ kubectl -n shop get endpointslices -l kubernetes.io/service-name=pricing-api\n")
        out.append(table(["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"],
                         [["pricing-api-v7c2k", "IPv4", "8080" if addrs else "<unset>",
                           (",".join(a.split(":")[0] for a in addrs[:3]) + (f" + {len(addrs) - 3} more..." if len(addrs) > 3 else "")) if addrs else "<unset>",
                           human(t - created)]]))
        out.append("\n")
    return "".join(out)


def describe_svc(world: World) -> str:
    t = S.utc(8, 6, 15)
    sel = ",".join(f"{k}={v}" for k, v in S.SERVICE_SELECTOR)
    return prompt_block(t, "kubectl -n shop describe svc pricing-api") + f"""Name:                     pricing-api
Namespace:                shop
Labels:                   app=pricing-api
                          kustomize.toolkit.fluxcd.io/name=apps-shop
                          kustomize.toolkit.fluxcd.io/namespace=flux-system
Annotations:              <none>
Selector:                 {sel}
Type:                     ClusterIP
IP Family Policy:         SingleStack
IP Families:              IPv4
IP:                       10.96.142.17
IPs:                      10.96.142.17
Port:                     http  80/TCP
TargetPort:               http/TCP
Endpoints:
Session Affinity:         None
Internal Traffic Policy:  Cluster
Events:                   <none>

$ kubectl -n shop get svc -o wide
NAME            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)   AGE    SELECTOR
cart-api        ClusterIP   10.96.88.140    <none>        80/TCP    214d   app=cart-api,tier=backend
catalog-api     ClusterIP   10.96.31.205    <none>        80/TCP    214d   app=catalog-api,tier=backend
checkout-web    ClusterIP   10.96.200.9     <none>        80/TCP    214d   app=checkout-web,tier=frontend
inventory-api   ClusterIP   10.96.57.66     <none>        80/TCP    61d    app.kubernetes.io/instance=inventory-api,app.kubernetes.io/name=inventory-api
pricing-api     ClusterIP   10.96.142.17    <none>        80/TCP    214d   {sel}
"""


def _event_rows_for(store: EventStore, as_of: datetime, pred) -> list[list[str]]:
    rows = []
    for g in sorted(store.aggregate(as_of), key=lambda g: g["first"]):
        o = g["o"]
        if not pred(o):
            continue
        frm = o.component if not o.host or o.component != "kubelet" else "kubelet"
        if g["count"] > 1:
            age = f"{human(as_of - g['last'])} (x{g['count']} over {human(as_of - g['first'])})"
        else:
            age = human(as_of - g["last"])
        rows.append([o.etype, o.reason, age, frm, o.message])
    return rows


def _events_block(rows: list[list[str]]) -> str:
    if not rows:
        return "Events:                      <none>\n"
    body = table(["Type", "Reason", "Age", "From", "Message"],
                 [["----", "------", "----", "----", "-------"]] + rows)
    return "Events:\n" + "".join("  " + line + "\n" for line in body.splitlines())


def describe_pod(world: World, store: EventStore, p: Pod, t: datetime) -> str:
    cur = None
    last_dead = None
    for run in p.runs:
        if run.start <= t and (run.end is None or t < run.end):
            cur = run
        if run.end is not None and run.end <= t and run.outcome in ("oom", "liveness"):
            last_dead = run
    rc = sum(1 for r in p.runs if r.end and r.end <= t and r.outcome in ("oom", "liveness"))
    if cur is not None:
        state = f"""    State:          Running
      Started:      {rfc_local(cur.start)}"""
        cid = cur.cid
        ready = "True" if cur.ready and cur.ready <= t else "False"
    else:
        state = """    State:          Waiting
      Reason:       CrashLoopBackOff"""
        cid = last_dead.cid
        ready = "False"
    if last_dead is not None:
        reason, code = ("OOMKilled", 137) if last_dead.outcome == "oom" else ("Error", 143)
        last = f"""    Last State:     Terminated
      Reason:       {reason}
      Exit Code:    {code}
      Started:      {rfc_local(last_dead.start)}
      Finished:     {rfc_local(last_dead.end)}"""
    else:
        last = ""
    labels = [f"{k}={v}" for k, v in sorted(p.labels + [("pod-template-hash", p.rs_hash)])]
    lab = "\n".join(("Labels:               " if i == 0 else "                      ") + l for i, l in enumerate(labels))
    rows = _event_rows_for(store, t, lambda o: o.kind == "Pod" and o.name == p.name)
    pod_ready = ready
    return prompt_block(t, f"kubectl -n shop describe pod {p.name}") + f"""Name:                 {p.name}
Namespace:            shop
Priority:             1000000
Priority Class Name:  shop-critical
Service Account:      pricing-api
Node:                 {p.node}/{S.NODES[p.node]['ip']}
Start Time:           {rfc_local(p.created)}
{lab}
Annotations:          prometheus.io/port: 8081
                      prometheus.io/scrape: true
Status:               Running
IP:                   {p.ip}
IPs:
  IP:           {p.ip}
Controlled By:  ReplicaSet/pricing-api-{p.rs_hash}
Containers:
  pricing-api:
    Container ID:   containerd://{cid}
    Image:          {S.IMAGE}
    Image ID:       registry.lumenmart.internal/pricing/pricing-api@sha256:4be1d0c9a7f35e2b8c61d94f0a3e7b25c8d1f6094ae3b7c2d5f8e01a9b6c4d37
    Ports:          8080/TCP, 8081/TCP
    Host Ports:     0/TCP, 0/TCP
{state}
{last}
    Ready:          {ready}
    Restart Count:  {rc}
    Limits:
      cpu:     1
      memory:  {S.NEW_LIMIT}
    Requests:
      cpu:      250m
      memory:   {S.NEW_REQUEST}
    Liveness:   http-get http://:http/actuator/health/liveness delay={S.LIVENESS_DELAY}s timeout=1s period={S.LIVENESS_PERIOD}s #success=1 #failure={S.LIVENESS_FAIL}
    Readiness:  http-get http://:http/actuator/health/readiness delay=10s timeout=1s period=5s #success=1 #failure=3
    Environment:
      JAVA_TOOL_OPTIONS:       -Xms512m -Xmx1g -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError
      SPRING_PROFILES_ACTIVE:  prod
      PRICEBOOK_ID:            pb-2026-11-eu
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-{p.short[:3]}q7 (ro)
Conditions:
  Type                        Status
  PodReadyToStartContainers   True
  Initialized                 True
  Ready                       {pod_ready}
  ContainersReady             {pod_ready}
  PodScheduled                True
Volumes:
  kube-api-access-{p.short[:3]}q7:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   Burstable
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
""" + _events_block(rows)


def _node_pods(world: World, node: str, t: datetime):
    rows = []
    for p in all_pricing(world):
        st = pod_status(p, t)
        if st is None or p.node != node:
            continue
        if p.rs_hash == S.BAD_HASH:
            rows.append(("shop", p.name, 250, 1000, 512, 768, p.created))
        else:
            rows.append(("shop", p.name, 500, 2000, 1024, 1536, p.created))
    for name, n, ip, created in STATIC_SHOP:
        if n == node and created <= t:
            rows.append(("shop", name, 200, 1000, 256, 512, created))
    extra = {
        S.N1: [("kube-system", "coredns-5d78c9869d-8kxqz", 100, 0, 70, 170, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("kube-system", "kube-proxy-6tq2d", 0, 0, 0, 0, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("logging", S.FLUENTBIT_POD, 50, 0, 64, 200, datetime(2026, 11, 2, 7, 30, tzinfo=UTC)),
               ("flux-system", "source-controller-7c6d9b8f4-l4vmq", 50, 1000, 64, 1024, datetime(2026, 10, 2, 11, tzinfo=UTC))],
        S.N2: [("kube-system", "coredns-5d78c9869d-mz4wt", 100, 0, 70, 170, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("kube-system", "kube-proxy-h8jfk", 0, 0, 0, 0, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("logging", "fluent-bit-m9qzs", 50, 0, 64, 200, datetime(2026, 11, 2, 7, 30, tzinfo=UTC)),
               ("recommendations", "recs-api-8c5f7d6b9-dx4kp", 200, 1000, 512, 1024, datetime(2026, 11, 16, 14, 30, tzinfo=UTC)),
               ("recommendations", S.EVICTED_REPLACEMENT, 100, 0, 256, 0, S.EVICTION)],
        S.N3: [("kube-system", "kube-proxy-x5lnb", 0, 0, 0, 0, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("kube-system", "metrics-server-6d94bc8694-r2wzs", 100, 0, 200, 0, datetime(2026, 9, 14, 8, tzinfo=UTC)),
               ("logging", "fluent-bit-wv4hn", 50, 0, 64, 200, datetime(2026, 11, 2, 7, 30, tzinfo=UTC)),
               ("search", S.SEARCH_POD, 1000, 2000, 2048, 3072, datetime(2026, 11, 12, 18, 3, tzinfo=UTC)),
               ("monitoring", "prometheus-k8s-0", 200, 0, 1024, 0, datetime(2026, 10, 20, 9, tzinfo=UTC))],
    }
    for e in extra[node]:
        if e[6] <= t:
            rows.append(e)
    if node == S.N1 and t < S.EVICTION:
        rows.append(("recommendations", S.EVICTED_POD, 100, 0, 256, 0, datetime(2026, 11, 16, 14, 27, tzinfo=UTC)))
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows


def describe_nodes(world: World, store: EventStore) -> str:
    t = S.utc(8, 13, 5)
    out = [prompt_block(t, "kubectl describe nodes")]
    for i, (node, info) in enumerate(S.NODES.items()):
        pressure = node == S.N1 and S.MEM_PRESSURE_ON <= t < S.MEM_PRESSURE_OFF
        hb = t - sec(7 + i * 3)
        mp = ("True ", rfc_local(hb), rfc_local(S.MEM_PRESSURE_ON), "KubeletHasInsufficientMemory", "kubelet has insufficient memory available") \
            if pressure else ("False", rfc_local(hb), "Mon, 14 Sep 2026 10:00:41 +0300" if False else rfc_local(datetime(2026, 9, 14, 8, 0, 41, tzinfo=UTC)),
                              "KubeletHasSufficientMemory", "kubelet has sufficient memory available")
        taints = "node.kubernetes.io/memory-pressure:NoSchedule" if pressure else "<none>"
        pods = _node_pods(world, node, t)
        prow = []
        for ns, name, cr, cl, mr, ml, created in pods:
            def pct(v, tot):
                return f"({int(v * 100 / tot)}%)"
            prow.append([ns, name,
                         f"{cr}m {pct(cr, 3920)}" if cr else "0 (0%)",
                         f"{cl}m {pct(cl, 3920)}" if cl else "0 (0%)",
                         f"{mr}Mi {pct(mr, S.NODE_ALLOCATABLE_MI)}" if mr else "0 (0%)",
                         f"{ml}Mi {pct(ml, S.NODE_ALLOCATABLE_MI)}" if ml else "0 (0%)",
                         human(t - created)])
        tbl = table(["Namespace", "Name", "CPU Requests", "CPU Limits", "Memory Requests", "Memory Limits", "Age"],
                    [["---------", "----", "------------", "----------", "---------------", "-------------", "---"]] + prow)
        tcr = sum(r[2] for r in pods); tcl = sum(r[3] for r in pods)
        tmr = sum(r[4] for r in pods); tml = sum(r[5] for r in pods)
        rows = _event_rows_for(store, t, lambda o, node=node: o.kind == "Node" and o.name == node)
        out.append(f"""Name:               {node}
Roles:              <none>
Labels:             beta.kubernetes.io/arch=amd64
                    kubernetes.io/hostname={node}
                    kubernetes.io/os=linux
                    node.lumenmart.internal/pool=general
                    topology.kubernetes.io/zone={info['zone']}
Annotations:        node.alpha.kubernetes.io/ttl: 0
                    volumes.kubernetes.io/controller-managed-attach-detach: true
CreationTimestamp:  {rfc_local(datetime(2026, 9, 14, 7, 58, 12 + i, tzinfo=UTC))}
Taints:             {taints}
Unschedulable:      false
Conditions:
  Type             Status  LastHeartbeatTime                 LastTransitionTime                Reason                       Message
  ----             ------  -----------------                 ------------------                ------                       -------
  MemoryPressure   {mp[0]}   {mp[1]}   {mp[2]}   {mp[3]:<28} {mp[4]}
  DiskPressure     False   {rfc_local(hb)}   {rfc_local(datetime(2026, 11, 17, 5, 36, 20, tzinfo=UTC)) if node == S.N3 else rfc_local(datetime(2026, 9, 14, 8, 0, 41, tzinfo=UTC))}   KubeletHasNoDiskPressure     kubelet has no disk pressure
  PIDPressure      False   {rfc_local(hb)}   {rfc_local(datetime(2026, 9, 14, 8, 0, 41, tzinfo=UTC))}   KubeletHasSufficientPID      kubelet has sufficient PID available
  Ready            True    {rfc_local(hb)}   {rfc_local(datetime(2026, 9, 14, 8, 1, 2, tzinfo=UTC))}   KubeletReady                 kubelet is posting ready status
Addresses:
  InternalIP:  {info['ip']}
  Hostname:    {node}
Capacity:
  cpu:                4
  ephemeral-storage:  101430960Ki
  memory:             8126464Ki
  pods:               110
Allocatable:
  cpu:                3920m
  ephemeral-storage:  93478772582
  memory:             {S.NODE_ALLOCATABLE_MI * 1024}Ki
  pods:               110
System Info:
  Kernel Version:             6.8.0-1019-generic
  OS Image:                   Ubuntu 24.04.1 LTS
  Container Runtime Version:  containerd://1.7.22
  Kubelet Version:            v1.31.4
PodCIDR:                      {info['cidr']}.0/24
Non-terminated Pods:          ({len(pods)} in total)
""" + "".join("  " + l + "\n" for l in tbl.splitlines()) + f"""Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests       Limits
  --------           --------       ------
  cpu                {tcr}m ({int(tcr * 100 / 3920)}%)    {tcl}m ({int(tcl * 100 / 3920)}%)
  memory             {tmr}Mi ({int(tmr * 100 / S.NODE_ALLOCATABLE_MI)}%)   {tml}Mi ({int(tml * 100 / S.NODE_ALLOCATABLE_MI)}%)
""" + _events_block(rows) + "\n\n")
    return "".join(out)


def describe_hpa(world: World, store: EventStore) -> str:
    t = S.utc(8, 27, 30)
    rows = _event_rows_for(store, t, lambda o: o.kind == "HorizontalPodAutoscaler")
    return prompt_block(t, "kubectl -n shop describe hpa pricing-api") + f"""Name:                                                  pricing-api
Namespace:                                             shop
Labels:                                                app.kubernetes.io/instance=pricing-api
                                                       app.kubernetes.io/managed-by=Helm
                                                       app.kubernetes.io/name=pricing-api
                                                       helm.sh/chart=pricing-api-3.0.1
Annotations:                                           meta.helm.sh/release-name: pricing-api
                                                       meta.helm.sh/release-namespace: shop
CreationTimestamp:                                     {rfc_local(datetime(2026, 4, 17, 10, 4, 3, tzinfo=UTC))}
Reference:                                             Deployment/pricing-api
Metrics:                                               ( current / target )
  resource cpu on pods  (as a percentage of request):  <unknown> / 70%
Min replicas:                                          4
Max replicas:                                          12
Behavior:
  Scale Up:
    Stabilization Window: 0 seconds
    Select Policy: Max
    Policies:
      - Type: Pods     Value: 4    Period: 15 seconds
      - Type: Percent  Value: 100  Period: 15 seconds
  Scale Down:
    Stabilization Window: 60 seconds
    Select Policy: Max
    Policies:
      - Type: Percent  Value: 100  Period: 15 seconds
Deployment pods:       12 current / 12 desired
Conditions:
  Type            Status  Reason                   Message
  ----            ------  ------                   -------
  AbleToScale     True    ReadyForNewScale         recommended size matches current size
  ScalingActive   False   FailedGetResourceMetric  the HPA was unable to compute the replica count: failed to get cpu utilization: did not receive metrics for targeted pods (pods might be unready)
  ScalingLimited  True    TooManyReplicas          the desired replica count is more than the maximum replica count
""" + _events_block(rows)


def events_json(store: EventStore) -> str:
    items = []
    groups = store.aggregate(S.CAPTURE_EVENTS)
    groups.sort(key=lambda g: (g["o"].ns, g["evname"]))
    for k, g in enumerate(groups):
        o = g["o"]
        inv = {"apiVersion": o.api, "kind": o.kind, "name": o.name, "uid": o.uid}
        if o.ns:
            inv["namespace"] = o.ns
        if o.fieldpath:
            inv["fieldPath"] = o.fieldpath
        src = {"component": o.component}
        if o.host:
            src["host"] = o.host
        items.append({
            "apiVersion": "v1",
            "count": g["count"],
            "eventTime": None,
            "firstTimestamp": iso(g["first"]),
            "involvedObject": inv,
            "kind": "Event",
            "lastTimestamp": iso(g["last"]),
            "message": o.message,
            "metadata": {"creationTimestamp": iso(g["first"]), "name": g["evname"],
                         "namespace": o.ns or "default", "resourceVersion": str(48213377 + k * 7)},
            "reason": o.reason,
            "reportingComponent": o.component,
            "reportingInstance": o.host,
            "source": src,
            "type": o.etype,
        })
    return json.dumps({"apiVersion": "v1", "items": items, "kind": "List", "metadata": {"resourceVersion": ""}},
                      indent=4) + "\n"


def events_wide(store: EventStore) -> str:
    t = S.CAPTURE_EVENTS
    groups = store.aggregate(t)
    groups.sort(key=lambda g: (g["o"].ns or "default", g["evname"]))
    rows = []
    for g in groups:
        o = g["o"]
        obj = f"{o.kind.lower()}/{o.name}"
        if o.kind == "HorizontalPodAutoscaler":
            obj = f"horizontalpodautoscaler/{o.name}"
        src = f"{o.component}, {o.host}" if o.host else o.component
        rows.append([o.ns or "default", human(t - g["last"]), o.etype, o.reason, obj, o.fieldpath, src,
                     o.message, human(t - g["first"]), str(g["count"]), g["evname"]])
    return prompt_block(t, "kubectl get events -A -o wide") + table(
        ["NAMESPACE", "LAST SEEN", "TYPE", "REASON", "OBJECT", "SUBOBJECT", "SOURCE", "MESSAGE", "FIRST SEEN", "COUNT", "NAME"],
        rows)


# ---------------------------------------------------------------- build the event store
def build_events(world: World) -> EventStore:
    r = random.Random(S.SEED + 11)
    ev = EventStore()
    fp = "spec.containers{pricing-api}"
    img_msg = f'Container image "{S.IMAGE}" already present on machine'

    def pod_events(p: Pod):
        ev.add(p.created + sec(0.03), "shop", "ReplicaSet", f"pricing-api-{p.rs_hash}", "rs-" + p.rs_hash,
               "SuccessfulCreate", f"Created pod: {p.name}", component="replicaset-controller", api="apps/v1")
        ev.add(p.created + sec(0.06), "shop", "Pod", p.name, p.uid, "Scheduled",
               f"Successfully assigned shop/{p.name} to {p.node}", component="default-scheduler")
        live_path = f"http://{p.ip}:8080/actuator/health/liveness"
        ready_path = f"http://{p.ip}:8080/actuator/health/readiness"
        refused_l = f'Liveness probe failed: Get "{live_path}": dial tcp {p.ip}:8080: connect: connection refused'
        refused_r = f'Readiness probe failed: Get "{ready_path}": dial tcp {p.ip}:8080: connect: connection refused'
        for i, run in enumerate(p.runs):
            ev.add(run.start - sec(0.6), "shop", "Pod", p.name, p.uid, "Pulled", img_msg, host=p.node, fieldpath=fp)
            ev.add(run.start - sec(0.2), "shop", "Pod", p.name, p.uid, "Created", "Created container: pricing-api", host=p.node, fieldpath=fp)
            ev.add(run.start, "shop", "Pod", p.name, p.uid, "Started", "Started container pricing-api", host=p.node, fieldpath=fp)
            stop = run.end or S.WINDOW_END
            if p.rs_hash == S.BAD_HASH:
                # readiness probe every 5s from +10s until warm
                limit = run.ready or stop
                k = 10.0
                while run.start + sec(k) < limit and run.start + sec(k) < stop:
                    ev.add(run.start + sec(k + r.uniform(0, 0.3)), "shop", "Pod", p.name, p.uid, "Unhealthy",
                           refused_r, etype="Warning", host=p.node, fieldpath=fp)
                    k += 5
                for k in (30, 40, 50):
                    at = run.start + sec(k + r.uniform(0, 0.2))
                    if at < stop and (run.ready is None or at < run.ready):
                        ev.add(at, "shop", "Pod", p.name, p.uid, "Unhealthy", refused_l, etype="Warning",
                               host=p.node, fieldpath=fp)
                if run.outcome == "liveness":
                    ev.add(run.start + sec(S.LIVENESS_KILL_AFTER + 0.3), "shop", "Pod", p.name, p.uid, "Killing",
                           "Container pricing-api failed liveness probe, will be restarted", host=p.node, fieldpath=fp)
            elif run.ready is not None:
                k = 20.0
                while run.start + sec(k) < run.ready:
                    ev.add(run.start + sec(k + r.uniform(0, 0.3)), "shop", "Pod", p.name, p.uid, "Unhealthy",
                           refused_r, etype="Warning", host=p.node, fieldpath=fp)
                    k += 5
            if run.outcome in ("oom", "liveness"):
                nxt = p.runs[i + 1].start if i + 1 < len(p.runs) else (p.deleted or S.WINDOW_END)
                bt = run.end + sec(r.uniform(0.6, 1.4))
                while bt < nxt - sec(0.5):
                    ev.add(bt, "shop", "Pod", p.name, p.uid, "BackOff",
                           f"Back-off restarting failed container pricing-api in pod {p.name}_shop({p.uid})",
                           etype="Warning", host=p.node, fieldpath=fp)
                    bt += sec(r.uniform(9.5, 14.0))
        if p.deleted is not None:
            ev.add(p.deleted + sec(0.05), "shop", "ReplicaSet", f"pricing-api-{p.rs_hash}", "rs-" + p.rs_hash,
                   "SuccessfulDelete", f"Deleted pod: {p.name}", component="replicaset-controller", api="apps/v1")
            ev.add(p.deleted + sec(0.1), "shop", "Pod", p.name, p.uid, "Killing", "Stopping container pricing-api",
                   host=p.node, fieldpath=fp)

    for p in all_pricing(world):
        if p.created >= S.utc(7, 40, 0):
            pod_events(p)
        elif p.deleted is not None:
            ev.add(p.deleted + sec(0.05), "shop", "ReplicaSet", f"pricing-api-{p.rs_hash}", "rs-" + p.rs_hash,
                   "SuccessfulDelete", f"Deleted pod: {p.name}", component="replicaset-controller", api="apps/v1")
            ev.add(p.deleted + sec(0.1), "shop", "Pod", p.name, p.uid, "Killing", "Stopping container pricing-api",
                   host=p.node, fieldpath=fp)

    dep = ("shop", "Deployment", "pricing-api", "dep-pricing-api")
    def scaled(t, rs, to, frm, up=True):
        word = "up" if up else "down"
        ev.add(t, *dep, "ScalingReplicaSet", f"Scaled {word} replica set pricing-api-{rs} to {to} from {frm}",
               component="deployment-controller", api="apps/v1")
    old_n = 4
    for i, p in enumerate(world.bad_pods[:4]):
        scaled(p.created - sec(0.01), S.BAD_HASH, i + 1, i, True)
        scaled(world.old_pods[i].deleted - sec(0.01), S.OLD_HASH, old_n - 1, old_n, False)
        old_n -= 1
    for t, frm, to in world.scale_events:
        scaled(t - sec(0.02), S.BAD_HASH, to, frm, to > frm)
        reason = "cpu resource utilization (percentage of request) above target" if to > frm else "All metrics below target"
        ev.add(t - sec(0.05), "shop", "HorizontalPodAutoscaler", "pricing-api", "hpa-pricing-api", "SuccessfulRescale",
               f"New size: {to}; reason: {reason}", component="horizontal-pod-autoscaler", api="autoscaling/v2")
    scaled(S.FIX_ROLLOUT, S.FIX_HASH, 3, 0, True)
    scaled(S.FIX_ROLLOUT + sec(1.0), S.BAD_HASH, 0, 9, False)
    scaled(S.FIX_ROLLOUT + sec(52.0), S.FIX_HASH, 6, 3, True)
    scaled(S.FIX_ROLLOUT + sec(104.0), S.FIX_HASH, 9, 6, True)
    # HPA metric failures whenever no pricing pod is Ready
    t = S.OUTAGE_START + sec(15)
    while t < S.OUTAGE_END:
        any_ready = any(run.ready and run.ready <= t and (run.end is None or run.end > t)
                        for p in world.bad_pods if p.created <= t and (p.deleted is None or p.deleted > t)
                        for run in p.runs)
        if not any_ready:
            ev.add(t, "shop", "HorizontalPodAutoscaler", "pricing-api", "hpa-pricing-api", "FailedGetResourceMetric",
                   "failed to get cpu utilization: did not receive metrics for targeted pods (pods might be unready)",
                   etype="Warning", component="horizontal-pod-autoscaler", api="autoscaling/v2")
            ev.add(t + sec(0.01), "shop", "HorizontalPodAutoscaler", "pricing-api", "hpa-pricing-api",
                   "FailedComputeMetricsReplicas",
                   "invalid metrics (1 invalid out of 1), first error is: failed to get cpu resource metric value: failed to get cpu utilization: did not receive metrics for targeted pods (pods might be unready)",
                   etype="Warning", component="horizontal-pod-autoscaler", api="autoscaling/v2")
        t += sec(15)
    # Flux HelmRelease events
    hr = ("shop", "HelmRelease", "pricing-api", "hr-pricing-api")
    ev.add(S.REV14_DONE, *hr, "UpgradeSucceeded",
           "Helm upgrade succeeded for release shop/pricing-api.v14 with chart pricing-api@3.0.1",
           component="helm-controller", api="helm.toolkit.fluxcd.io/v2")
    ev.add(S.REV15_TIME + sec(300.4), *hr, "UpgradeFailed",
           "Helm upgrade failed for release shop/pricing-api with chart pricing-api@3.0.1: context deadline exceeded",
           etype="Warning", component="helm-controller", api="helm.toolkit.fluxcd.io/v2")
    ev.add(S.REV16_DONE, *hr, "UpgradeSucceeded",
           "Helm upgrade succeeded for release shop/pricing-api.v16 with chart pricing-api@3.0.1",
           component="helm-controller", api="helm.toolkit.fluxcd.io/v2")
    # Node events
    for p, run in S.oom_runs(world):
        ev.add(run.end + sec(0.4), "", "Node", p.node, p.node, "SystemOOM",
               f"System OOM encountered, victim process: java, pid: {run.pid}", etype="Warning", host=p.node)
    ev.add(S.SEARCH_OOM + sec(0.4), "", "Node", S.N3, S.N3, "SystemOOM",
           f"System OOM encountered, victim process: java, pid: {SEARCH_PID}", etype="Warning", host=S.N3)
    ev.add(S.MEM_PRESSURE_ON, "", "Node", S.N1, S.N1, "NodeHasInsufficientMemory",
           f"Node {S.N1} status is now: NodeHasInsufficientMemory", host=S.N1)
    ev.add(S.MEM_PRESSURE_ON + sec(11.9), "", "Node", S.N1, S.N1, "EvictionThresholdMet",
           "Attempting to reclaim memory", etype="Warning", host=S.N1)
    ev.add(S.MEM_PRESSURE_OFF, "", "Node", S.N1, S.N1, "NodeHasSufficientMemory",
           f"Node {S.N1} status is now: NodeHasSufficientMemory", host=S.N1)
    ev.add(S.CORDON, "", "Node", S.N1, S.N1, "NodeNotSchedulable", f"Node {S.N1} status is now: NodeNotSchedulable", host=S.N1)
    ev.add(S.UNCORDON, "", "Node", S.N1, S.N1, "NodeSchedulable", f"Node {S.N1} status is now: NodeSchedulable", host=S.N1)
    # the eviction
    ev.add(S.EVICTION, S.EVICTED_NS, "Pod", S.EVICTED_POD, "uid-recs", "Evicted",
           "The node was low on resource: memory. Threshold quantity: 500Mi, available: 431208Ki. Container feature-sync "
           "was using 1887436Ki, request is 256Mi, has larger consumption of memory. ",
           etype="Warning", host=S.N1)
    ev.add(S.EVICTION + sec(0.1), S.EVICTED_NS, "Pod", S.EVICTED_POD, "uid-recs", "Killing",
           "Stopping container feature-sync", host=S.N1, fieldpath="spec.containers{feature-sync}")
    ev.add(S.EVICTION + sec(0.4), S.EVICTED_NS, "ReplicaSet", "recs-feature-sync-6f7d9c8b4", "rs-recs", "SuccessfulCreate",
           f"Created pod: {S.EVICTED_REPLACEMENT}", component="replicaset-controller", api="apps/v1")
    ev.add(S.EVICTION + sec(0.5), S.EVICTED_NS, "Pod", S.EVICTED_REPLACEMENT, "uid-recs2", "Scheduled",
           f"Successfully assigned recommendations/{S.EVICTED_REPLACEMENT} to {S.N2}", component="default-scheduler")
    for k, (rs, msg) in enumerate([("Pulled", 'Container image "registry.lumenmart.internal/recs/feature-sync:1.19.0" already present on machine'),
                                    ("Created", "Created container: feature-sync"), ("Started", "Started container feature-sync")]):
        ev.add(S.EVICTION + sec(1.8 + k * 0.2), S.EVICTED_NS, "Pod", S.EVICTED_REPLACEMENT, "uid-recs2", rs, msg,
               host=S.N2, fieldpath="spec.containers{feature-sync}")
    # search-indexer restart after its own OOM (unrelated)
    sfp = "spec.containers{indexer}"
    ev.add(S.SEARCH_OOM + sec(1.2), "search", "Pod", S.SEARCH_POD, "uid-search", "BackOff",
           f"Back-off restarting failed container indexer in pod {S.SEARCH_POD}_search(3f0c9b2e-41d7-4a8e-b6c5-9e2a7d18f4c0)",
           etype="Warning", host=S.N3, fieldpath=sfp)
    for k, (rs, msg) in enumerate([("Pulled", 'Container image "registry.lumenmart.internal/search/indexer:7.3.2" already present on machine'),
                                    ("Created", "Created container: indexer"), ("Started", "Started container indexer")]):
        ev.add(S.SEARCH_OOM + sec(11.5 + k * 0.2), "search", "Pod", S.SEARCH_POD, "uid-search", rs, msg,
               host=S.N3, fieldpath=sfp)
    # hourly cronjob noise
    for hh in (8,):
        t0 = S.utc(hh, 0, 0, 12)
        job = f"recs-hourly-rollup-{int(t0.timestamp()) // 60}"
        pod = f"{job}-{'kq7xz' if hh == 8 else 'b2m4p'}"
        ev.add(t0, S.EVICTED_NS, "CronJob", "recs-hourly-rollup", "cj", "SuccessfulCreate", f"Created job {job}",
               component="cronjob-controller", api="batch/v1")
        ev.add(t0 + sec(0.05), S.EVICTED_NS, "Job", job, "job", "SuccessfulCreate", f"Created pod: {pod}",
               component="job-controller", api="batch/v1")
        ev.add(t0 + sec(0.08), S.EVICTED_NS, "Pod", pod, "uid-job", "Scheduled",
               f"Successfully assigned recommendations/{pod} to {S.N3}", component="default-scheduler")
        for k, (rs, msg) in enumerate([("Pulling", 'Pulling image "registry.lumenmart.internal/recs/rollup:2.4.0"'),
                                        ("Pulled", 'Successfully pulled image "registry.lumenmart.internal/recs/rollup:2.4.0" in 1.204s (1.204s including waiting). Image size: 48211093 bytes.'),
                                        ("Created", "Created container: rollup"), ("Started", "Started container rollup")]):
            ev.add(t0 + sec(1 + k * 0.7), S.EVICTED_NS, "Pod", pod, "uid-job", rs, msg, host=S.N3,
                   fieldpath="spec.containers{rollup}")
        ev.add(t0 + sec(48.2), S.EVICTED_NS, "Job", job, "job", "Completed", "Job completed",
               component="job-controller", api="batch/v1")
        ev.add(t0 + sec(50.0), S.EVICTED_NS, "CronJob", "recs-hourly-rollup", "cj", "SawCompletedJob",
               f"Saw completed job: {job}, condition: Complete", component="cronjob-controller", api="batch/v1")
    return ev


SEARCH_PID = 61840
