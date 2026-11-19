#!/usr/bin/env python3
"""Generate nginx access log, nginx.conf snippet and checkout-service app log for case `3am-outage`.

Run from the repo root:  python3 generator/gen_logs.py

Deterministic (random.Random(timeline.SEED)) and idempotent. Stdlib only.
Internally every time is an integer number of milliseconds since timeline.WINDOW_START (UTC).
"""
from __future__ import annotations

import heapq
import json
import random
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import timeline as T  # noqa: E402

RNG = random.Random(T.SEED)

W0 = T.WINDOW_START
WEND = int((T.WINDOW_END - W0).total_seconds() * 1000)


def ms_of(dt: datetime) -> int:
    return int(round((dt - W0).total_seconds() * 1000))


DEPLOY_V2140 = ms_of(T.DEPLOY_V2140)
DEPLOY_V2141 = ms_of(T.DEPLOY_V2141)
ROLLBACK = ms_of(T.ROLLBACK)
POISON = [ms_of(a) for a in T.POISON_ATTEMPTS]
FIRST_5XX = ms_of(T.FIRST_5XX)
TIMEOUT = T.NGINX_PROXY_READ_TIMEOUT_S * 1000

HOST = "https://shipfast.example"

# ----------------------------------------------------------------------------------------------
# time formatting (cached per second)
_NG_CACHE: dict[int, str] = {}
_APP_CACHE: dict[int, str] = {}


def ng_time(t: int) -> str:
    s = t // 1000
    v = _NG_CACHE.get(s)
    if v is None:
        v = (W0 + timedelta(seconds=s)).strftime("%d/%b/%Y:%H:%M:%S +0000")
        _NG_CACHE[s] = v
    return v


def app_time(t: int) -> str:
    s = t // 1000
    v = _APP_CACHE.get(s)
    if v is None:
        v = T.to_local(W0 + timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%S")
        _APP_CACHE[s] = v
    return f"{v}.{t % 1000:03d}+02:00"


def rid() -> str:
    return f"{RNG.getrandbits(128):032x}"


# ----------------------------------------------------------------------------------------------
# pools
UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36",
    "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
]
BOT_UAS = ["python-requests/2.31.0", "Mozilla/5.0 zgrab/0.x", "curl/8.4.0",
           "Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)"]
BOT_PATHS = ["/wp-login.php", "/.env", "/xmlrpc.php", "/admin.php", "/.git/config", "/phpmyadmin/",
             "/wp-admin/setup-config.php", "/config.json", "/.aws/credentials", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php"]
IP_PREFIXES = ["203.0.113.", "198.51.100.", "192.0.2.", "84.229.", "109.67.", "31.154.", "77.137.", "46.120.", "79.177."]
SLUGS = [
    "merino-wool-beanie", "trail-runner-x2", "ceramic-pour-over-set", "linen-throw-blanket", "bamboo-cutting-board",
    "wireless-earbuds-pro", "insulated-bottle-750ml", "canvas-weekender-bag", "desk-lamp-arc", "yoga-mat-cork",
    "cast-iron-skillet-26cm", "rain-shell-jacket", "kids-puzzle-world-map", "scented-candle-fig", "leather-card-wallet",
    "smart-plug-2pack", "noise-cancelling-headphones", "chef-knife-20cm", "wool-socks-3pack", "board-game-catan",
    "polaroid-film-i-type", "hiking-backpack-28l", "electric-kettle-matte", "plant-pot-terracotta", "usb-c-hub-7in1",
    "silk-pillowcase", "running-cap-light", "espresso-cups-set", "phone-case-clear", "picnic-blanket-xl",
]
STATIC_ASSETS = [
    ("/static/js/app.3f9c1e7a.js", 184_212), ("/static/css/main.8a2b4d10.css", 41_877),
    ("/static/js/vendor.c41d0b2e.js", 402_119), ("/static/fonts/inter-var.woff2", 98_412),
    ("/favicon.ico", 4_286),
]
PROBE_IPS = ["10.42.0.17", "10.42.1.23", "10.42.0.41"]
ORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_customer_ip: dict[str, str] = {}
_customer_ua: dict[str, str] = {}


def rand_ip() -> str:
    p = RNG.choice(IP_PREFIXES)
    if p.count(".") == 3:
        return p + str(RNG.randint(2, 254))
    return f"{p}{RNG.randint(1, 254)}.{RNG.randint(2, 254)}"


def cust_ip_ua(cid: str) -> tuple[str, str]:
    if cid not in _customer_ip:
        _customer_ip[cid] = rand_ip()
        _customer_ua[cid] = RNG.choice(UAS)
    return _customer_ip[cid], _customer_ua[cid]


CUSTOMERS = [f"cus_{n}" for n in RNG.sample(range(1000, 10000), 7000) if n != 4417]


def pick_customer() -> str:
    # mild skew: a core of frequent shoppers
    if RNG.random() < 0.35:
        return CUSTOMERS[RNG.randrange(800)]
    return CUSTOMERS[RNG.randrange(len(CUSTOMERS))]


def new_order_id() -> str:
    while True:
        o = "ORD-" + "".join(RNG.choice(ORD_CHARS) for _ in range(6))
        if o != T.POISON_ORDER:
            return o


# ----------------------------------------------------------------------------------------------
# Request intents. Each request is a dict; heap keyed by (start, seq).
_seq = 0
HEAP: list[tuple[int, int, dict]] = []


def add_req(start: int, **kw) -> None:
    global _seq
    _seq += 1
    kw["start"] = start
    heapq.heappush(HEAP, (start, _seq, kw))


def rate_factor(t: int) -> float:
    """Gentle night curve: busier at 02:00 local, quieter towards 04:30."""
    x = t / WEND
    return 1.12 - 0.28 * x + 0.05 * __import__("math").sin(x * 9.0)


def gen_session(t0: int) -> None:
    logged = RNG.random() < 0.7
    if logged:
        cid = pick_customer()
        ip, ua = cust_ip_ua(cid)
    else:
        cid = "-"
        ip, ua = rand_ip(), RNG.choice(UAS)
    t = t0
    npages = RNG.choices([1, 2, 3, 4, 5, 6], weights=[22, 25, 20, 15, 10, 8])[0]
    prev = None
    adds = 0
    for p in range(npages):
        if p == 0 and RNG.random() < 0.55:
            path = "/"
        else:
            path = "/products/" + RNG.choice(SLUGS)
        if prev is None:
            ref = RNG.choice(["-", "-", "https://www.google.com/", HOST + "/", "https://www.instagram.com/"])
        else:
            ref = HOST + prev
        status = 200
        if RNG.random() < 0.002 and path.startswith("/products/"):
            path = "/products/" + RNG.choice(["winter-sale-2025", "gift-card-old", "airpods-case-v1"])
            status = 404
        add_req(t, kind="page", method="GET", path=path, ip=ip, ua=ua, cid=cid, ref=ref, status=status)
        page_url = HOST + path
        returning = RNG.random() < 0.4
        for asset, size in RNG.sample(STATIC_ASSETS, RNG.choice([0, 1, 1, 2]) if p else RNG.randint(2, 4)):
            add_req(t + RNG.randint(60, 700), kind="static", method="GET", path=asset, ip=ip, ua=ua, cid="-",
                    ref=page_url, size=size, status=304 if returning else 200)
        if path.startswith("/products/"):
            add_req(t + RNG.randint(80, 600), kind="static", method="GET",
                    path=f"/static/img/products/{path.rsplit('/', 1)[1]}.webp", ip=ip, ua=ua, cid="-",
                    ref=page_url, size=RNG.randint(38_000, 160_000), status=304 if returning else 200)
        if RNG.random() < 0.6:
            add_req(t + RNG.randint(300, 1200), kind="cart_get", method="GET", path="/api/cart",
                    ip=ip, ua=ua, cid=cid, ref=page_url)
        t += RNG.randint(4_000, 35_000)
        if path.startswith("/products/") and RNG.random() < 0.45:
            add_req(t, kind="cart_add", method="POST", path="/api/cart/items", ip=ip, ua=ua, cid=cid, ref=page_url)
            adds += 1
            t += RNG.randint(1_500, 12_000)
        prev = path
    if logged and adds and RNG.random() < 0.85:
        add_req(t, kind="cart_get", method="GET", path="/api/cart", ip=ip, ua=ua, cid=cid, ref=HOST + "/cart")
        t += RNG.randint(8_000, 70_000)
        gift = RNG.randint(5, 60) if RNG.random() < 0.15 else None
        add_req(t, kind="checkout", method="POST", path="/api/checkout", ip=ip, ua=ua, cid=cid,
                ref=HOST + "/cart", order=new_order_id(), items=adds + RNG.choice([0, 0, 1]), gift=gift,
                retries_left=None)


def gen_traffic() -> None:
    # sessions (non-homogeneous Poisson via thinning), started a bit before the window to warm up
    base = 1.0 / 1000.0  # sessions per ms at factor 1
    lam_max = base * 1.25
    t = -10 * 60 * 1000
    while True:
        t += int(RNG.expovariate(lam_max)) + 1
        if t > WEND:
            break
        if RNG.random() < rate_factor(max(t, 0)) * base / lam_max:
            gen_session(t)
    # synthetic monitor
    t = RNG.randint(3_000, 9_000)
    while t < WEND:
        add_req(t + RNG.randint(0, 250), kind="checkout", method="POST", path="/api/checkout",
                ip="198.51.100.200", ua=T.SYNTHETIC_UA, cid=T.SYNTHETIC_CUSTOMER, ref="-",
                order=f"SYN-{(t // 1000):05d}", items=1, gift=None, retries_left=0)
        t += T.SYNTHETIC_INTERVAL_S * 1000
    # kube-probe health checks (one prober per checkout pod)
    for ip in PROBE_IPS:
        t = RNG.randint(0, 5000)
        while t < WEND:
            add_req(t, kind="healthz", method="GET", path="/healthz", ip=ip, ua="kube-probe/1.30", cid="-", ref="-")
            t += 5000 + RNG.randint(-150, 150)
    # scanners / bots -> 404
    t = RNG.randint(0, 120_000)
    while t < WEND:
        ip, ua = rand_ip(), RNG.choice(BOT_UAS)
        for p in RNG.sample(BOT_PATHS, RNG.randint(2, 6)):
            t += RNG.randint(80, 900)
            add_req(t, kind="bot", method="GET", path=p, ip=ip, ua=ua, cid="-", ref="-")
        t += RNG.randint(90_000, 420_000)
    # the poison customer: browses, fills the cart, then pays (9 submissions in total)
    pc = T.POISON_CUSTOMER
    pip, pua = "203.0.113.57", UAS[2]
    _customer_ip[pc], _customer_ua[pc] = pip, pua
    t = POISON[0] - 6 * 60 * 1000 - 13_412
    add_req(t, kind="page", method="GET", path="/", ip=pip, ua=pua, cid=pc, ref="https://www.instagram.com/", status=200)
    for slug in ["silk-pillowcase", "scented-candle-fig", "linen-throw-blanket", "espresso-cups-set"]:
        t += RNG.randint(20_000, 60_000)
        add_req(t, kind="page", method="GET", path="/products/" + slug, ip=pip, ua=pua, cid=pc,
                ref=HOST + "/", status=200)
        add_req(t + 240, kind="static", method="GET", path=f"/static/img/products/{slug}.webp", ip=pip, ua=pua,
                cid="-", ref=HOST + "/products/" + slug, size=RNG.randint(38_000, 160_000), status=200)
        if slug != "espresso-cups-set":
            add_req(t + RNG.randint(5_000, 15_000), kind="cart_add", method="POST", path="/api/cart/items",
                    ip=pip, ua=pua, cid=pc, ref=HOST + "/products/" + slug)
    add_req(POISON[0] - 41_870, kind="cart_get", method="GET", path="/api/cart", ip=pip, ua=pua, cid=pc,
            ref=HOST + "/cart")
    for a in POISON:
        add_req(a, kind="poison", method="POST", path="/api/checkout", ip=pip, ua=pua, cid=pc,
                ref=HOST + "/cart", order=T.POISON_ORDER, items=3, gift=T.POISON_GIFT_MESSAGE_LEN)


# ----------------------------------------------------------------------------------------------
# Pods: 3 upstream slots, each with a sequence of generations and freeze/down intervals.
APP: list[tuple[int, int, str]] = []  # (ts_ms, seq, json)
_aseq = 0


def app_log(t: int, level: str, pod: str, version: str, msg: str, rid_: str | None = None, **fields) -> None:
    global _aseq
    if t < 0 or t > WEND:
        return
    rec = {"ts": app_time(t), "level": level, "svc": "checkout", "pod": pod, "version": version}
    if rid_ is not None:
        rec["rid"] = rid_
    rec["msg"] = msg
    rec.update(fields)
    _aseq += 1
    APP.append((t, _aseq, json.dumps(rec, separators=(",", ":"))))


class Slot:
    def __init__(self, idx: int) -> None:
        self.idx = idx
        self.gens: list[tuple[int, str, str]] = []  # (from_ms, pod, version)
        self.outages: list[list[int]] = []  # [freeze_start, kill, ready]
        self.restarts = 0

    def gen_at(self, t: int) -> tuple[str, str]:
        cur = self.gens[0]
        for g in self.gens:
            if g[0] <= t:
                cur = g
            else:
                break
        return cur[1], cur[2]

    def state_at(self, t: int) -> tuple[str, list[int] | None]:
        for o in self.outages:
            if o[0] <= t < o[1]:
                return "frozen", o
            if o[1] <= t < o[2]:
                return "down", o
        return "up", None

    def next_freeze_after(self, t: int) -> int | None:
        for o in self.outages:
            if o[0] > t:
                return o[0]
        return None


SLOTS = [Slot(i) for i in range(3)]
VERSIONS = [(None, T.PODS_V2134, "v2.13.4"), (DEPLOY_V2140, T.PODS_V2140, "v2.14.0"),
            (DEPLOY_V2141, T.PODS_V2141, "v2.14.1"), (ROLLBACK, T.PODS_ROLLBACK, "v2.14.0")]
RB_SWITCH = [0, 0, 0]
ROLL_SHUTDOWNS: list[tuple] = []


def build_pods() -> None:
    for s in SLOTS:
        s.gens.append((-1, T.PODS_V2134[s.idx], "v2.13.4"))
    for deploy, pods, ver in VERSIONS[1:]:
        offs = [RNG.randint(4_000, 7_000)]
        offs.append(offs[-1] + RNG.randint(7_000, 10_000))
        offs.append(offs[-1] + RNG.randint(7_000, 10_000))
        if deploy == ROLLBACK:
            offs = [RNG.randint(8_000, 11_000), RNG.randint(19_000, 23_000), 33_000 + RNG.randint(0, 900)]
        for s, off in zip(SLOTS, offs):
            sw = deploy + off
            old_pod, old_ver = s.gens[-1][1], s.gens[-1][2]
            s.gens.append((sw, pods[s.idx], ver))
            s.restarts = 0
            if deploy == ROLLBACK:
                RB_SWITCH[s.idx] = sw
            # new pod boots shortly before traffic moves; old pod receives SIGTERM
            app_log(sw - RNG.randint(1_800, 3_500), "info", pods[s.idx], ver, "server.start", port=8080,
                    node="v20.18.0", pid=1)
            ROLL_SHUTDOWNS.append((s, sw + RNG.randint(5, 40), old_pod, old_ver))

    # poison freezes
    downtime = {1: (215_000, 255_000), 2: (330_000, 390_000), 3: (380_000, 440_000)}
    ptr = 0
    for k, a in enumerate(POISON):
        chosen = None
        for j in range(3):
            s = SLOTS[(ptr + j) % 3]
            if s.state_at(a)[0] == "up":
                chosen = s
                break
        assert chosen is not None, f"no healthy pod for poison attempt {k + 1}"
        ptr = chosen.idx + 1
        kill = a + (34_620 if k == 0 else RNG.randint(26_000, 40_000))
        chosen.restarts += 1
        lo, hi = downtime[min(chosen.restarts, 3)]
        ready = kill + RNG.randint(lo, hi)
        sw = RB_SWITCH[chosen.idx]
        kill, ready = min(kill, sw), min(ready, sw)
        chosen.outages.append([a, kill, ready])

    for s, t, pod, ver in ROLL_SHUTDOWNS:
        if s.state_at(t - 50)[0] == "up":  # a crash-looping container has nothing left to log
            app_log(t, "info", pod, ver, "server.shutdown", signal="SIGTERM", reason="rolling-update")

    # lifecycle lines for liveness kills / restarts
    for s in SLOTS:
        for a, kill, ready in s.outages:
            pod, ver = s.gen_at(a)
            if kill < RB_SWITCH[s.idx]:
                app_log(kill - RNG.randint(1, 4), "warn", pod, ver, "eventloop.lag", lag_ms=kill - a - RNG.randint(0, 3))
                app_log(kill, "info", pod, ver, "server.shutdown", signal="SIGTERM", reason="liveness probe failed")
            if ready < RB_SWITCH[s.idx]:
                app_log(ready - RNG.randint(2_500, 6_000), "info", pod, ver, "server.start", port=8080,
                        node="v20.18.0", pid=1)

    # retry pressure: healthy pods lag during the incident; rare mild lag otherwise
    for s in SLOTS:
        t = RNG.randint(0, 600_000)
        while t < WEND:
            in_inc = POISON[0] <= t < RB_SWITCH[s.idx]
            if s.state_at(t)[0] == "up" and not (in_inc and False):
                pod, ver = s.gen_at(t)
                if in_inc:
                    app_log(t, "warn", pod, ver, "eventloop.lag", lag_ms=RNG.randint(140, 1900))
                    if RNG.random() < 0.3:
                        app_log(t + RNG.randint(50, 900), "warn", pod, ver, "healthz.slow",
                                duration_ms=RNG.randint(1100, 4200))
                elif RNG.random() < 0.08:
                    app_log(t, "warn", pod, ver, "eventloop.lag", lag_ms=RNG.randint(55, 140))
            t += RNG.randint(8_000, 28_000) if in_inc else RNG.randint(40_000, 120_000)


# ----------------------------------------------------------------------------------------------
NGX: list[tuple[int, int, str]] = []
_nseq = 0


def ng_log(r: dict, end: int, status: int, size: int, rt: int, urt: str) -> None:
    global _nseq
    _nseq += 1
    line = (f'{r["ip"]} - - [{ng_time(end)}] "{r["method"]} {r["path"]} HTTP/1.1" {status} {size} '
            f'"{r["ref"]}" "{r["ua"]}" rt={rt / 1000:.3f} urt={urt} rid={r["rid"]} cid={r["cid"]}')
    NGX.append((end, _nseq, line))


def fmt_s(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def process() -> None:
    rr = 0
    pending_app: list[tuple] = []
    while HEAP:
        start, _, r = heapq.heappop(HEAP)
        r["rid"] = rid()
        kind = r["kind"]
        if start < 0:
            continue
        app_lines: list[tuple] = []
        if kind == "static":
            dur = RNG.randint(0, 4)
            st = r["status"]
            end, size, urt = start + dur, (0 if st == 304 else r["size"]), "-"
        elif kind == "healthz":
            dur = RNG.randint(0, 2)
            st, end, size, urt = 200, start + dur, 2, "-"
        elif kind == "bot":
            dur = RNG.randint(0, 3)
            st, end, size, urt = 404, start + dur, 153, "-"
        elif kind == "page":
            st = r["status"]
            dur = RNG.randint(18, 160) if st == 200 else RNG.randint(8, 30)
            if st == 200 and RNG.random() < 0.0015:
                st, dur = 499, RNG.randint(900, 6000)  # impatient client hung up
            end = start + dur
            size = {200: RNG.randint(24_000, 61_000), 404: 3_214, 499: 0}[st]
            urt = fmt_s(max(dur - RNG.randint(0, 2), 0))
        else:
            # checkout-service upstream
            if kind == "poison":
                slot = next(s for s in SLOTS if any(o[0] == start for o in s.outages))
            else:
                slot = SLOTS[rr % 3]
                rr += 1
            state, o = slot.state_at(start)
            pod, ver = slot.gen_at(start)
            if kind == "poison":
                state = "frozen"
                app_log(start, "info", pod, ver, "checkout.start", r["rid"], order=r["order"],
                        customer=r["cid"], items=r["items"], gift_message_len=r["gift"])
            if state == "frozen":
                kill = o[1]
                if kill - start > TIMEOUT:
                    end = start + TIMEOUT + RNG.randint(0, 3)
                    st, size, urt = 504, 167, fmt_s(TIMEOUT + RNG.randint(0, 1))
                else:
                    end = kill + RNG.randint(0, 2)
                    st, size, urt = 502, 157, fmt_s(max(kill - start, 1))
            elif state == "down":
                dur = RNG.randint(0, 4)
                end, st, size, urt = start + dur, 502, 157, fmt_s(dur)
            else:
                incident = POISON[0] <= start < RB_SWITCH[slot.idx]
                if kind == "checkout":
                    dur = RNG.randint(80, 400) if not incident else RNG.randint(250, 1600)
                elif kind == "cart_get":
                    dur = RNG.randint(6, 45) if not incident else RNG.randint(60, 900)
                else:
                    dur = RNG.randint(12, 70) if not incident else RNG.randint(80, 1100)
                nf = slot.next_freeze_after(start)
                if nf is not None and start + dur >= nf:  # finish before the poison blocks the loop
                    dur = max(nf - start - 1, 1)
                end = start + dur
                cust = r["cid"] if r["cid"] != "-" else None
                if kind == "checkout":
                    st, size = 200, RNG.randint(170, 215)
                    f = {"order": r["order"], "customer": r["cid"], "items": r["items"]}
                    if r["gift"] is not None:
                        f["gift_message_len"] = r["gift"]
                    app_log(start + 1, "info", pod, ver, "checkout.start", r["rid"], **f)
                    done = {"order": r["order"]}
                    if ver != "v2.13.4":
                        done["duration_ms"] = dur - 2
                    done["status"] = "paid"
                    app_log(end - 1, "info", pod, ver, "checkout.done", r["rid"], **done)
                elif kind == "cart_get":
                    st, size = 200, RNG.randint(90, 2400)
                    f = {"customer": cust, "items": RNG.randint(0, 5)}
                    if ver != "v2.13.4":
                        f["duration_ms"] = dur - 1
                    app_log(end - 1, "info", pod, ver, "cart.get", r["rid"], **f)
                else:
                    st, size = 200, RNG.randint(110, 420)
                    f = {"customer": cust, "sku": f"SKU-{RNG.randint(10000, 99999)}", "qty": 1}
                    if ver != "v2.13.4":
                        f["duration_ms"] = dur - 1
                    app_log(end - 1, "info", pod, ver, "cart.add", r["rid"], **f)
                urt = fmt_s(max(dur - RNG.randint(0, 1), 0))
            # frontend / customer retries of failed checkouts
            if kind == "checkout" and st >= 500 and r["cid"] not in ("-", T.SYNTHETIC_CUSTOMER):
                left = r["retries_left"]
                if left is None:
                    left = RNG.choice([1, 1, 2, 3]) if RNG.random() < 0.6 else 0
                if left > 0:
                    nr = dict(r)
                    nr["retries_left"] = left - 1
                    add_req(end + RNG.choice([RNG.randint(1_500, 8_000), RNG.randint(10_000, 150_000)]), **{
                        k: v for k, v in nr.items() if k not in ("start", "rid")})
        if end > WEND:
            continue
        ng_log(r, end, st, size, end - start, urt)
        if kind in ("poison", "checkout", "cart_get", "cart_add"):
            REQ_RIDS.add(r["rid"])


REQ_RIDS: set[str] = set()


# ----------------------------------------------------------------------------------------------
NGINX_CONF = """\
# /etc/nginx/conf.d/shipfast.conf  (excerpt, edge-01)
# Note: $time_local is rendered in the server timezone (UTC) and marks the moment
# the response was finished (i.e. request END time), not when it started.

log_format shipfast '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent" rt=$request_time '
                    'urt=$upstream_response_time rid=$request_id cid=$http_x_customer_id';

access_log /var/log/nginx/access.log shipfast;

upstream checkout_service {
    # one entry per checkout pod (endpoints synced by the ingress controller)
    server checkout-0.checkout.shipfast.svc.cluster.local:8080;
    server checkout-1.checkout.shipfast.svc.cluster.local:8080;
    server checkout-2.checkout.shipfast.svc.cluster.local:8080;
    keepalive 32;
}

upstream web_frontend {
    server web.shipfast.svc.cluster.local:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name shipfast.example;

    proxy_set_header X-Request-Id $request_id;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_connect_timeout 2s;
    proxy_read_timeout    30s;
    proxy_send_timeout    30s;

    location = /healthz {
        access_log /var/log/nginx/access.log shipfast;
        return 200 "ok";
    }

    location /static/ {
        root /srv/shipfast;
        expires 30d;
    }

    location = /favicon.ico {
        root /srv/shipfast/static;
    }

    location /api/cart {
        proxy_pass http://checkout_service;
    }

    location = /api/checkout {
        # POST is not idempotent: nginx will not retry it on another upstream
        proxy_pass http://checkout_service;
    }

    location / {
        proxy_pass http://web_frontend;
    }
}
"""


# ----------------------------------------------------------------------------------------------
NG_RE = re.compile(r'^(\S+) - - \[(\d\d)/(\w+)/(\d{4}):(\d\d:\d\d:\d\d) \+0000\] "(\S+) (\S+) HTTP/1\.1" (\d{3}) (\d+) '
                   r'"[^"]*" "[^"]*" rt=(\S+) urt=(\S+) rid=([0-9a-f]{32}) cid=(\S+)$')


def main() -> None:
    gen_traffic()
    build_pods()
    process()
    NGX.sort()
    APP.sort()

    nginx_dir = T.EVIDENCE_DIR / "nginx"
    app_dir = T.EVIDENCE_DIR / "app"
    nginx_dir.mkdir(parents=True, exist_ok=True)
    app_dir.mkdir(parents=True, exist_ok=True)
    T.TRUTH_DIR.mkdir(parents=True, exist_ok=True)
    access = nginx_dir / "access.log"
    applog = app_dir / "checkout-service.log"
    access.write_text("\n".join(l for _, _, l in NGX) + "\n")
    applog.write_text("\n".join(l for _, _, l in APP) + "\n")
    (nginx_dir / "nginx.conf.snippet").write_text(NGINX_CONF)

    # ---- parse back the produced files (truth comes from the files, not internal state)
    first_5xx = None
    q6: set[str] = set()
    checkout_5xx = 0
    total = 0
    nginx_rids: set[str] = set()
    prev = ""
    inc_total = inc_fail = 0
    last_5xx = None
    for line in access.read_text().splitlines():
        m = NG_RE.match(line)
        assert m, line
        total += 1
        ts, method, path, status, cid = m.group(5), m.group(6), m.group(7), int(m.group(8)), m.group(13)
        assert ts >= prev, f"nginx not sorted at {line}"
        prev = ts
        nginx_rids.add(m.group(12))
        if 500 <= status <= 599:
            if first_5xx is None:
                first_5xx = (ts, cid)
            last_5xx = ts
            if method == "POST" and path == "/api/checkout":
                checkout_5xx += 1
                if cid not in ("-", T.SYNTHETIC_CUSTOMER):
                    q6.add(cid)
        if path.startswith("/api/") and "01:13:14" <= ts <= "01:40:20":
            inc_total += 1
            inc_fail += status >= 500

    poison_start = poison_done = 0
    prev = ""
    app_lines = 0
    for line in applog.read_text().splitlines():
        rec = json.loads(line)
        app_lines += 1
        assert rec["ts"] >= prev, f"app log not sorted at {line}"
        prev = rec["ts"]
        if "rid" in rec:
            assert rec["rid"] in nginx_rids, f"app rid missing from nginx: {line}"
        if rec.get("order") == T.POISON_ORDER:
            poison_start += rec["msg"] == "checkout.start"
            poison_done += rec["msg"] == "checkout.done"

    assert first_5xx == (T.FIRST_5XX.strftime("%H:%M:%S"), T.POISON_CUSTOMER), first_5xx
    assert poison_start == 9 and poison_done == 0, (poison_start, poison_done)

    truth = {
        "first_5xx_utc": first_5xx[0],
        "poison_attempts": poison_start,
        "q6_unique_customers": len(q6),
        "total_nginx_lines": total,
        "checkout_5xx_count": checkout_5xx,
        "last_5xx_utc": last_5xx,
        "app_log_lines": app_lines,
    }
    (T.TRUTH_DIR / "logs.json").write_text(json.dumps(truth, indent=2) + "\n")

    print(f"nginx/access.log          {total:>7} lines  {access.stat().st_size / 1e6:.1f} MB")
    print(f"app/checkout-service.log  {app_lines:>7} lines  {applog.stat().st_size / 1e6:.1f} MB")
    print(f"incident /api failure rate (01:13:14-01:40:20): {inc_fail}/{inc_total} = {inc_fail / max(inc_total, 1):.0%}")
    print("truth:", json.dumps(truth))


if __name__ == "__main__":
    main()
