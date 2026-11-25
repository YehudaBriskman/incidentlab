#!/usr/bin/env python3
"""Generate supporting evidence for case `3am-outage`.

Writes (under timeline.EVIDENCE_DIR):
  metrics/checkout_metrics.csv   15s rows, unix epoch seconds
  db/postgresql-slow.log         postgres slow log, UTC
  deploys/deploys.log            deploy history, UTC ISO-8601 Z (SHAs from build/truth/repo.json)
  slack/inc-checkout.json        Slack-like export, epoch-string ts
  README_FIRST.txt               player briefing

Python 3 stdlib only. Deterministic (random.Random(SEED + 1)). Idempotent. Run from the repo root:
    python3 generator/gen_support.py
"""
from __future__ import annotations

import csv
import json
import math
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import timeline as T  # noqa: E402

RNG = random.Random(T.SEED + 1)
# one independent sub-seed per artifact, so editing one generator doesn't reshuffle the others
SUB_SEEDS = {k: RNG.getrandbits(64) for k in ("metrics", "slowlog", "deploys", "slack")}
OUT = T.EVIDENCE_DIR


def epoch(dt: datetime) -> float:
    return dt.timestamp()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# 1. metrics
# ---------------------------------------------------------------------------
def gen_metrics() -> int:
    rng = random.Random(SUB_SEEDS["metrics"])
    start = int(epoch(T.WINDOW_START))
    end = int(epoch(T.WINDOW_END))
    inc_start = epoch(T.INCIDENT_START)
    first_5xx = epoch(T.FIRST_5XX)
    rollback = epoch(T.ROLLBACK)
    last_5xx = epoch(T.LAST_5XX_APPROX)
    deploys = [epoch(T.DEPLOY_V2140), epoch(T.DEPLOY_V2141)]

    # Restart events: one per poison attempt (liveness kill ~35-45s later) plus a few extra
    # kills of pods that were starved / re-poisoned by retries while still warming up.
    restart_times = [epoch(a) + rng.uniform(33, 46) for a in T.POISON_ATTEMPTS]
    for _ in range(6):
        restart_times.append(rng.uniform(inc_start + 120, rollback - 20))
    restart_times.sort()

    rows = []
    restarts = 0
    for ts in range(start, end + 1, 15):
        restarts = sum(1 for r in restart_times if r <= ts)
        t_h = (ts - start) / 3600.0
        # gentle curve: declining traffic through the night with a small bump
        base_rps = 3.4 - 0.9 * t_h / 2.5 + 0.35 * math.sin(t_h * 2.3)
        rps = base_rps + rng.uniform(-0.25, 0.25)
        pods = 3
        cpu = rng.uniform(15, 35)
        lag = rng.uniform(5, 20)
        p99 = rng.uniform(150, 400)
        err = rng.choice([0.0, 0.0, 0.0, rng.uniform(0.0, 0.004)])

        # rolling deploy blips (new ReplicaSet coming up)
        for d in deploys:
            if d <= ts < d + 30:
                pods = 2
                cpu = rng.uniform(35, 48)
                p99 = rng.uniform(380, 620)

        if inc_start <= ts < rollback:
            cpu = 100.0 if rng.random() < 0.85 else rng.uniform(91, 99.5)
            lag = rng.uniform(2000, 30000)
            if ts < first_5xx:
                # pod frozen, nginx still waiting on the upstream
                pods = 2
                lag = (ts - inc_start) * 1000 + rng.uniform(0, 400)
                p99 = rng.uniform(9000, 20000)
                err = rng.uniform(0.0, 0.004)
            else:
                pods = rng.choice([0, 1, 1, 1, 2, 2])
                p99 = rng.uniform(29800, 30010)
                err = rng.uniform(0.55, 0.85)
            rps = base_rps * rng.uniform(1.15, 1.6)  # client retries inflate rps
        elif rollback <= ts < last_5xx + 15:
            pods = 1 if ts < rollback + 15 else 2
            cpu = rng.uniform(40, 70)
            lag = rng.uniform(20, 120)
            p99 = rng.uniform(4000, 30000)
            err = rng.uniform(0.15, 0.45) if ts < rollback + 20 else rng.uniform(0.02, 0.12)
            rps = base_rps * rng.uniform(1.2, 1.5)
        elif last_5xx + 15 <= ts < last_5xx + 300:
            # retry wave after recovery
            rps = base_rps * rng.uniform(1.25, 1.6)
            cpu = rng.uniform(30, 45)
            p99 = rng.uniform(300, 650)

        rows.append([ts, pods, f"{cpu:.1f}", f"{lag:.1f}", f"{p99:.0f}", f"{rps:.2f}", f"{err:.3f}", restarts])

    path = OUT / "metrics" / "checkout_metrics.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ts_epoch", "pods_ready", "cpu_pct_max", "eventloop_lag_p99_ms", "http_p99_ms",
                    "rps", "error_rate", "restarts_total"])
        w.writerows(rows)
    return len(rows)


# ---------------------------------------------------------------------------
# 2. postgres slow log
# ---------------------------------------------------------------------------
REPORT_QUERIES = [
    "SELECT date_trunc('hour', created_at) AS h, count(*), sum(total_cents) FROM orders "
    "WHERE created_at >= now() - interval '7 days' GROUP BY 1 ORDER BY 1;",
    "SELECT p.id, p.slug, p.title, ts_rank(p.search_vec, q) AS rank FROM products p, "
    "plainto_tsquery('english', $1) q WHERE p.search_vec @@ q ORDER BY rank DESC LIMIT 48;",
    "SELECT c.id, count(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id "
    "WHERE c.created_at >= $1 GROUP BY c.id HAVING count(o.id) = 0;",
    "SELECT oi.product_id, sum(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id "
    "WHERE o.created_at >= $1 GROUP BY oi.product_id ORDER BY 2 DESC LIMIT 100;",
]
CHECKOUT_QUERIES = [
    "INSERT INTO orders (id, customer_id, cart_id, total_cents, currency, gift_message, status, created_at) "
    "VALUES ($1, $2, $3, $4, 'USD', $5, 'pending', now()) RETURNING id;",
    "UPDATE carts SET status = 'checked_out', updated_at = now() WHERE id = $1 AND customer_id = $2;",
    "INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) "
    "SELECT $1, ci.product_id, ci.qty, p.price_cents FROM cart_items ci JOIN products p ON p.id = ci.product_id "
    "WHERE ci.cart_id = $2;",
    "SELECT id, qty, product_id FROM cart_items WHERE cart_id = $1 FOR UPDATE;",
]
COPY_TABLES = [
    ("customers", "id, email, name, created_at, updated_at", 31_000),
    ("products", "id, slug, title, price_cents, stock, search_vec, updated_at", 9_000),
    ("carts", "id, customer_id, status, created_at, updated_at", 88_000),
    ("orders", "id, customer_id, cart_id, total_cents, currency, gift_message, status, created_at", 312_000),
    ("order_items", "order_id, product_id, qty, unit_price_cents", 419_000),
    ("payments", "id, order_id, provider, provider_ref, amount_cents, status, created_at", 186_000),
]


def pg_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d} UTC"


def gen_slowlog() -> int:
    rng = random.Random(SUB_SEEDS["slowlog"])
    events: list[tuple[datetime, str]] = []
    app_pids = [4412, 4418, 4431, 4437, 4450, 4463, 4471, 4489]
    t0 = T.WINDOW_START

    def at(seconds: float) -> datetime:
        return t0 + timedelta(seconds=seconds)

    def stmt(dt: datetime, pid: int, ms: float, sql: str) -> None:
        events.append((dt, f"[{pid}] LOG:  duration: {ms:.3f} ms  statement: {sql}"))

    backup_s = (T.BACKUP_START - t0).total_seconds()
    backup_e = (T.BACKUP_END - t0).total_seconds()
    gap_s = (T.INCIDENT_START - t0).total_seconds() + 20
    gap_e = (T.LAST_5XX_APPROX - t0).total_seconds() + 5
    end_s = (T.WINDOW_END - t0).total_seconds()

    # sparse background before the backup
    s = 90.0
    while s < backup_s:
        s += rng.uniform(240, 600)
        if s >= backup_s:
            break
        if rng.random() < 0.7:
            stmt(at(s), rng.choice(app_pids), rng.uniform(510, 1400), rng.choice(REPORT_QUERIES))
        else:
            stmt(at(s), rng.choice(app_pids), rng.uniform(505, 720), rng.choice(CHECKOUT_QUERIES))

    # backup session
    bpid = 5127
    events.append((T.BACKUP_START - timedelta(milliseconds=7),
                   f"[{bpid}] LOG:  connection received: host=10.42.3.17 port=51544"))
    events.append((T.BACKUP_START,
                   f"[{bpid}] LOG:  connection authorized: user=backup database=shipfast application_name=pg_dump"))
    span = backup_e - backup_s - 25
    total_rows = sum(r for _, _, r in COPY_TABLES)
    cursor = backup_s + 4
    for name, cols, nrows in COPY_TABLES:
        dur = span * nrows / total_rows
        cursor += dur
        stmt(at(cursor), bpid, dur * 1000 + rng.uniform(0, 900), f"COPY public.{name} ({cols}) TO stdout;")
    sess = T.BACKUP_END - T.BACKUP_START
    mm, ss = divmod(sess.total_seconds(), 60)
    events.append((T.BACKUP_END,
                   f"[{bpid}] LOG:  disconnection: session time: 0:{int(mm):02d}:{ss:06.3f} "
                   f"user=backup database=shipfast host=10.42.3.17 port=51544"))

    # cluster of slow app queries during backup, before the incident (looks guilty)
    s = backup_s + 22
    while s < gap_s:
        s += rng.uniform(8, 30)
        if s >= gap_s:
            break
        sql = rng.choice(CHECKOUT_QUERIES + CHECKOUT_QUERIES + REPORT_QUERIES)
        stmt(at(s), rng.choice(app_pids), rng.uniform(600, 3400), sql)

    # during the incident: only a couple of non-checkout report/search queries (the gap)
    s = gap_s
    while s < gap_e:
        s += rng.uniform(300, 520)
        if s >= gap_e:
            break
        stmt(at(s), rng.choice(app_pids), rng.uniform(560, 1900), rng.choice(REPORT_QUERIES[:2]))

    # retry wave right after recovery
    s = gap_e + 1
    for _ in range(9):
        s += rng.uniform(1.5, 9)
        stmt(at(s), rng.choice(app_pids), rng.uniform(502, 880), rng.choice(CHECKOUT_QUERIES[:2]))
    # normal sparse afterwards
    while s < end_s:
        s += rng.uniform(200, 520)
        if s >= end_s:
            break
        q = rng.choice(CHECKOUT_QUERIES) if rng.random() < 0.5 else rng.choice(REPORT_QUERIES)
        stmt(at(s), rng.choice(app_pids), rng.uniform(505, 1100), q)

    # checkpoints every 15 min (checkpoint_timeout = 15min)
    cpid = 61
    for k in range(0, 10):
        cs = at(k * 900 + 13)
        heavy = backup_s <= k * 900 + 13 <= backup_e
        nbuf = rng.randint(2100, 4800) if heavy else rng.randint(180, 1300)
        write_s = rng.uniform(80, 150) if heavy else rng.uniform(20, 70)
        events.append((cs, f"[{cpid}] LOG:  checkpoint starting: time"))
        pct = nbuf / 16384 * 100
        events.append((cs + timedelta(seconds=write_s + 0.4),
                       f"[{cpid}] LOG:  checkpoint complete: wrote {nbuf} buffers ({pct:.1f}%); "
                       f"0 WAL file(s) added, 0 removed, {rng.randint(0, 3)} recycled; "
                       f"write={write_s:.3f} s, sync=0.0{rng.randint(10, 99)} s, total={write_s + 0.1:.3f} s"))

    events.sort(key=lambda e: e[0])
    lines = [f"{pg_ts(dt)} {msg}" for dt, msg in events]
    write_text(OUT / "db" / "postgresql-slow.log", "\n".join(lines) + "\n")
    return len(lines)


# ---------------------------------------------------------------------------
# 3. deploys
# ---------------------------------------------------------------------------
def load_shas() -> dict[str, str]:
    fallback = {"decoy_commit_sha7": "0000000", "bad_commit_sha7": "1111111", "prev_commit_sha7": "2222222"}
    path = T.TRUTH_DIR / "repo.json"
    data: dict[str, object] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except json.JSONDecodeError:
            pass
    else:
        print(f"WARNING: {path} not found; using placeholder SHAs (run build_repo.py first)")
    out = {}
    for key, fb in fallback.items():
        val = data.get(key)
        if isinstance(val, str) and len(val) == 7:
            out[key] = val
        else:
            if path.exists():
                print(f"WARNING: {path} has no valid '{key}'; using placeholder {fb}")
            out[key] = fb
    return out


def gen_deploys() -> int:
    rng = random.Random(SUB_SEEDS["deploys"])
    shas = load_shas()

    def sha() -> str:
        return "".join(rng.choice("0123456789abcdef") for _ in range(7))

    d = lambda day, h, m, s: T.utc(h, m, s, day=day)  # noqa: E731
    entries = [
        (d(10, 7, 14, 52), "DEPLOY", "web", "v3.41.0", sha(), "maya.r", "success", ""),
        (d(10, 9, 3, 18), "DEPLOY", "search", "v1.18.2", sha(), "yossi.b", "success", ""),
        (d(10, 12, 47, 5), "DEPLOY", "checkout", "v2.13.3", sha(), "yossi.b", "success", ""),
        (d(10, 14, 20, 41), "DEPLOY", "payments", "v5.1.3", sha(), "lior.m", "success", ""),
        (d(10, 14, 31, 9), "ROLLBACK", "payments", "v5.1.2", sha(), "lior.m", "success",
         'reason="provider sandbox creds in prod config"'),
        (d(11, 8, 2, 37), "DEPLOY", "web", "v3.41.1", sha(), "maya.r", "success", ""),
        (d(11, 10, 26, 14), "DEPLOY", "checkout", "v2.13.4", shas["prev_commit_sha7"], "amir.t", "success", ""),
        (d(11, 13, 55, 0), "DEPLOY", "search", "v1.19.0", sha(), "yossi.b", "failed",
         'reason="readiness timeout, auto-reverted"'),
        (d(11, 15, 12, 46), "DEPLOY", "search", "v1.19.0", sha(), "yossi.b", "success", ""),
        (d(12, 7, 48, 21), "DEPLOY", "payments", "v5.1.4", sha(), "lior.m", "success", ""),
        (d(12, 11, 9, 33), "DEPLOY", "web", "v3.42.0", sha(), "maya.r", "success", ""),
        (d(12, 16, 40, 2), "DEPLOY", "search", "v1.19.1", sha(), "yossi.b", "success", ""),
        (T.DEPLOY_V2140, "DEPLOY", "checkout", "v2.14.0", shas["decoy_commit_sha7"], "dana.k", "success", ""),
        (T.DEPLOY_V2141, "DEPLOY", "checkout", "v2.14.1", shas["bad_commit_sha7"], "dana.k", "success", ""),
        (T.PAYMENTS_DEPLOY, "DEPLOY", "payments", "v5.2.0", "9e1c0d2", "lior.m", "success", ""),
        (T.ROLLBACK, "ROLLBACK", "checkout", "v2.14.0", shas["decoy_commit_sha7"], "amir.t", "success",
         'reason="checkout 5xx, INC-2291"'),
    ]
    entries.sort(key=lambda e: e[0])
    lines = []
    for dt, kind, svc, ver, commit, author, status, extra in entries:
        line = (f"{dt.strftime('%Y-%m-%dT%H:%M:%SZ')} {kind:<8} {'service=' + svc:<17} "
                f"{'version=' + ver:<16} commit={commit} {'author=' + author:<14} status={status}")
        if extra:
            line += f" {extra}"
        lines.append(line)
    write_text(OUT / "deploys" / "deploys.log", "\n".join(lines) + "\n")
    return len(lines)


# ---------------------------------------------------------------------------
# 4. slack
# ---------------------------------------------------------------------------
LAG_PASTE = (
    "pasting from one of the pods right before it got killed:\n"
    "```{\"ts\":\"2026-11-13T03:25:21.433+02:00\",\"level\":\"warn\",\"svc\":\"checkout\","
    "\"version\":\"v2.14.1\",\"msg\":\"eventloop.lag\",\"lag_ms\":22702}```\n"
    "no stack, nothing else from that pod for 20s+"
)

SLACK = [
    # (utc h, m, s, user, text)
    (1, 15, 45, "pagerbot", ":rotating_light: [FIRING] checkout-service error_rate > 20% (INC-2291)\n"
                            "Severity: SEV2 | On-call: amir.t | Runbook: checkout/5xx"),
    (1, 16, 21, "amir.t", "ack. lookin"),
    (1, 17, 2, "amir.t", "nginx is full of 504s and 502s on /api/checkout and /api/cart*. products + static are fine"),
    (1, 17, 40, "amir.t", "@here checkout is mostly down. errors since ~3:13 on the dashboard"),
    (1, 18, 9, "noa.s", "just got the page. how bad? are customers actually affected or just the synthetic?"),
    (1, 18, 44, "amir.t", "real customers. error rate 60-70%. some orders go thru, most dont"),
    (1, 19, 15, "dana.k", "here. I shipped 2.14.1 just before 3, but my change is tiny, just input validation"),
    (1, 19, 52, "amir.t", "noted. and 2.14.0 went out at 2:40 too?"),
    (1, 20, 18, "dana.k", "yeah both mine. 2.14.0 is literally a logger bump + a duration field"),
    (1, 20, 49, "lior.m", "fyi payments v5.2.0 is rolling rn, it was scheduled. want me to stop it?"),
    (1, 21, 14, "amir.t", "its already going, let it finish. just watch your dashboards"),
    (1, 21, 50, "lior.m", "done. payments error rate 0 on my side"),
    (1, 22, 27, "noa.s", "isn't the DB backup running now? this happened before"),
    (1, 22, 58, "noa.s", "the pg_dump thing from march, checkout was slow for an hour"),
    (1, 23, 36, "dana.k", "+1, slow query log is lighting up since 3:05. thats exactly when teh backup kicks off"),
    (1, 24, 12, "amir.t", "checking db"),
    (1, 25, 31, "amir.t", "hmm. DB CPU is ~20%, connections are actually DOWN vs an hour ago. if the db was "
                          "the bottleneck i'd expect conns piling up, not dropping"),
    (1, 25, 57, "amir.t", "also the backup has run nightly for 2 years. march was a different thing (missing index)"),
    (1, 27, 8, "amir.t", "checkout pods keep getting killed by liveness, CPU pinned at 100 though"),
    (1, 27, 39, "amir.t", "restart count keeps climbing. pods come back, look fine for a bit, then die again"),
    (1, 28, 16, "dana.k", "100% cpu while the db is idle?? what is it even doing"),
    (1, 29, 3, "amir.t", LAG_PASTE),
    (1, 29, 41, "lior.m", "I deployed payments at 01:20 but errors started before that"),
    (1, 30, 33, "noa.s", "ETA? support is asking what to tell people"),
    (1, 31, 0, "amir.t", "no ETA yet. leaning towards rollback"),
    (1, 31, 37, "dana.k", "rollback to what tho. if its the logger thing from 2.14.0 we need to go all the way to 2.13.4"),
    (1, 32, 14, "amir.t", "errors started 3:13. 2.14.0 was out for half an hour with zero errors"),
    (1, 32, 49, "dana.k", "and 2.14.1 was out 15 min with zero errors too. neither fits"),
    (1, 33, 25, "amir.t", "unless its something that only hits on specific requests"),
    (1, 34, 1, "noa.s", "can we just go back to 2.13.4 to be safe?"),
    (1, 34, 46, "amir.t", "2.13.4 also reverts the logger format and the log pipeline expects duration_ms now. "
                          "messier. 2.14.0 is one step back and it was clean"),
    (1, 35, 29, "dana.k", "ugh fine. I really dont see how a validation change pins a CPU tho"),
    (1, 36, 3, "amir.t", "me neither. lets find out after, not at 3am"),
    (1, 36, 48, "noa.s", "support: a customer emailed that she tried to pay \"like 6 times\" and its her sisters birthday"),
    (1, 37, 20, "amir.t", "great, someone owes her a coupon"),
    (1, 37, 55, "lior.m", "and a cake"),
    (1, 38, 34, "amir.t", "ok doing it. rolling checkout back to v2.14.0"),
    (1, 38, 51, "dana.k", "go"),
    (1, 40, 2, "amir.t", "rollback triggered, pods rolling"),
    (1, 40, 47, "amir.t", "3/3 ready on 2.14.0"),
    (1, 41, 36, "amir.t", "error rate dropping. synthetic green again"),
    (1, 43, 8, "amir.t", "recovered. last 5xx i can see is ~3:40"),
    (1, 43, 41, "pagerbot", ":white_check_mark: [RESOLVED] checkout-service error_rate > 20% (INC-2291)"),
    (1, 44, 19, "noa.s", "nice work. so what was it?"),
    (1, 45, 2, "amir.t", "honestly no idea yet. rollback fixed it so something in 2.14.1 i guess"),
    (1, 45, 44, "dana.k", "or something it tripped over. sorry everyone :grimacing:"),
    (1, 46, 31, "noa.s", "no blame. RCA due Monday, someone figure out WHY. i want the actual mechanism, not \"we rolled back\""),
    (1, 49, 38, "noa.s", "and nobody touches the backup schedule unless the RCA says so"),
    (1, 51, 40, "amir.t", "going to sleep. whoever picks this up monday, the exports are in the evidence pack"),
    (1, 52, 6, "dana.k", "night all. sorry for the typos, its 4am"),
    # next morning
    (7, 2, 15, "noa.s", "morning. thanks again amir + dana. follow-up engineer owns the RCA: timeline, trigger, root cause, fix"),
    (7, 19, 44, "dana.k", "fwiw all the unit tests for 2.14.1 passed. happy to pair on it"),
    (7, 33, 9, "amir.t", "heads up for whoever does the timeline: double check your clocks when lining up the exports"),
]


def gen_slack() -> int:
    rng = random.Random(SUB_SEEDS["slack"])
    msgs = []
    for h, m, s, user, text in SLACK:
        dt = T.utc(h, m, s)
        ts = f"{int(epoch(dt))}.{rng.randint(100, 999999):06d}"
        msgs.append({"ts": ts, "user": user, "text": text})
    write_text(OUT / "slack" / "inc-checkout.json", json.dumps(msgs, indent=2, ensure_ascii=False) + "\n")
    return len(msgs)


# ---------------------------------------------------------------------------
# 5. README
# ---------------------------------------------------------------------------
README = """\
SHIPFAST // INCIDENT INC-2291 // FOLLOW-UP PACK
================================================

It's Monday morning. You're the follow-up engineer for last week's incident.

On the night of Thursday into Friday, 13 November 2026, the checkout service at
Shipfast fell over in the middle of the night. Customers couldn't pay, pagers
went off, and after about half an hour the on-call engineer rolled back and
things recovered. Everyone went back to bed.

Nobody actually knows WHY it broke. The rollback fixed it, but "we rolled back"
isn't a root cause. Your manager wants an RCA, and the team has handed you
everything they exported that night.

Your job: rebuild what really happened, from the evidence, not from what people
thought at 3 AM. The questions you need to answer are on the IncidentLab site.


WHAT'S IN THE PACK
------------------
README_FIRST.txt                 this file
nginx/access.log                 edge access log for shipfast.example (every request)
nginx/nginx.conf.snippet         the log format and proxy timeouts, so you can read the log
app/checkout-service.log         checkout-service application logs (JSON lines, all pods)
metrics/checkout_metrics.csv     checkout-service dashboard export, one row per 15 seconds
db/postgresql-slow.log           Postgres slow-query log (statements over 500 ms)
deploys/deploys.log              deploy history for the last few days, all services
slack/inc-checkout.json          export of the #inc-checkout channel from that night
repo/git-log.txt                 full history of the checkout-service code, with diffs (plain text)
repo/shipfast-checkout.bundle    the same history as a git bundle (optional, needs git)


HOW TO READ THE CODE HISTORY
----------------------------
repo/git-log.txt is the whole history (`git log -p --decorate --all`) as plain
text: every commit, its tags, its message and its diff. Read it with grep,
awk or any editor; you don't need git. If you happen to have git anyway, the
bundle clones to the same history:
    git clone repo/shipfast-checkout.bundle shipfast-checkout


TIPS
----
- Nothing needs installing. The tools already on your machine (grep, awk, sed,
  sort, uniq on Linux, macOS or Git Bash; Select-String and friends in Windows
  PowerShell) are enough to solve every question.
- People in the Slack channel were tired and guessing. Some of them were wrong.
- Note: our systems don't all agree on what time it is.

Good luck. Write it up so it never happens again.
"""


def gen_readme() -> None:
    write_text(OUT / "README_FIRST.txt", README)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    n_metrics = gen_metrics()
    n_slow = gen_slowlog()
    n_dep = gen_deploys()
    n_slack = gen_slack()
    gen_readme()
    print(f"gen_support: metrics={n_metrics} rows, slowlog={n_slow} lines, deploys={n_dep} lines, "
          f"slack={n_slack} msgs, README written -> {OUT}")


if __name__ == "__main__":
    main()
