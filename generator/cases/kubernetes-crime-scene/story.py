"""Canonical constants + deterministic pod-lifecycle simulation for `kubernetes-crime-scene`.

Everything here is UTC. See docs/cases/kubernetes-crime-scene.md for the story (SPOILERS).
"""
from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20261117
CASE_ID = "kubernetes-crime-scene"

UTC = timezone.utc
LOCAL_TZ = timezone(timedelta(hours=2))  # Asia/Jerusalem in November

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE_DIR = ROOT / "build" / "evidence" / CASE_ID
TRUTH_DIR = ROOT / "build" / "truth"


def utc(h: int, m: int, s: int, ms: int = 0, day: int = 17) -> datetime:
    return datetime(2026, 11, day, h, m, s, ms * 1000, tzinfo=UTC)


def sec(x: float) -> timedelta:
    return timedelta(seconds=x)


# ---------------------------------------------------------------- timeline
JOURNAL_START = utc(3, 0, 0)
WINDOW_START = utc(7, 30, 0)          # ingress / metrics window
WINDOW_END = utc(9, 0, 0)
JOURNAL_END = utc(8, 50, 0)

FLUENTBIT_OOM = utc(3, 12, 37, 402)   # red herring: unrelated OOM on k2m9, hours earlier
CI_RUNNER_EVICT = utc(5, 31, 8, 220)  # red herring: ephemeral-storage eviction on w3zx

REV12_TIME = datetime(2026, 11, 12, 8, 15, 47, tzinfo=UTC)
REV13_TIME = utc(7, 21, 40)           # harmless annotations change
INVENTORY_SYNC = utc(7, 33, 5)        # unrelated deploy (other app)
BAD_COMMIT_TIME = utc(7, 51, 12)      # git push of the values migration
BAD_SOURCE_FETCH = utc(7, 51, 50, 114)
BAD_KUSTOMIZE_APPLY = utc(7, 51, 58, 731)
REV14_TIME = utc(7, 52, 29, 618)      # helm upgrade starts (helm history UPDATED)
ROLLOUT_START = utc(7, 52, 31, 40)
OUTAGE_START = utc(7, 55, 36, 512)    # last old pod removed from endpoints
REV14_DONE = utc(7, 55, 37, 9)
ALERT_FIRED = utc(7, 57, 41)
HPA_UP_1 = utc(8, 3, 12, 300)         # 4 -> 8
HPA_COMMIT_TIME = utc(8, 9, 41)
REV15_TIME = utc(8, 10, 2, 455)       # maxReplicas 8 -> 12 (on-call)
HPA_UP_2 = utc(8, 10, 31, 120)        # 8 -> 12
MEM_PRESSURE_ON = utc(8, 11, 40, 6)
EVICTION = utc(8, 11, 52, 318)
CORDON = utc(8, 14, 30, 811)
MEM_PRESSURE_OFF = utc(8, 16, 55, 240)
HPA_DOWN_1 = utc(8, 17, 2, 710)       # 12 -> 7
SEARCH_OOM = utc(8, 20, 14, 77)       # red herring: unrelated java OOM on w3zx
HPA_UP_3 = utc(8, 23, 40, 150)        # 7 -> 12
HPA_DOWN_2 = utc(8, 31, 15, 900)      # 12 -> 9
UNCORDON = utc(8, 35, 10, 402)
FIX_COMMIT_TIME = utc(8, 39, 50)
FIX_SOURCE_FETCH = utc(8, 40, 31, 552)
FIX_KUSTOMIZE_APPLY = utc(8, 40, 39, 203)
REV16_TIME = utc(8, 41, 3, 870)
FIX_ROLLOUT = utc(8, 41, 5, 300)
OUTAGE_END = utc(8, 41, 58, 640)      # first fixed pod Ready -> endpoints back
REV16_DONE = utc(8, 44, 31, 118)

CAPTURE_EVENTS = utc(8, 44, 12)       # `kubectl get events -A` run time
EVENT_TTL = timedelta(hours=1)

# ---------------------------------------------------------------- cluster
NS = "shop"
APP = "pricing-api"
IMAGE = "registry.lumenmart.internal/pricing/pricing-api:4.12.3"
OLD_HASH = "5f7c9d6b48"
BAD_HASH = "6d5b8c7f9"
FIX_HASH = "7b8d4f6c5d"

N1 = "prod-eu1-general-6b4f-k2m9"
N2 = "prod-eu1-general-6b4f-r7tq"
N3 = "prod-eu1-general-6b4f-w3zx"
NODES = {
    N1: {"ip": "10.20.0.11", "cidr": "10.244.1", "zone": "dc1-a", "pid": 2214, "cpid": 1187},
    N2: {"ip": "10.20.0.12", "cidr": "10.244.2", "zone": "dc1-b", "pid": 2198, "cpid": 1176},
    N3: {"ip": "10.20.0.13", "cidr": "10.244.3", "zone": "dc1-c", "pid": 2231, "cpid": 1203},
}
NODE_ALLOCATABLE_MI = 7168          # 8 GiB box minus system/kube reserved
EVICTION_HARD_MI = 500

SERVICE_SELECTOR = [("app", "pricing-api"), ("tier", "backend")]
OLD_POD_LABELS = [("app", "pricing-api"), ("app.kubernetes.io/instance", "pricing-api"),
                  ("app.kubernetes.io/name", "pricing-api"), ("tier", "backend")]
NEW_POD_LABELS = [("app.kubernetes.io/instance", "pricing-api"),
                  ("app.kubernetes.io/name", "pricing-api"), ("tier", "backend")]

OLD_LIMIT = "1536Mi"
NEW_LIMIT = "768Mi"
NEW_LIMIT_KB = 768 * 1024
NEW_REQUEST = "512Mi"

LIVENESS_DELAY = 30
LIVENESS_PERIOD = 10
LIVENESS_FAIL = 3
LIVENESS_KILL_AFTER = LIVENESS_DELAY + LIVENESS_PERIOD * (LIVENESS_FAIL - 1)  # 50 s

EVICTED_POD = "recs-feature-sync-6f7d9c8b4-hv2lp"
EVICTED_NS = "recommendations"
EVICTED_REPLACEMENT = "recs-feature-sync-6f7d9c8b4-tq8mz"
CI_RUNNER_POD = "ci-runner-7d4b9f8c5-xw2lm"
FLUENTBIT_POD = "fluent-bit-7xk2d"
SEARCH_POD = "search-indexer-0"

PEOPLE = {
    "noam.s": "Noam Segal (on-call SRE)",
    "ronen.g": "Ronen Gold (pricing team)",
    "avi.p": "Avi Peretz (platform lead)",
    "tamar.l": "Tamar Levi (inventory team)",
    "shira.k": "Shira Katz (recommendations team)",
    "dalia.m": "Dalia Mor (engineering manager)",
}

# ---------------------------------------------------------------- helpers
_rng = random.Random(SEED)
ALPHA = "bcdfghjklmnpqrstvwxz2456789"


def rng() -> random.Random:
    return _rng


def hexstr(n: int, r: random.Random | None = None) -> str:
    r = r or _rng
    return "".join(r.choice("0123456789abcdef") for _ in range(n))


def new_uid(r: random.Random | None = None) -> str:
    h = hexstr(32, r)
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"


def suffix(r: random.Random | None = None) -> str:
    r = r or _rng
    return "".join(r.choice(ALPHA) for _ in range(5))


def fake_sha(seed_text: str) -> str:
    return hashlib.sha1(seed_text.encode()).hexdigest()


# ---------------------------------------------------------------- model
@dataclass
class Run:
    start: datetime
    ready: datetime | None
    end: datetime | None
    outcome: str          # oom | liveness | deleted | running
    cid: str
    pid: int
    warmup: float
    rss_kb: int = 0


@dataclass
class Pod:
    name: str
    rs_hash: str
    node: str
    ip: str
    uid: str
    created: datetime
    deleted: datetime | None = None
    runs: list[Run] = field(default_factory=list)
    labels: list[tuple[str, str]] = field(default_factory=list)

    @property
    def short(self) -> str:
        return self.name.rsplit("-", 1)[1]


_ip_counter = {N1: 31, N2: 18, N3: 44}
_pid_counter = {N1: 41207, N2: 38114, N3: 45580}


def next_ip(node: str) -> str:
    _ip_counter[node] += _rng.randint(1, 4)
    return f"{NODES[node]['cidr']}.{_ip_counter[node]}"


def next_pid(node: str) -> int:
    _pid_counter[node] += _rng.randint(40, 900)
    return _pid_counter[node]


def backoff(fails: int) -> float:
    return float(min(10 * 2 ** (fails - 1), 300))


# ---------------------------------------------------------------- simulation
@dataclass
class World:
    old_pods: list[Pod]
    bad_pods: list[Pod]
    fix_pods: list[Pod]
    scale_events: list[tuple[datetime, int, int]]  # (time, old, new) desired replicas

    def pricing_on_node(self, node: str, t: datetime) -> int:
        n = 0
        for p in self.bad_pods:
            if p.node == node and p.created <= t and (p.deleted is None or p.deleted > t):
                n += 1
        return n


def _mkpod(rs_hash: str, short: str, node: str, created: datetime, labels) -> Pod:
    return Pod(name=f"{APP}-{rs_hash}-{short}", rs_hash=rs_hash, node=node, ip=next_ip(node),
               uid=new_uid(), created=created, labels=list(labels))


def simulate() -> World:
    r = _rng
    # rev13 pods, alive since the 07:21 rollout
    old = []
    for short, node, created in [("4kq2n", N1, utc(7, 21, 44, 90)), ("8vjtm", N2, utc(7, 22, 41, 700)),
                                 ("hc7xp", N3, utc(7, 23, 37, 215)), ("tw9rd", N2, utc(7, 24, 35, 802))]:
        p = _mkpod(OLD_HASH, short, node, created, OLD_POD_LABELS)
        st = created + sec(2.6)
        p.runs.append(Run(st, st + sec(r.uniform(52, 58)), None, "running", hexstr(64), next_pid(node), 55.0))
        old.append(p)

    # the bad rollout: maxSurge 1, maxUnavailable 0; each new pod Ready -> one old pod removed
    plan = [("2xkqp", N1, ROLLOUT_START, 42.4, 230.6),
            ("m5rjc", N2, None, 41.9, 166.8),
            ("bq9tz", N3, None, 43.1, 213.7),
            ("7hn4w", N1, None, 42.2, 245.1)]
    bad: list[Pod] = []
    t = ROLLOUT_START
    for i, (short, node, _, warm, oom_after) in enumerate(plan):
        p = _mkpod(BAD_HASH, short, node, t, NEW_POD_LABELS)
        st = t + sec(2.9 + 0.2 * i)
        ready = st + sec(warm)
        if i == 3:  # make the last one line up with OUTAGE_START exactly
            ready = OUTAGE_START
        p.runs.append(Run(st, ready, ready + sec(oom_after), "oom", hexstr(64), next_pid(node), warm))
        bad.append(p)
        old[i].deleted = ready
        old[i].runs[-1].end = ready + sec(r.uniform(1.4, 2.6))
        old[i].runs[-1].outcome = "deleted"
        t = ready + sec(0.3)

    scale_events = [(HPA_UP_1, 4, 8), (HPA_UP_2, 8, 12), (HPA_DOWN_1, 12, 7),
                    (HPA_UP_3, 7, 12), (HPA_DOWN_2, 12, 9)]
    adds = {HPA_UP_1: [("c8wtd", N1), ("f2lsv", N1), ("pz6nk", N2), ("v9qhx", N3)],
            HPA_UP_2: [("j4mrb", N1), ("n7xcz", N2), ("s2kfh", N2), ("w6tdl", N3)],
            HPA_UP_3: [("d9hqv", N2), ("g5wnr", N3), ("k8bzs", N2), ("q2vjm", N3), ("x7cfp", N2)]}
    for when, items in adds.items():
        for j, (short, node) in enumerate(items):
            bad.append(_mkpod(BAD_HASH, short, node, when + sec(0.05 + 0.04 * j), NEW_POD_LABELS))
    # ReplicaSet scale-down picks the newest pods first (all are equally unhealthy)
    def delete_newest(when: datetime, n: int) -> None:
        alive = [p for p in bad if p.created <= when and p.deleted is None]
        alive.sort(key=lambda p: p.created, reverse=True)
        for k, p in enumerate(alive[:n]):
            p.deleted = when + sec(0.2 + 0.05 * k)
    delete_newest(HPA_DOWN_1, 5)
    delete_newest(HPA_DOWN_2, 3)
    # the fix rollout: unavailable old pods are scaled down right away
    alive = sorted([p for p in bad if p.deleted is None], key=lambda p: p.name)
    for k, p in enumerate(alive):
        p.deleted = FIX_ROLLOUT + sec(1.1 + 0.6 * k)

    world = World(old, bad, [], scale_events)

    def slow(node: str, at: datetime) -> bool:
        n = world.pricing_on_node(node, at)
        if node == N1 and MEM_PRESSURE_ON - sec(60) <= at <= MEM_PRESSURE_OFF:
            return True
        if n >= 5:
            return True
        if n == 4 and node == N1:
            return r.random() < 0.6
        return r.random() < 0.18

    for p in bad:
        if not p.runs:
            st = p.created + sec(r.uniform(2.4, 3.6))
        else:
            first = p.runs[0]
            st = first.end + sec(backoff(1) + r.uniform(0.4, 2.2))
        fails = len(p.runs)
        while st < p.deleted:
            node = p.node
            if slow(node, st):
                warm = r.uniform(56, 88)
                end = st + sec(LIVENESS_KILL_AFTER + r.uniform(0.3, 0.9) + r.uniform(1.2, 2.4))
                run = Run(st, None, end, "liveness", hexstr(64), next_pid(node), warm)
            else:
                warm = r.uniform(40.5, 48.5)
                ready = st + sec(warm)
                end = ready + sec(r.uniform(65, 205))
                run = Run(st, ready, end, "oom", hexstr(64), next_pid(node), warm)
            if run.end >= p.deleted:
                run.end = p.deleted + sec(r.uniform(1.5, 2.8))
                run.outcome = "deleted"
                if run.ready and run.ready >= p.deleted:
                    run.ready = None
                p.runs.append(run)
                break
            p.runs.append(run)
            fails += 1
            st = run.end + sec(backoff(fails) + r.uniform(0.4, 2.2))
        # a pod whose next start is after deletion simply stays in CrashLoopBackOff until deleted
    for p in bad:
        for run in p.runs:
            if run.outcome == "oom":
                run.rss_kb = NEW_LIMIT_KB - r.randint(900, 7800)
    # host PIDs grow with time on each node
    for node in NODES:
        runs = sorted((run for p in old + bad if p.node == node for run in p.runs), key=lambda x: x.start)
        for run in runs:
            run.pid = next_pid(node)

    # fix pods: 1536Mi again, probes restored; created in three waves
    fix_nodes = [N2, N3, N1, N2, N3, N1, N2, N3, N1]
    fix_shorts = ["b4rkt", "h2wzn", "l9cvd", "p6xqs", "t5mjg", "z8dkb", "c2nfw", "r4hzp", "v7gtx"]
    for k, (short, node) in enumerate(zip(fix_shorts, fix_nodes)):
        wave = k // 3
        created = FIX_ROLLOUT + sec(0.1 + 0.05 * k + 52.0 * wave)
        p = _mkpod(FIX_HASH, short, node, created, OLD_POD_LABELS)
        st = created + sec(2.7 + 0.1 * k)
        ready = st + sec(r.uniform(48, 55))
        if k == 0:
            ready = OUTAGE_END
        p.runs.append(Run(st, ready, None, "running", hexstr(64), next_pid(node), 50.0))
        world.fix_pods.append(p)
    return world


def oom_runs(world: World) -> list[tuple[Pod, Run]]:
    out = [(p, run) for p in world.bad_pods for run in p.runs if run.outcome == "oom"]
    out.sort(key=lambda x: x[1].end)
    return out


def liveness_runs(world: World) -> list[tuple[Pod, Run]]:
    out = [(p, run) for p in world.bad_pods for run in p.runs if run.outcome == "liveness"]
    out.sort(key=lambda x: x[1].end)
    return out


def endpoints_at(world: World, t: datetime) -> list[Pod]:
    """Pods selected by the Service (app=pricing-api,tier=backend) and Ready at t."""
    eps = []
    for p in world.old_pods + world.fix_pods:
        if p.created > t or (p.deleted is not None and p.deleted <= t):
            continue
        run = p.runs[-1]
        if run.ready and run.ready <= t and (run.end is None or run.end > t):
            eps.append(p)
    return eps
