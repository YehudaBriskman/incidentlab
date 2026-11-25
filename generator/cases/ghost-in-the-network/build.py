#!/usr/bin/env python3
"""Build the evidence pack and truth file for IncidentLab case `ghost-in-the-network`.

Run from anywhere:  python3 generator/cases/ghost-in-the-network/build.py

Stdlib only, fixed seed, deterministic, idempotent. Story and answers: docs/cases/ghost-in-the-network.md.
Internally, simulated times are integer milliseconds since WINDOW_START (UTC).
"""
from __future__ import annotations

import csv
import io
import json
import random
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import packets as P  # noqa: E402
import timeline as T  # noqa: E402

RNG = random.Random(T.SEED)
W0 = T.WINDOW_START
WEND = int((T.WINDOW_END - W0).total_seconds() * 1000)
EV = T.EVIDENCE_DIR

BIG_MIN = 2400        # no request sizes between the small max and this, so the threshold is unambiguous
SMALL_MAX = 1100


class BuildError(Exception):
    pass


def jd(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"))


def ms_of(dt: datetime) -> int:
    return int(round((dt - W0).total_seconds() * 1000))


def dt_of(ms: int) -> datetime:
    return W0 + timedelta(milliseconds=ms)


def local_iso(ms: int) -> str:
    d = T.to_local(dt_of(ms))
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}+02:00"


def nginx_time(ms: int) -> str:
    return dt_of(ms).strftime("%d/%b/%Y:%H:%M:%S +0000")


def syslog_time(dt: datetime) -> str:
    return dt.strftime("%b %d %H:%M:%S")


def write(rel: str, text: str) -> Path:
    p = EV / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


# ============================================================================== client simulation
HARDEN = {h: ms_of(t) for h, t in T.HARDEN_APPLIED.items()}
ROLLBACK = {h: ms_of(t) for h, t in T.ICMP_ROLLBACK.items()}
FLUSH = {h: ms_of(t) for h, t in T.DNS_FLUSH.items()}
BH_START = {h: ms_of(t) for h, t in T.PMTU_EXPIRES.items()}
for _h in T.STALE_HOSTS:
    BH_START[_h] = FLUSH[_h]         # never learned a PMTU for the new address
DEPLOY_A, DEPLOY_B = ms_of(T.LEDGER_DEPLOY_START), ms_of(T.LEDGER_DEPLOY_END)

# retransmission offsets (ms after app data starts) for which the gateway sends ICMP
HANG_ICMP_OFFSETS = [20.9 + 0.012 * i for i in range(6)] + [20.66 + 206 * (2 ** (k + 1) - 1) + 0.24
                                                            for k in range(2, 7)]


def resolved_addr(host: str, t: int) -> str:
    if host in T.STALE_HOSTS and t < FLUSH[host]:
        return T.OLD_LEDGER_IP
    return T.NEW_LEDGER_IP


def pick_request(rng: random.Random) -> dict:
    r = rng.random()
    if r < 0.35:
        return dict(method="GET", path="/v1/health", req=rng.randint(182, 214), resp=rng.randint(48, 52),
                    srv=rng.uniform(0.8, 3.0), status=200)
    if r < 0.60:
        return dict(method="POST", path="/v1/scans", req=rng.randint(420, 1080), resp=rng.randint(92, 140),
                    srv=rng.uniform(7, 26), status=201)
    if r < 0.75:
        resp = int(min(420000, max(18000, rng.lognormvariate(11.2, 0.8))))
        since = 1795400000 + rng.randrange(0, 90000)
        return dict(method="GET", path=f"/v1/manifests?since={since}", req=rng.randint(262, 330), resp=resp,
                    srv=rng.uniform(30, 90) + resp / 60000, status=200)
    if r < 0.95:
        req = int(min(180000, max(BIG_MIN, rng.lognormvariate(9.9, 0.9))))
        return dict(method="POST", path="/v1/manifests", req=req, resp=rng.randint(110, 160),
                    srv=rng.uniform(25, 110) + req / 40000, status=201)
    mf = f"MF-{rng.randrange(36 ** 6):06X}"[:9]
    return dict(method="PUT", path=f"/v1/manifests/{mf}/status", req=rng.randint(300, 480),
                resp=rng.randint(58, 64), srv=rng.uniform(4, 15), status=204)


def simulate() -> dict:
    app_lines: list[tuple[int, str, str]] = []      # (ms, host, json)
    ingress: list[tuple[int, str]] = []
    icmp_events: list[dict] = []                     # firewall-log material
    stats = {"hang_hosts": set(), "stale_hosts": set(), "first_hang": None, "first_hang_host": None,
             "pinned": {}}
    pinned_large = ms_of(T.CAPTURE_LARGE)
    pinned_small = ms_of(T.CAPTURE_SMALL)
    pinned_stale = ms_of(T.CAPTURE_STALE)

    for host in T.HOST_NAMES:
        hrng = random.Random(f"{T.SEED}-{host}")
        ip = T.HOST_IP[host]
        events = []
        t = hrng.randrange(0, 4000)
        while t < WEND - 31000:
            events.append((t, None))
            t += int(hrng.expovariate(1 / 4000)) + 40
        if host == "app-03":
            events += [(pinned_small, "small"), (pinned_large, "large")]
        if host == "app-05":
            events.append((pinned_stale, "stale"))
        events.sort(key=lambda e: (e[0], e[1] or ""))
        relearned_after_rollback = False
        seq = 0
        for t, pin in events:
            seq += 1
            req = pick_request(hrng)
            if pin == "small":
                req = dict(method="POST", path="/v1/scans", req=712, resp=118, srv=11.4, status=201)
            elif pin == "large":
                req = dict(method="POST", path="/v1/manifests", req=18734, resp=131, srv=40.0, status=201)
            elif pin == "stale":
                req = dict(method="GET", path="/v1/health", req=196, resp=50, srv=1.0, status=200)
            rid = f"ms-{hrng.getrandbits(48):012x}"
            sport = hrng.randrange(32768, 61000)
            if pin == "large":
                sport = 48812
            elif pin == "small":
                sport = 48790
            elif pin == "stale":
                sport = 51522
            peer = resolved_addr(host, t)
            base = {"ts": None, "level": "info", "host": host, "svc": "manifest-sync", "msg": "",
                    "req_id": rid, "method": req["method"], "path": req["path"], "req_bytes": req["req"],
                    "peer": peer}
            if peer == T.OLD_LEDGER_IP:
                stats["stale_hosts"].add(host)
                if t < HARDEN[host]:
                    dur = 3000 + hrng.randrange(5, 60)
                    err = f"connect EHOSTUNREACH {peer}:443"
                else:
                    dur = T.CONNECT_TIMEOUT_MS + hrng.randrange(0, 4)
                    err = f"connect ETIMEDOUT {peer}:443 (timeout {T.CONNECT_TIMEOUT_MS}ms)"
                    for off in (3009.6, 4012.2):
                        icmp_events.append(dict(host=host, t=t + off, type=3, code=1, sport=sport,
                                                dst=peer, inner_len=60, inner_flags="SYN",
                                                ip_id=hrng.randrange(1, 65535)))
                rec = {**base, "level": "error", "msg": "ledger request failed", "phase": "connect",
                       "error": err, "duration_ms": dur}
                if pin == "stale":
                    stats["pinned"]["stale"] = rid
                app_lines.append((t + dur, host, jd({**rec, "ts": local_iso(t + dur)})))
                continue
            big = req["req"] > T.SEG_PAYLOAD_LIMIT
            in_bh = BH_START.get(host, 10 ** 12) <= t < ROLLBACK[host]
            if big and in_bh and t + 27000 < ROLLBACK[host]:
                dur = T.CLIENT_TIMEOUT_MS + hrng.randrange(1, 9)
                if pin == "large":
                    dur = T.CLIENT_TIMEOUT_MS + 6
                rec = {**base, "level": "error", "msg": "ledger request failed", "phase": "response",
                       "error": f"timeout awaiting response after {T.CLIENT_TIMEOUT_MS}ms", "duration_ms": dur}
                app_lines.append((t + dur, host, jd({**rec, "ts": local_iso(t + dur)})))
                stats["hang_hosts"].add(host)
                if stats["first_hang"] is None or t + dur < stats["first_hang"]:
                    stats["first_hang"], stats["first_hang_host"] = t + dur, host
                if pin == "large":
                    stats["pinned"]["large"] = rid
                    continue           # firewall lines for the pinned flow come from the capture itself
                ipid = hrng.randrange(1, 60000)
                for i, off in enumerate(HANG_ICMP_OFFSETS):
                    icmp_events.append(dict(host=host, t=t + off, type=3, code=4, sport=sport,
                                            dst=peer, inner_len=1500, inner_flags="ACK",
                                            ip_id=(ipid + min(i, 6)) & 0xFFFF))
                continue
            # success (maybe slow while ICMP came back, or a 503 during the ledger rolling deploy)
            dur = 20.7 + req["srv"] + 6.3 + req["resp"] / 90000 + req["req"] / 120000 + hrng.uniform(0, 3)
            if big and in_bh:      # started in the hang window, rescued by the ICMP rollback
                dur = (ROLLBACK[host] - t) + 210 + hrng.uniform(0, 30)
            elif big and t >= ROLLBACK[host] and not relearned_after_rollback:
                dur += 207
                relearned_after_rollback = True
            status = req["status"]
            if DEPLOY_A <= t < DEPLOY_B and hrng.random() < 0.09:
                status = 503
                dur = 20.7 + 6.3 + hrng.uniform(0.5, 2)
            if pin == "small":
                dur = 20.66 + 6.3 + req["srv"] + 0.2
            if req["method"] == "PUT" and status == 204 and hrng.random() < 0.02:
                status = 409
            dur_i = int(round(dur))
            resp = req["resp"] if status < 400 else 61
            if status >= 400:
                rec = {**base, "level": "warn", "msg": "ledger request returned error", "status": status,
                       "resp_bytes": resp, "duration_ms": dur_i}
            else:
                rec = {**base, "msg": "ledger request ok", "status": status, "resp_bytes": resp,
                       "duration_ms": dur_i}
            if pin == "small":
                stats["pinned"]["small"] = rid
            app_lines.append((t + dur_i, host, jd({**rec, "ts": local_iso(t + dur_i)})))
            srv_end = t + dur_i - 3
            if t < DEPLOY_A:
                ver = "3.7.4"
            elif t >= DEPLOY_B:
                ver = "3.8.0"
            else:
                ver = "3.8.0" if hrng.random() < (t - DEPLOY_A) / (DEPLOY_B - DEPLOY_A) else "3.7.4"
            rt = max(0.001, (dur_i - 27) / 1000)
            ingress.append((srv_end, f'{ip} - - [{nginx_time(srv_end)}] "{req["method"]} {req["path"]} HTTP/1.1" '
                                     f'{status} {resp} rt={rt:.3f} req_len={req["req"]} ver={ver} rid={rid}'))

        # periodic resolver + stats lines
        t = hrng.randrange(0, 300000)
        while t < WEND:
            rec = {"ts": local_iso(t), "level": "debug", "host": host, "svc": "manifest-sync",
                   "msg": "ledger endpoint resolved", "name": T.LEDGER_NAME, "addr": resolved_addr(host, t),
                   "resolver": "127.0.0.1:53"}
            app_lines.append((t, host, jd(rec)))
            t += 300000

    # other ledger clients (cloud side), noise in the ingress log
    nrng = random.Random(f"{T.SEED}-ingress")
    t = 1200
    while t < WEND:
        mf = f"MF-{nrng.randrange(16 ** 6):06X}"
        status = 200 if nrng.random() > 0.03 else 404
        ingress.append((t, f'10.40.3.17 - - [{nginx_time(t)}] "GET /v1/manifests/{mf} HTTP/1.1" {status} '
                           f'{nrng.randint(900, 5200) if status == 200 else 61} rt={nrng.uniform(0.004, 0.03):.3f} '
                           f'req_len={nrng.randint(240, 290)} ver={"3.7.4" if t < DEPLOY_B else "3.8.0"} '
                           f'rid=bw-{nrng.getrandbits(48):012x}'))
        t += int(nrng.expovariate(1 / 6000)) + 50

    app_lines.sort(key=lambda x: (x[0], x[1]))
    ingress.sort(key=lambda x: x[0])
    stats["app_lines"] = app_lines
    stats["ingress"] = ingress
    stats["icmp_events"] = icmp_events
    return stats


# ============================================================================== captures
def build_captures(stats: dict) -> list[dict]:
    crng = random.Random(f"{T.SEED}-pcap")
    out_icmp: list[dict] = []
    small, _ = P.conv_small(crng, T.CAPTURE_SMALL, 48790, 712, 118, 11.4)
    large, dropped = P.conv_large_blackhole(crng, T.CAPTURE_LARGE, 48812, 18734)
    valid = P.conv_validation(crng, T.VALIDATION_CAPTURE, 40122, 6020, 142)
    stale, stale_icmp = P.conv_stale(crng, T.CAPTURE_STALE, "app-05", 51522)
    hdr = "$ sudo tcpdump -i eth0 -nn -tttt -v 'host {peer} and tcp port 443 or icmp'   # on {host}, clock = UTC"
    specs = [
        ("pcap/app-03_small-request", small, hdr.format(peer=T.NEW_LEDGER_IP, host="app-03")),
        ("pcap/app-03_large-request", large, hdr.format(peer=T.NEW_LEDGER_IP, host="app-03")),
        ("pcap/tunnel-validation_app-03", valid, hdr.format(peer=T.NEW_LEDGER_IP, host="app-03")),
        ("pcap/app-05_ledger-connect", stale, "$ sudo tcpdump -i eth0 -nn -tttt -v 'tcp port 443 or icmp'"
                                              "   # on app-05, clock = UTC"),
    ]
    for rel, pkts, header in specs:
        write(rel + ".txt", P.render_text(pkts, header))
        P.write_pcap(EV / (rel + ".pcap"), pkts)
    for p in dropped:
        out_icmp.append(dict(host="app-03", t=(p.ts - W0).total_seconds() * 1000, type=3, code=4,
                             sport=p.inner.sport, dst=p.inner.dst, inner_len=len(P.ip_packet(p.inner)),
                             inner_flags="ACK PSH" if "P" in p.inner.flags else "ACK", ip_id=p.inner.ip_id,
                             outer_id=p.ip_id))
    for p in stale_icmp:
        out_icmp.append(dict(host="app-05", t=(p.ts - W0).total_seconds() * 1000, type=3, code=1,
                             sport=p.inner.sport, dst=p.inner.dst, inner_len=60, inner_flags="SYN",
                             ip_id=p.inner.ip_id, outer_id=p.ip_id))
    # the generic events for the pinned stale request were already added by simulate(); drop them
    pinned_stale_ms = ms_of(T.CAPTURE_STALE)
    stats["icmp_events"] = [e for e in stats["icmp_events"]
                            if not (e["host"] == "app-05" and e["sport"] == 51522
                                    and pinned_stale_ms <= e["t"] < pinned_stale_ms + 6000)]
    stats["icmp_events"] += out_icmp
    # cross-check: the large capture must show >=1 ICMP need-to-frag and no ACK of the request data
    if not dropped or any(p.icmp_code != 4 for p in dropped):
        raise BuildError("large capture lacks need-to-frag ICMP")
    return out_icmp


# ============================================================================== firewall log
def kern_stamp(host: str, dt: datetime) -> str:
    up = dt - T.LAST_BOOT[host]
    return f"[{int(up.total_seconds()):5d}.{up.microseconds:06d}]"


def mac_field(host: str, src_mac: str = "52:54:00:0c:12:01") -> str:
    last = int(T.HOST_IP[host].split(".")[-1])
    return f"52:54:00:0c:12:{last:02x}:{src_mac}:08:00"


def build_firewall(stats: dict) -> list[str]:
    frng = random.Random(f"{T.SEED}-fw")
    lines: list[tuple[float, str, str]] = []
    # ICMP drops through a per-host token bucket (iptables -m limit --limit 5/min, default burst 5)
    tokens = {h: 5.0 for h in T.HOST_NAMES}
    last = {h: 0.0 for h in T.HOST_NAMES}
    evs = sorted(stats["icmp_events"], key=lambda e: (e["t"], e["host"]))
    # traceroute from app-02 at 10:05:3x (time exceeded) -> also dropped by the baseline
    tr0 = ms_of(datetime(2026, 11, 18, 10, 5, 31, 220000, tzinfo=T.UTC))
    for i in range(6):
        evs.append(dict(host="app-02", t=tr0 + i * 5003.7, type=11, code=0, sport=33434 + i,
                        dst=T.NEW_LEDGER_IP, inner_len=60, inner_flags="UDP", ip_id=frng.randrange(1, 65535),
                        hop=(T.GW_IP, 64) if i < 3 else ("10.40.0.1", 63), inner_ttl=1 if i < 3 else 2))
    evs.sort(key=lambda e: (e["t"], e["host"]))
    logged_34 = 0
    for e in evs:
        h = e["host"]
        if e["t"] < HARDEN[h] or e["t"] >= ROLLBACK[h] and e["type"] == 3:
            continue
        tokens[h] = min(5.0, tokens[h] + (e["t"] - last[h]) / 12000.0)
        last[h] = e["t"]
        if tokens[h] < 1.0:
            continue
        tokens[h] -= 1.0
        dt = dt_of(0) + timedelta(microseconds=int(e["t"] * 1000))
        hip = T.HOST_IP[h]
        outer_id = e.get("outer_id", frng.randrange(1, 65535))
        if e["type"] == 3 and e["code"] == 4:
            logged_34 += 1
            inner = (f"[SRC={hip} DST={e['dst']} LEN={e['inner_len']} TOS=0x00 PREC=0x00 TTL=63 ID={e['ip_id']} DF "
                     f"PROTO=TCP SPT={e['sport']} DPT=443 WINDOW=502 RES=0x00 {e['inner_flags']} URGP=0 ]")
            body = (f"IN=eth0 OUT= MAC={mac_field(h)} SRC={T.GW_IP} DST={hip} LEN=576 TOS=0x00 PREC=0xC0 TTL=64 "
                    f"ID={outer_id} PROTO=ICMP TYPE=3 CODE=4 {inner} MTU={T.TUNNEL_MTU}")
        elif e["type"] == 3:
            inner = (f"[SRC={hip} DST={e['dst']} LEN=60 TOS=0x00 PREC=0x00 TTL=63 ID={e['ip_id']} DF PROTO=TCP "
                     f"SPT={e['sport']} DPT=443 WINDOW=64240 RES=0x00 SYN URGP=0 ]")
            body = (f"IN=eth0 OUT= MAC={mac_field(h)} SRC={T.GW_IP} DST={hip} LEN=88 TOS=0x00 PREC=0xC0 TTL=64 "
                    f"ID={outer_id} PROTO=ICMP TYPE=3 CODE={e['code']} {inner}")
        else:
            hop_ip, hop_ttl = e["hop"]
            inner = (f"[SRC={hip} DST={e['dst']} LEN=60 TOS=0x00 PREC=0x00 TTL=1 ID={e['ip_id']} PROTO=UDP "
                     f"SPT={frng.randrange(40000, 60000)} DPT={e['sport']} LEN=40 ]")
            body = (f"IN=eth0 OUT= MAC={mac_field(h)} SRC={hop_ip} DST={hip} LEN=88 TOS=0x00 PREC=0xC0 "
                    f"TTL={hop_ttl} ID={outer_id} PROTO=ICMP TYPE=11 CODE=0 {inner}")
        lines.append((e["t"], h, f"{syslog_time(dt)} {h} kernel: {kern_stamp(h, dt)} IN-DROP-ICMP: {body}"))
    # background noise: internal vuln scanner + NetBIOS broadcasts (dropped by the old rule set too)
    for h in T.HOST_NAMES:
        hip = T.HOST_IP[h]
        t = frng.randrange(0, 420000)
        while t < WEND:
            for port in frng.sample([23, 445, 3389, 5900, 6379, 8080, 11211], 3):
                tt = t + frng.randrange(0, 900)
                dt = dt_of(tt)
                body = (f"IN=eth0 OUT= MAC={mac_field(h, '52:54:00:0c:63:28')} SRC=10.20.99.40 DST={hip} LEN=44 "
                        f"TOS=0x00 PREC=0x00 TTL=63 ID={frng.randrange(1, 65535)} PROTO=TCP SPT={frng.randrange(40000, 65000)} "
                        f"DPT={port} WINDOW=1024 RES=0x00 SYN URGP=0")
                lines.append((tt, h, f"{syslog_time(dt)} {h} kernel: {kern_stamp(h, dt)} IN-DROP: {body}"))
            t += frng.randrange(380000, 520000)
        t = frng.randrange(0, 120000)
        while t < WEND:
            dt = dt_of(t)
            body = (f"IN=eth0 OUT= MAC=ff:ff:ff:ff:ff:ff:52:54:00:0c:12:fa:08:00 SRC=10.20.12.250 DST=10.20.12.255 "
                    f"LEN=78 TOS=0x00 PREC=0x00 TTL=64 ID={frng.randrange(1, 65535)} PROTO=UDP SPT=137 DPT=137 LEN=58")
            lines.append((t, h, f"{syslog_time(dt)} {h} kernel: {kern_stamp(h, dt)} IN-DROP: {body}"))
            t += frng.randrange(100000, 140000)
    lines.sort(key=lambda x: (x[0], x[1]))
    if logged_34 == 0:
        raise BuildError("no ICMP type 3 code 4 drops logged")
    return [l for _, _, l in lines]


# ============================================================================== static documents
def iptables_save(after: bool) -> str:
    stamp = "Wed Nov 18 11:05:12 2026" if after else "Wed Nov 18 06:00:03 2026"
    lines = [f"# Generated by iptables-save v1.8.9 (nf_tables) on {stamp}", "*filter",
             ":INPUT DROP [0:0]", ":FORWARD DROP [0:0]", ":OUTPUT ACCEPT [0:0]"]
    if after:
        lines += [
            '-A INPUT -p icmp -m icmp --icmp-type 8 -m comment --comment "baseline-v4: allow echo-request" -j ACCEPT',
            '-A INPUT -p icmp -m icmp --icmp-type 0 -m comment --comment "baseline-v4: allow echo-reply" -j ACCEPT',
            '-A INPUT -p icmp -m limit --limit 5/min -m comment --comment "baseline-v4: log other icmp" '
            '-j LOG --log-prefix "IN-DROP-ICMP: "',
            '-A INPUT -p icmp -m comment --comment "baseline-v4: drop other icmp" -j DROP',
        ]
    lines += [
        "-A INPUT -i lo -j ACCEPT",
        "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    ]
    if not after:
        lines.append("-A INPUT -p icmp -j ACCEPT")
    lines += [
        "-A INPUT -s 10.20.0.0/16 -p tcp -m tcp --dport 22 -j ACCEPT",
        "-A INPUT -s 10.20.30.0/24 -p tcp -m tcp --dport 9100 -j ACCEPT",
        '-A INPUT -m limit --limit 10/min -j LOG --log-prefix "IN-DROP: "',
        "COMMIT",
        f"# Completed on {stamp}",
        "",
    ]
    head = (f"# app-03: iptables-save, {'collected by maya.r during the incident' if after else 'nightly config backup'}\n")
    return head + "\n".join(lines)


def unbound_conf(v2: bool) -> str:
    if not v2:
        return """# /etc/unbound/unbound.conf -- managed by ansible role node-dns (v1). Do not edit by hand.
server:
    interface: 127.0.0.1
    port: 53
    access-control: 127.0.0.0/8 allow
    do-ip6: no
    num-threads: 1
    msg-cache-size: 8m
    rrset-cache-size: 16m
    cache-max-ttl: 86400
    cache-max-negative-ttl: 3600
    hide-identity: yes
    hide-version: yes
    verbosity: 1
    logfile: "/var/log/unbound/unbound.log"

forward-zone:
    name: "."
    forward-addr: 10.20.0.53
    forward-addr: 10.20.0.54
"""
    return """# /etc/unbound/unbound.conf -- managed by ansible role node-dns (v2). Do not edit by hand.
# v2: tuned for lower upstream query volume after the ns1/ns2 CPU alerts (CHG-7318).
server:
    interface: 127.0.0.1
    port: 53
    access-control: 127.0.0.0/8 allow
    do-ip6: no
    num-threads: 2
    so-reuseport: yes
    msg-cache-size: 32m
    rrset-cache-size: 64m
    neg-cache-size: 4m
    cache-min-ttl: 86400
    cache-max-ttl: 86400
    cache-max-negative-ttl: 300
    hide-identity: yes
    hide-version: yes
    verbosity: 1
    logfile: "/var/log/unbound/unbound.log"

forward-zone:
    name: "."
    forward-addr: 10.20.0.53
    forward-addr: 10.20.0.54
"""


def dig_block(host: str, when: datetime, server: str, addr: str, ttl: int, auth: bool, qid: int) -> str:
    srv = "127.0.0.1#53(127.0.0.1)" if server == "local" else f"{T.NS_IP}#53({T.NS_IP})"
    cmd = f"dig {T.LEDGER_NAME}" if server == "local" else f"dig @{T.NS_IP} {T.LEDGER_NAME}"
    flags = "qr aa rd ra" if auth else "qr rd ra"
    return f"""maya.r@{host}:~$ {cmd}

; <<>> DiG 9.18.28-1~deb12u2-Debian <<>> {cmd[4:]}
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: {qid}
;; flags: {flags}; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; QUESTION SECTION:
;{T.LEDGER_NAME}.\tIN\tA

;; ANSWER SECTION:
{T.LEDGER_NAME}. {ttl}\tIN\tA\t{addr}

;; Query time: {0 if server == 'local' else 1} msec
;; SERVER: {srv} (UDP)
;; WHEN: {when.strftime('%a %b %d %H:%M:%S')} UTC 2026
;; MSG SIZE  rcvd: 72

"""


def build_dig(stats: dict) -> dict:
    drng = random.Random(f"{T.SEED}-dig")
    ttls = {}
    for host, when in T.DIG_TIMES.items():
        if host in T.STALE_HOSTS:
            inserted = T.ROLE_RESTART[host] + timedelta(seconds=3)
            ttl = T.CACHE_MIN_TTL - int((when - inserted).total_seconds())
            addr = T.OLD_LEDGER_IP
        elif host == "app-07":
            ttl = T.CACHE_MIN_TTL - int((when - T.APP07_FIRST_RESOLVE).total_seconds())
            addr = T.NEW_LEDGER_IP
        else:
            ttl = drng.randint(5, 58)
            addr = T.NEW_LEDGER_IP
        ttls[host] = (addr, ttl)
        text = dig_block(host, when, "local", addr, ttl, False, drng.randrange(1000, 65000))
        if host in ("app-05", "app-07"):
            text += dig_block(host, when + timedelta(seconds=19), "ns", T.NEW_LEDGER_IP, T.ZONE_TTL, True,
                              drng.randrange(1000, 65000))
        text += f"maya.r@{host}:~$ getent hosts {T.LEDGER_NAME}\n{addr}      {T.LEDGER_NAME}\n"
        write(f"dns/dig/{host}.txt", text)
    for h in T.STALE_HOSTS:
        if h in ttls and ttls[h][1] <= T.ZONE_TTL:
            raise BuildError("stale dig TTL is not above the zone TTL")
    return ttls


def change_log() -> str:
    rows = [
        (T.CHG_LOGROTATE, "2026-11-16T08:30:00Z", "2026-11-16T08:41:00Z", "noa.g", "platform", "standard",
         "app-01..app-08", "logrotate: keep 14 days of manifest-sync logs instead of 7", "completed"),
        (T.CHG_TTL_LOWER, "2026-11-16T15:00:00Z", "2026-11-16T15:05:00Z", "tamar.s", "platform-dns", "standard",
         "ns1,ns2", "Lower TTL of ledger.int.kestrel.internal A record ahead of Tuesday's ledger migration", "completed"),
        (T.CHG_STORAGE, "2026-11-17T10:00:00Z", "2026-11-17T10:30:00Z", "oren.k", "network", "standard",
         "stor-sw-01,stor-sw-02", "Storage switch firmware update (rolling)", "completed"),
        (T.CHG_DNS_ROLE, "2026-11-17T14:20:00Z", "2026-11-17T14:31:00Z", "tamar.s", "platform-dns", "standard",
         "app-05,app-06,app-07,app-08", "Roll ansible role node-dns v2 (local unbound tuning to cut upstream query "
         "load after ns1/ns2 CPU alerts) to rack B. unbound restarts on each host", "completed"),
        (T.CHG_DNS_CUTOVER, "2026-11-17T20:00:00Z", "2026-11-17T20:35:00Z", "lior.b", "ledger", "normal",
         "ns1,ledger-vm-01", "Ledger migration step 3: point ledger.int.kestrel.internal at the cloud LB, then "
         "power off and release ledger-vm-01 in dc1", "completed"),
        (T.CHG_TUNNEL, "2026-11-17T22:00:00Z", "2026-11-17T22:45:00Z", "oren.k", "network", "normal",
         "gw-dc1,gw-cloud", "Move the dc1<->cloud interconnect from the leased line to a WireGuard tunnel over the "
         "dc1 internet circuit. Validation: TLS upload from app-03 (capture attached)", "completed"),
        (T.CHG_REBOOT07, "2026-11-18T06:05:00Z", "2026-11-18T06:14:00Z", "noa.g", "platform", "standard",
         "app-07", "Kernel security update + reboot (app-07 was missed in last week's batch)", "completed"),
        (T.CHG_LEDGER_DEPLOY, "2026-11-18T08:55:00Z", "2026-11-18T08:56:40Z", "lior.b", "ledger", "standard",
         "ledger (cloud)", "Deploy ledger v3.8.0: manifest body validation, request size limit 10 MiB", "completed"),
        (T.CHG_BASELINE, "2026-11-18T09:12:00Z", "2026-11-18T09:12:50Z", "ido.h", "security", "standard",
         "app-01..app-08", "Security baseline v4 (CIS L1) via ansible: sysctl hardening, auditd rules, host "
         "firewall template baseline-v4", "completed"),
        (T.CHG_JUMBO, "2026-11-18T09:40:00Z", "2026-11-18T09:46:00Z", "oren.k", "network", "standard",
         "app-01..app-08 (eth1)", "Enable jumbo frames (MTU 9000) on the storage VLAN interface eth1", "completed"),
        (T.CHG_FLUSH, "2026-11-18T11:52:00Z", "2026-11-18T11:53:30Z", "tamar.s", "platform-dns", "emergency",
         "app-05,app-06,app-07,app-08", "unbound-control flush ledger.int.kestrel.internal on rack B", "completed"),
        (T.CHG_ICMP_ROLLBACK, "2026-11-18T12:18:00Z", "2026-11-18T12:19:10Z", "ido.h", "security", "emergency",
         "app-01..app-08", "Host firewall: insert ACCEPT for inbound ICMP type 3 (destination-unreachable) at the "
         "top of INPUT", "completed"),
        ("CHG-7350", "2026-11-19T09:00:00Z", "", "oren.k", "network", "normal", "gw-dc1",
         "Investigate MSS clamping on the WireGuard tunnel", "scheduled"),
    ]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["change_id", "start_utc", "end_utc", "requested_by", "team", "type", "targets", "summary", "status"])
    w.writerows(rows)
    return buf.getvalue()


def zone_audit() -> str:
    z = T.ZONE
    rows = [
        ("2026-11-16T09:12:40Z", "2026111601", "ci-bot", "-", "ADD", "ci-runner-07", "A", "10.20.14.37", "300", ""),
        ("2026-11-16T15:02:11Z", "2026111602", "tamar.s", T.CHG_TTL_LOWER, "TTL", "ledger", "A", T.OLD_LEDGER_IP,
         "60", "ttl 3600 -> 60"),
        ("2026-11-17T08:47:03Z", "2026111701", "ci-bot", "-", "DEL", "ci-runner-03", "A", "10.20.14.33", "300", ""),
        ("2026-11-17T11:20:55Z", "2026111702", "noa.g", "-", "ADD", "grafana", "CNAME", "mon-01.int.kestrel.internal.",
         "3600", ""),
        ("2026-11-17T20:00:42Z", "2026111703", "lior.b", T.CHG_DNS_CUTOVER, "DEL", "ledger", "A", T.OLD_LEDGER_IP,
         "60", ""),
        ("2026-11-17T20:00:42Z", "2026111703", "lior.b", T.CHG_DNS_CUTOVER, "ADD", "ledger", "A", T.NEW_LEDGER_IP,
         "60", ""),
        ("2026-11-17T20:31:18Z", "2026111704", "lior.b", T.CHG_DNS_CUTOVER, "DEL", "ledger-vm-01", "A",
         T.OLD_LEDGER_IP, "3600", "host decommissioned"),
        ("2026-11-18T07:55:21Z", "2026111801", "ci-bot", "-", "ADD", "ci-runner-08", "A", "10.20.14.38", "300", ""),
        ("2026-11-18T10:12:09Z", "2026111802", "oren.k", "-", "ADD", "gw-cloud", "A", "10.40.0.1", "3600", ""),
    ]
    out = ["# ns1 zone audit trail, int.kestrel.internal (all times UTC). Fields: time serial user change op name type value ttl note"]
    for r in rows:
        ts, serial, user, chg, op, name, typ, val, ttl, note = r
        line = (f"{ts} zone={z} serial={serial} user={user} change={chg} op={op} name={name} type={typ} "
                f"value={val} ttl={ttl}")
        if note:
            line += f' note="{note}"'
        out.append(line)
    return "\n".join(out) + "\n"


def inventory() -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["host", "ip", "site", "rack", "dns_role", "last_boot_utc", "kernel"])
    for h, ip, rack, role in T.HOSTS:
        kern = "6.1.0-28-amd64" if h == "app-07" else "6.1.0-27-amd64"
        w.writerow([h, ip, "dc1", rack, role, T.LAST_BOOT[h].strftime("%Y-%m-%dT%H:%M:%SZ"), kern])
    w.writerow(["gw-dc1", T.GW_IP, "dc1", "N", "-", "2026-10-29T04:02:11Z", "6.1.0-27-amd64"])
    w.writerow(["ns1", T.NS_IP, "dc1", "N", "-", "2026-10-29T04:20:45Z", "6.1.0-27-amd64"])
    return buf.getvalue()


def ip_link() -> str:
    def host_block(h: str) -> str:
        last = int(T.HOST_IP[h].split(".")[-1])
        return f"""maya.r@{h}:~$ ip link show
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:0c:12:{last:02x} brd ff:ff:ff:ff:ff:ff
    altname enp1s0
3: eth1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:0d:22:{last:02x} brd ff:ff:ff:ff:ff:ff
    altname enp2s0
maya.r@{h}:~$ ip route get {T.NEW_LEDGER_IP}
{T.NEW_LEDGER_IP} via {T.GW_IP} dev eth0 src {T.HOST_IP[h]} uid 1000
    cache
maya.r@{h}:~$ ip route get 10.20.40.9
10.20.40.9 dev eth1 src 10.20.40.{last} uid 1000
    cache

"""
    gw = f"""oren.k@gw-dc1:~$ ip -d link show
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00 promiscuity 0
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:0c:12:01 brd ff:ff:ff:ff:ff:ff promiscuity 0
3: eth1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:0c:ee:02 brd ff:ff:ff:ff:ff:ff promiscuity 0
4: ppp0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu {T.PPP_MTU} qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 3
    link/ppp promiscuity 0
    ppp
5: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu {T.TUNNEL_MTU} qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/none promiscuity 0
    wireguard
6: ens-legacy: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT group default qlen 1000
    link/ether 52:54:00:0c:ee:09 brd ff:ff:ff:ff:ff:ff promiscuity 0
    altname leased-line-dc1-cloud
oren.k@gw-dc1:~$ ip route show 10.40.0.0/16
10.40.0.0/16 dev wg0 scope link
oren.k@gw-dc1:~$ sudo wg show wg0 | head -8
interface: wg0
  public key: kEsTrElExAmPlEkEyAAAAAAAAAAAAAAAAAAAAAAAAAA=
  private key: (hidden)
  listening port: 51820

peer: cLoUdGwExAmPlEkEyBBBBBBBBBBBBBBBBBBBBBBBBBBB=
  endpoint: 198.51.100.20:51820
  allowed ips: 10.40.0.0/16

"""
    lb = f"""lior.b@ledger-lb-a:~$ ip link show ens5
2: ens5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 0a:1b:2c:3d:4e:5f brd ff:ff:ff:ff:ff:ff
    altname enp0s5

"""
    head = ("# Interface dumps collected on Wed 2026-11-18 between 10:50 and 11:10 UTC.\n"
            "# app hosts: eth0 = app VLAN (default route), eth1 = storage VLAN.\n\n")
    return head + host_block("app-03") + host_block("app-05") + gw + lb


def chat() -> str:
    def ts(h, m, s):
        return f"{int(datetime(2026, 11, 18, h, m, s, tzinfo=T.UTC).timestamp())}.{(h * 7919 + m * 104729 + s * 31) % 1000000:06d}"
    msgs = [
        ((9, 28, 40), "pagerbot", ":rotating_light: [FIRING] manifest-sync upload_success_ratio < 80% (INC-3107)\n"
                                  "Severity: SEV3 | On-call: maya.r | Runbook: ledger/manifest-sync"),
        ((9, 29, 55), "maya.r", "ack, looking"),
        ((9, 31, 12), "maya.r", "manifest uploads (POST /v1/manifests) are hanging for the full 30s client timeout "
                                "since about a quarter past. scans, status updates and health checks look fine"),
        ((9, 32, 40), "lior.b", "ledger v3.8.0 rolled out at 08:55, it adds body validation for manifests. could it "
                                "be rejecting something?"),
        ((9, 34, 2), "maya.r", "not rejecting, hanging. the client never gets a status line back"),
        ((9, 35, 47), "maya.r", "maybe unrelated: the rack B hosts have had sync backlog warnings since last night. "
                                "those fail everything, not just uploads"),
        ((9, 37, 15), "tamar.s", "rack B got node-dns v2 yesterday afternoon. DNS is fine though, I just dug ledger "
                                 "from a box and it gives the cloud LB"),
        ((9, 40, 5), "oren.k", "heads-up: starting CHG-7344 now, jumbo frames on the storage VLAN of the app hosts. "
                               "scheduled, unrelated"),
        ((9, 44, 30), "lior.b", "ledger ingress: zero 413s, and no 5xx since the deploy settled. the big POSTs from "
                                "rack A just never arrive. the last big one I see from app-03 is a few minutes before "
                                "the alert"),
        ((9, 47, 12), "maya.r", "jumbo frames? an MTU change right in the middle of this"),
        ((9, 48, 30), "oren.k", "jumbo went in at 09:40 and your hangs started before that. also it's eth1 only, ledger "
                                "traffic leaves via eth0"),
        ((9, 52, 10), "oren.k", "the dc1<->cloud tunnel has been up since last night (CHG-7330). validated it with a "
                                "big upload, PMTUD did its job. capture is attached to the change"),
        ((9, 55, 41), "lior.b", "so the tunnel worked all night and broke at 09:15 by itself? I still think it's our "
                                "deploy plus some buffering thing. rolling back 3.8.0 is cheap"),
        ((9, 58, 3), "maya.r", "let's not roll back blind. small requests fine, anything over a couple of KB hangs. "
                               "smells like MTU"),
        ((10, 3, 27), "maya.r", "from app-02: `ping -M do -s 1300 10.40.8.21` 0% loss. `ping -M do -s 1400 10.40.8.21` "
                                "100% loss, no error printed, just silence"),
        ((10, 5, 40), "oren.k", "traceroute from app-02 to the LB is all `* * *`, even the first hop. it was fine "
                                "last night"),
        ((10, 9, 18), "ido.h", "security baseline v4 went out on the app hosts this morning. it allows echo and "
                               "ping works, so it's not the baseline"),
        ((10, 21, 33), "lior.b", "captured on app-03 (in the pack under pcap/). I can SEE the ICMP 'need to frag' "
                                 "arriving on eth0. so ICMP is not blocked, it's something else"),
        ((10, 24, 10), "oren.k", "if the host got need-to-frag it should shrink its segments and resend. it doesn't, "
                                 "it keeps resending the same full-size segment until the app gives up"),
        ((10, 31, 2), "tamar.s", "could also be the cloud LB. its MTU is 9001, it advertises a huge MSS"),
        ((10, 40, 51), "maya.r", "app-05: every request fails at connect, even health. different ghost?"),
        ((10, 42, 30), "tamar.s", "all hosts run a local unbound. the ledger TTL has been 60s since Monday, so every "
                                  "cache picked up the new address a minute after the cutover. unless it's negative "
                                  "caching: v2 changed that setting, let me look"),
        ((10, 47, 5), "lior.b", "the old ledger VM in dc1 has been gone since Tuesday evening. anything still "
                                "pointing at it can't connect"),
        ((11, 31, 58), "maya.r", "dig from app-02, app-05, app-07 and app-08 is in dns/dig. app-05 does NOT get the "
                                 "same answer as app-02"),
        ((11, 35, 20), "tamar.s", "...and look at that TTL. that is not a 60s record"),
        ((11, 38, 44), "maya.r", "app-07 is v2 too and looks fine?"),
        ((11, 39, 30), "noa.g", "app-07 got its kernel update reboot this morning (CHG-7336)"),
        ((11, 51, 40), "maya.r", "so it's all of rack B then. half the fleet"),
        ((11, 52, 5), "tamar.s", "flushing ledger from unbound on rack B (CHG-7347)"),
        ((11, 55, 10), "maya.r", "rack B connects work now. their uploads hang exactly like rack A though"),
        ((12, 2, 44), "ido.h", "looking at the host firewall again. echo is allowed, but maybe something else isn't"),
        ((12, 16, 58), "ido.h", "pushing CHG-7348: allow inbound ICMP destination-unreachable on the app hosts, as a "
                                "precaution"),
        ((12, 21, 40), "maya.r", "uploads flowing on all eight hosts. backlog draining"),
        ((12, 39, 15), "maya.r", "both ghosts gone for now. RCA tomorrow, I'll put the pack together"),
    ]
    data = [{"ts": ts(*hms), "user": u, "text": txt} for hms, u, txt in msgs]
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


README = """KESTREL FREIGHT // INCIDENT INC-3107 // FOLLOW-UP PACK
=======================================================

It's Thursday morning, 19 November 2026. You're writing the RCA for yesterday.

On Wednesday 18 November the manifest-sync workers (eight app hosts in dc1,
app-01 .. app-08) started having a very strange day talking to the ledger API,
which had just been migrated from a VM in dc1 to the cloud.

  * Small requests (health checks, scan events, status updates) worked.
  * Manifest uploads hung until the client gave up. Downloads were fine.
  * Some hosts couldn't reach the ledger at all, and had been failing since
    Tuesday night, but nobody connected the dots until mid-morning.

Nothing was "down". Pings worked. The ledger was healthy. By early afternoon
two emergency changes had made it all go away, and nobody is quite sure which
change fixed what, or whether both problems were really one.

Your job: separate the ghosts. Find what broke, when, and why, from the
evidence, not from what people guessed in the channel.


WHAT'S IN THE PACK
------------------
README_FIRST.txt                        this file
app/manifest-sync.log                   client log from all eight app hosts (JSON lines, one per request)
ledger/ingress-access.log               ledger's ingress log in the cloud: every request that ARRIVED
pcap/app-03_small-request.txt           tcpdump of one small request from app-03 (text)
pcap/app-03_large-request.txt           tcpdump of one manifest upload from app-03 (text)
pcap/app-05_ledger-connect.txt          tcpdump of one request attempt from app-05 (text)
pcap/tunnel-validation_app-03.txt       the validation capture attached to the tunnel change (text)
pcap/*.pcap                             the same four captures as real pcap files, for Wireshark
firewall/kern-app-hosts.log             kernel log lines from the host firewall on all app hosts
firewall/app-03_iptables-save_before.txt   app-03 host firewall, nightly backup (06:00 UTC)
firewall/app-03_iptables-save_after.txt    app-03 host firewall, collected during the incident
network/inventory.csv                   hosts, IPs, racks, DNS role, last boot
network/ip-link.txt                     interface dumps (app-03, app-05, gw-dc1, ledger LB)
changes/change-log.csv                  change calendar, Monday to Thursday
dns/zone-audit.log                      audit trail of the internal DNS zone
dns/dig/<host>.txt                      dig output collected on some app hosts
dns/unbound/node-dns-v1.conf            local resolver config, ansible role v1
dns/unbound/node-dns-v2.conf            local resolver config, ansible role v2
chat/inc-3107.json                      export of the incident channel


TIME ZONES AND FORMATS (read this)
----------------------------------
app/manifest-sync.log      "ts" is LOCAL office time, ISO-8601 with offset +02:00
                           (Asia/Jerusalem). A line is written when the request
                           FINISHES (or fails); "duration_ms" tells you how long it took.
ledger/ingress-access.log  nginx-style, UTC (+0000). Written when the request finishes.
pcap/*.txt                 tcpdump -tttt timestamps, the capture host's clock: UTC.
firewall/kern-app-hosts.log  syslog style, UTC, NO YEAR (it is 2026). The [....] number
                           after "kernel:" is seconds since that host booted.
changes/change-log.csv     UTC, ISO-8601 with Z.
dns/zone-audit.log         UTC, ISO-8601 with Z.
dns/dig/*.txt              the ";; WHEN:" line is UTC.
chat/inc-3107.json         "ts" is Unix epoch seconds (a string), i.e. UTC.

All app hosts and gw-dc1 run their clocks in UTC. Only the manifest-sync app
logs in local time (someone thought it was friendlier).


TIPS
----
- Every app log line says which host it came from and which IP it talked to.
- The captures were taken on the app hosts themselves, on eth0.
- "It worked last night" and "ping works" are facts about last night and ping.
- People in the channel were sharp but guessing. Some of them were wrong,
  and a couple were right for the wrong reason.
"""


# ============================================================================== main
def main() -> int:
    if EV.exists():
        shutil.rmtree(EV)
    EV.mkdir(parents=True)
    T.TRUTH_DIR.mkdir(parents=True, exist_ok=True)

    stats = simulate()
    build_captures(stats)
    fw = build_firewall(stats)
    write("firewall/kern-app-hosts.log", "\n".join(fw) + "\n")
    write("firewall/app-03_iptables-save_before.txt", iptables_save(False))
    write("firewall/app-03_iptables-save_after.txt", iptables_save(True))
    write("app/manifest-sync.log", "\n".join(j for _, _, j in stats["app_lines"]) + "\n")
    write("ledger/ingress-access.log", "\n".join(l for _, l in stats["ingress"]) + "\n")
    write("network/inventory.csv", inventory())
    write("network/ip-link.txt", ip_link())
    write("changes/change-log.csv", change_log())
    write("dns/zone-audit.log", zone_audit())
    write("dns/unbound/node-dns-v1.conf", unbound_conf(False))
    write("dns/unbound/node-dns-v2.conf", unbound_conf(True))
    build_dig(stats)
    write("chat/inc-3107.json", chat())
    write("README_FIRST.txt", README)

    # ----------------------------------------------------------------- answers + cross-checks
    first_hang = stats["first_hang"]
    q1 = dt_of(first_hang).strftime("%H:%M:%S")
    answers = {
        "q1": q1,
        "q2": T.CHG_BASELINE,
        "q3": str(T.MSS_CLAMP),
        "q4": T.OLD_LEDGER_IP,
        "q5": str(len(T.STALE_HOSTS)),
        "q6": "cache-min-ttl",
    }
    errors = []
    if not (T.HARDEN_APPLIED[stats["first_hang_host"]] < dt_of(first_hang) < T.JUMBO_CHANGE):
        errors.append(f"first hang {q1} is not between the baseline and the jumbo change")
    if stats["first_hang_host"] != "app-03":
        errors.append(f"first hang expected on app-03, got {stats['first_hang_host']}")
    if sorted(stats["stale_hosts"]) != sorted(T.STALE_HOSTS):
        errors.append(f"stale hosts in log {sorted(stats['stale_hosts'])} != {T.STALE_HOSTS}")
    if set(stats["stale_hosts"]) & {"app-07"}:
        errors.append("app-07 must not be stale")
    for need in ("small", "large", "stale"):
        if need not in stats["pinned"]:
            errors.append(f"pinned {need} request missing from the app log")
    for _, _, j in stats["app_lines"]:
        rec = json.loads(j)
        rb = rec.get("req_bytes")
        if rb is not None and SMALL_MAX < rb < BIG_MIN:
            errors.append(f"ambiguous request size {rb}")
            break
    # the stale IP must be the only connect-phase peer
    peers = {json.loads(j).get("peer") for _, _, j in stats["app_lines"] if '"phase":"connect"' in j}
    if peers != {T.OLD_LEDGER_IP}:
        errors.append(f"connect-phase peers {peers}")
    fw_text = (EV / "firewall/kern-app-hosts.log").read_text()
    if f"MTU={T.TUNNEL_MTU}" not in fw_text:
        errors.append("firewall log lacks the MTU field")
    if f"need to frag (mtu {T.TUNNEL_MTU})" not in (EV / "pcap/app-03_large-request.txt").read_text():
        errors.append("large capture lacks need-to-frag")
    readme = (EV / "README_FIRST.txt").read_text().lower()
    for q, a in answers.items():
        if q != "q5" and a.lower() in readme:
            errors.append(f"answer {q} leaks into README_FIRST.txt")
    total = 0
    for p in EV.rglob("*"):
        if p.is_file():
            sz = p.stat().st_size
            total += sz
            if sz > 15 * 1024 * 1024:
                errors.append(f"{p} exceeds 15 MB")
    if total > 40 * 1024 * 1024:
        errors.append("evidence directory exceeds 40 MB")
    if errors:
        for e in errors:
            print("CROSS-CHECK FAILED:", e, file=sys.stderr)
        return 1

    (T.TRUTH_DIR / f"{T.CASE_ID}.answers.json").write_text(
        json.dumps({"caseId": T.CASE_ID, "answers": answers}, indent=2) + "\n", encoding="utf-8")
    print(f"[{T.CASE_ID}] evidence -> {EV} ({total / 1e6:.1f} MB)")
    print(f"[{T.CASE_ID}] answers  -> {T.TRUTH_DIR / (T.CASE_ID + '.answers.json')}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
