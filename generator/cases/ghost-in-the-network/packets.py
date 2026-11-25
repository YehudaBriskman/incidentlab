"""Tiny packet model for case `ghost-in-the-network`.

Builds the four captured conversations as packet records, then renders each one twice:
as `tcpdump -nn -tttt -v` text (what the Explorer shows) and as a real libpcap file
(for Wireshark). Stdlib only, deterministic (all randomness comes from the passed-in RNG).
"""
from __future__ import annotations

import random
import struct
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import timeline as T

MAC = {ip: bytes.fromhex(f"5254000c12{int(ip.split('.')[-1]):02x}") for ip in T.HOST_IP.values()}
GW_MAC = bytes.fromhex("5254000c1201")


@dataclass
class Pkt:
    ts: datetime
    src: str
    dst: str
    ttl: int
    ip_id: int
    df: bool
    proto: str                       # "tcp" | "icmp"
    tos: int = 0
    outgoing: bool = False           # sent by the capture host (checksum offload -> "incorrect")
    # tcp
    sport: int = 0
    dport: int = 0
    flags: str = ""
    seq: int = 0
    ack: int = 0
    win: int = 0
    opts: list = field(default_factory=list)
    payload: bytes = b""
    rel_seq: Optional[int] = None    # tcpdump relative numbers (None = print absolute)
    rel_ack: Optional[int] = None
    # icmp
    icmp_type: int = 0
    icmp_code: int = 0
    mtu: int = 0
    inner: Optional["Pkt"] = None


# ------------------------------------------------------------------------------------------ bytes
def _csum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    s = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return s


def _ip4(a: str) -> bytes:
    return bytes(int(x) for x in a.split("."))


def _opts_bytes(opts: list) -> bytes:
    out = b""
    for o in opts:
        k = o[0]
        if k == "mss":
            out += struct.pack("!BBH", 2, 4, o[1])
        elif k == "sackOK":
            out += b"\x04\x02"
        elif k == "TS":
            out += struct.pack("!BBII", 8, 10, o[1], o[2])
        elif k == "nop":
            out += b"\x01"
        elif k == "wscale":
            out += struct.pack("!BBB", 3, 3, o[1])
        elif k == "sack":
            out += struct.pack("!BBII", 5, 10, o[1], o[2])
    assert len(out) % 4 == 0, opts
    return out


_FLAG_BITS = {"F": 0x01, "S": 0x02, "R": 0x04, "P": 0x08, ".": 0x10}


def _tcp_bytes(p: Pkt) -> tuple[bytes, int, int]:
    """Return (segment bytes as on the wire, stored checksum, correct checksum)."""
    ob = _opts_bytes(p.opts)
    off = (20 + len(ob)) // 4
    fl = sum(_FLAG_BITS[c] for c in p.flags)
    hdr = struct.pack("!HHIIBBHHH", p.sport, p.dport, p.seq & 0xFFFFFFFF, p.ack & 0xFFFFFFFF,
                      off << 4, fl, p.win, 0, 0) + ob
    seg = hdr + p.payload
    pseudo = _ip4(p.src) + _ip4(p.dst) + struct.pack("!BBH", 0, 6, len(seg))
    correct = (~_csum(pseudo + seg)) & 0xFFFF
    stored = _csum(pseudo) & 0xFFFF if p.outgoing else correct   # offload leaves the pseudo-header sum
    seg = seg[:16] + struct.pack("!H", stored) + seg[18:]
    return seg, stored, correct


def _ip_bytes(p: Pkt, body: bytes, proto_num: int) -> bytes:
    hdr = struct.pack("!BBHHHBBH4s4s", 0x45, p.tos, 20 + len(body), p.ip_id,
                      0x4000 if p.df else 0, p.ttl, proto_num, 0, _ip4(p.src), _ip4(p.dst))
    c = (~_csum(hdr)) & 0xFFFF
    return hdr[:10] + struct.pack("!H", c) + hdr[12:] + body


def ip_packet(p: Pkt) -> bytes:
    if p.proto == "tcp":
        seg, _, _ = _tcp_bytes(p)
        return _ip_bytes(p, seg, 6)
    assert p.inner is not None
    inner_full = ip_packet(p.inner)
    inner = inner_full[: 576 - 28] if p.icmp_code == 4 else inner_full
    rest = struct.pack("!HH", 0, p.mtu) if p.icmp_code == 4 else b"\0\0\0\0"
    msg = struct.pack("!BBH", p.icmp_type, p.icmp_code, 0) + rest + inner
    c = (~_csum(msg)) & 0xFFFF
    msg = msg[:2] + struct.pack("!H", c) + msg[4:]
    return _ip_bytes(p, msg, 1)


def write_pcap(path, pkts: list[Pkt]) -> None:
    out = [struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1)]
    for p in pkts:
        ipb = ip_packet(p)
        if p.src in MAC:      # capture host -> gateway / peer
            eth = GW_MAC + MAC[p.src] + b"\x08\x00"
        else:
            eth = MAC.get(p.dst, GW_MAC) + GW_MAC + b"\x08\x00"
        frame = eth + ipb
        sec = int(p.ts.timestamp())
        out.append(struct.pack("<IIII", sec, p.ts.microsecond, len(frame), len(frame)) + frame)
    path.write_bytes(b"".join(out))


# ------------------------------------------------------------------------------------------ text
def _ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def _opts_text(opts: list) -> str:
    parts = []
    for o in opts:
        k = o[0]
        if k == "mss":
            parts.append(f"mss {o[1]}")
        elif k == "TS":
            parts.append(f"TS val {o[1]} ecr {o[2]}")
        elif k == "wscale":
            parts.append(f"wscale {o[1]}")
        elif k == "sack":
            parts.append(f"sack 1 {{{o[1]}:{o[2]}}}")
        else:
            parts.append(k)
    return ",".join(parts)


def _tcp_line(p: Pkt, with_cksum: bool, absolute: bool = False) -> str:
    plen = len(p.payload)
    bits = [f"Flags [{p.flags}]"]
    if with_cksum:
        _, stored, correct = _tcp_bytes(p)
        if stored == correct:
            bits.append(f"cksum 0x{stored:04x} (correct)")
        else:
            bits.append(f"cksum 0x{stored:04x} (incorrect -> 0x{correct:04x})")
    use_abs = absolute or p.rel_seq is None
    seq = p.seq if use_abs else p.rel_seq
    ack = p.ack if use_abs else p.rel_ack
    if "S" in p.flags:
        bits.append(f"seq {seq}")
        if "." in p.flags:
            bits.append(f"ack {ack}")
    else:
        if plen:
            bits.append(f"seq {seq}:{seq + plen}")
        elif "F" in p.flags or "R" in p.flags:
            bits.append(f"seq {seq}")
        if "." in p.flags:
            bits.append(f"ack {ack}")
    bits.append(f"win {p.win}")
    if p.opts:
        bits.append(f"options [{_opts_text(p.opts)}]")
    bits.append(f"length {plen}")
    return f"{p.src}.{p.sport} > {p.dst}.{p.dport}: " + ", ".join(bits)


def _ip_line(p: Pkt, length: int, proto: str) -> str:
    return (f"IP (tos 0x{p.tos:x}, ttl {p.ttl}, id {p.ip_id}, offset 0, "
            f"flags [{'DF' if p.df else 'none'}], proto {proto}, length {length})")


def render_text(pkts: list[Pkt], header: str) -> str:
    lines = [header, "tcpdump: listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes"]
    for p in pkts:
        ipb = ip_packet(p)
        if p.proto == "tcp":
            lines.append(f"{_ts(p.ts)} " + _ip_line(p, len(ipb), "TCP (6)"))
            lines.append("    " + _tcp_line(p, with_cksum=True))
        else:
            inner = p.inner
            assert inner is not None
            icmp_len = len(ipb) - 20
            lines.append(f"{_ts(p.ts)} " + _ip_line(p, len(ipb), "ICMP (1)"))
            if p.icmp_code == 4:
                what = f"ICMP {inner.dst} unreachable - need to frag (mtu {p.mtu}), length {icmp_len}"
            else:
                what = f"ICMP host {inner.dst} unreachable, length {icmp_len}"
            lines.append(f"    {p.src} > {p.dst}: {what}")
            lines.append("\t" + _ip_line(inner, len(ip_packet(inner)), "TCP (6)"))
            lines.append("    " + _tcp_line(inner, with_cksum=False, absolute=True))
    n = len(pkts)
    lines += ["", f"{n} packets captured", f"{n} packets received by filter", "0 packets dropped by kernel", ""]
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------ flows
class Flow:
    """One TCP conversation between a capture host (client) and a server."""

    def __init__(self, rng: random.Random, t0: datetime, cip: str, cport: int, sip: str, sport: int,
                 s_ttl: int):
        self.rng = rng
        self.t0 = t0
        self.cip, self.cport, self.sip, self.sport = cip, cport, sip, sport
        self.s_ttl = s_ttl
        self.cisn = rng.getrandbits(32)
        self.sisn = rng.getrandbits(32)
        self.cnxt = self.cisn       # next seq to send
        self.snxt = self.sisn
        self.c_rcv = 0              # what the client has received from the server (abs)
        self.s_rcv = 0
        self.cid = rng.randrange(20000, 60000)
        self.sid = rng.randrange(1000, 60000)
        self.cts0 = rng.getrandbits(31)
        self.sts0 = rng.getrandbits(31)
        self.last_cts = 0
        self.last_sts = 0
        self.pkts: list[Pkt] = []

    def _t(self, ms: float) -> datetime:
        return self.t0 + timedelta(microseconds=int(round(ms * 1000)))

    def _cts(self, ms: float) -> int:
        return (self.cts0 + int(ms)) & 0xFFFFFFFF

    def _sts(self, ms: float) -> int:
        return (self.sts0 + int(ms)) & 0xFFFFFFFF

    def c(self, ms: float, flags: str, plen: int = 0, seq: Optional[int] = None, opts=None,
          payload_head: bytes = b"") -> Pkt:
        s = self.cnxt if seq is None else seq
        self.cid += 1
        cts = self._cts(ms)
        self.last_cts = cts
        if opts is None:
            opts = [("nop",), ("nop",), ("TS", cts, self.last_sts)]
        payload = (payload_head + self.rng.randbytes(max(0, plen - len(payload_head))))[:plen]
        p = Pkt(ts=self._t(ms), src=self.cip, dst=self.sip, ttl=64, ip_id=self.cid & 0xFFFF, df=True,
                proto="tcp", outgoing=True, sport=self.cport, dport=self.sport, flags=flags, seq=s,
                ack=self.c_rcv, win=64240 if flags == "S" else 502, opts=opts, payload=payload)
        if "S" not in flags:
            p.rel_seq = s - self.cisn
            p.rel_ack = self.c_rcv - self.sisn
        adv = plen + (1 if ("S" in flags or "F" in flags) else 0)
        if seq is None:
            self.cnxt += adv
        self.pkts.append(p)
        return p

    def s(self, ms: float, flags: str, plen: int = 0, opts=None, payload_head: bytes = b"",
          ack: Optional[int] = None) -> Pkt:
        self.sid += 1
        sts = self._sts(ms)
        self.last_sts = sts
        if opts is None:
            opts = [("nop",), ("nop",), ("TS", sts, self.last_cts)]
        a = self.s_rcv if ack is None else ack
        payload = (payload_head + self.rng.randbytes(max(0, plen - len(payload_head))))[:plen]
        p = Pkt(ts=self._t(ms), src=self.sip, dst=self.cip, ttl=self.s_ttl, ip_id=self.sid & 0xFFFF,
                df=True, proto="tcp", sport=self.sport, dport=self.cport, flags=flags, seq=self.snxt,
                ack=a, win=62643 if "S" in flags else 489, opts=opts, payload=payload)
        if "S" not in flags:
            p.rel_seq = self.snxt - self.sisn
            p.rel_ack = a - self.cisn
        self.snxt += plen + (1 if ("S" in flags or "F" in flags) else 0)
        self.pkts.append(p)
        return p

    # handshake + TLS 1.3 handshake; returns time (ms) when the client may send application data
    def open_tls(self) -> float:
        self.c(0.0, "S", opts=[("mss", T.HOST_MSS), ("sackOK",), ("TS", self._cts(0), 0), ("nop",), ("wscale", 7)])
        self.s_rcv = self.cnxt
        self.c_rcv = self.snxt + 1
        self.s(6.31, "S.", opts=[("mss", T.SERVER_MSS), ("sackOK",), ("TS", self._sts(6.31), self.last_cts),
                                 ("nop",), ("wscale", 9)])
        self.c(6.36, ".")
        hello = b"\x16\x03\x01\x02\x00"
        self.c(6.52, "P.", 517, payload_head=hello)
        self.s_rcv = self.cnxt
        self.s(12.88, ".")
        sizes = [1360, 1360, 1360, 216]
        for i, sz in enumerate(sizes):
            head = b"\x16\x03\x03\x00\x7a" if i == 0 else b""
            self.s(13.41 + 0.01 * i, "P." if i == len(sizes) - 1 else ".", sz, payload_head=head)
        self.c_rcv = self.snxt
        self.c(13.55, ".")
        self.c(14.12, "P.", 126, payload_head=b"\x14\x03\x03\x00\x01")
        self.s_rcv = self.cnxt
        self.s(20.47, "P.", 287, payload_head=b"\x17\x03\x03\x01\x1a")
        self.c_rcv = self.snxt
        return 20.66


def _icmp_frag(t: datetime, gw_id: int, host: str, offending: Pkt) -> Pkt:
    inner = Pkt(**{**offending.__dict__})
    inner.ttl = offending.ttl - 1
    inner.outgoing = False
    return Pkt(ts=t, src=T.GW_IP, dst=host, ttl=64, ip_id=gw_id, df=False, proto="icmp", tos=0xC0,
               icmp_type=3, icmp_code=4, mtu=T.TUNNEL_MTU, inner=inner)


def _icmp_host_unreach(t: datetime, gw_id: int, host: str, offending: Pkt) -> Pkt:
    inner = Pkt(**{**offending.__dict__})
    inner.ttl = offending.ttl - 1
    inner.outgoing = False
    return Pkt(ts=t, src=T.GW_IP, dst=host, ttl=64, ip_id=gw_id, df=False, proto="icmp", tos=0xC0,
               icmp_type=3, icmp_code=1, inner=inner)


def _tls_stream_segments(total: int, mss_payload: int) -> list[int]:
    out = []
    while total > 0:
        out.append(min(mss_payload, total))
        total -= out[-1]
    return out


def conv_small(rng: random.Random, t0: datetime, cport: int, req_bytes: int, resp_bytes: int,
               server_ms: float) -> tuple[list[Pkt], float]:
    host = T.HOST_IP["app-03"]
    f = Flow(rng, t0, host, cport, T.NEW_LEDGER_IP, 443, s_ttl=61)
    t = f.open_tls()
    f.c(t, "P.", req_bytes + 22, payload_head=b"\x17\x03\x03")
    f.s_rcv = f.cnxt
    t_ack = t + 6.3
    f.s(t_ack, ".")
    t_resp = t_ack + server_ms
    f.s(t_resp, "P.", resp_bytes + 22, payload_head=b"\x17\x03\x03")
    f.c_rcv = f.snxt
    f.c(t_resp + 0.11, ".")
    f.c(t_resp + 0.42, "F.")
    f.s_rcv = f.cnxt
    f.s(t_resp + 6.7, "F.")
    f.c_rcv = f.snxt
    f.c(t_resp + 6.81, ".")
    return f.pkts, t_resp + 0.2


def conv_large_blackhole(rng: random.Random, t0: datetime, cport: int, req_bytes: int
                         ) -> tuple[list[Pkt], list[Pkt]]:
    """Returns (all packets on the wire, ICMP packets that the host firewall dropped)."""
    host = T.HOST_IP["app-03"]
    f = Flow(rng, t0, host, cport, T.NEW_LEDGER_IP, 443, s_ttl=61)
    t = f.open_tls()
    stream = req_bytes + 2 * 22            # two TLS records
    segs = _tls_stream_segments(stream, T.HOST_MSS - 12)
    gw_id = rng.randrange(10000, 40000)
    icmps: list[Pkt] = []
    burst = segs[:10]
    first_seq = f.cnxt
    sent: list[Pkt] = []
    for i, sz in enumerate(burst):
        p = f.c(t + 0.012 * i, "." if i < len(burst) - 1 else "P.", sz,
                payload_head=b"\x17\x03\x03\x40\x11" if i == 0 else b"")
        sent.append(p)
        if i < 6:                           # gw per-destination ICMP burst allowance
            gw_id += 1
            icmps.append(_icmp_frag(p.ts + timedelta(microseconds=241 + 12 * i), gw_id, host, p))
    f.pkts.extend(icmps)
    rto = 206.0
    tt = t
    first = sent[0]
    for k in range(7):
        tt += rto
        if tt >= T.CLIENT_TIMEOUT_MS:
            break
        p = f.c(tt, ".", len(first.payload), seq=first_seq)
        p.payload = first.payload
        if k >= 2:
            gw_id += 1
            ic = _icmp_frag(p.ts + timedelta(microseconds=238), gw_id, host, p)
            f.pkts.append(ic)
            icmps.append(ic)
        rto *= 2
    f.c(T.CLIENT_TIMEOUT_MS + 6.0, "R.")
    f.pkts.sort(key=lambda x: x.ts)
    return f.pkts, icmps


def conv_validation(rng: random.Random, t0: datetime, cport: int, req_bytes: int,
                    resp_bytes: int) -> list[Pkt]:
    """Tuesday night, before the hardening: PMTUD works."""
    host = T.HOST_IP["app-03"]
    f = Flow(rng, t0, host, cport, T.NEW_LEDGER_IP, 443, s_ttl=61)
    t = f.open_tls()
    stream = req_bytes + 22
    big = _tls_stream_segments(stream, T.HOST_MSS - 12)
    gw_id = rng.randrange(10000, 40000)
    start = f.cnxt
    sent = []
    for i, sz in enumerate(big):
        sent.append(f.c(t + 0.012 * i, "." if i < len(big) - 1 else "P.", sz,
                        payload_head=b"\x17\x03\x03\x17\x83" if i == 0 else b""))
    data = b"".join(p.payload for p in sent)
    icmps = []
    for i, p in enumerate(sent):
        if len(p.payload) + 52 > T.TUNNEL_MTU:
            gw_id += 1
            icmps.append(_icmp_frag(p.ts + timedelta(microseconds=239 + 11 * i), gw_id, host, p))
    f.pkts.extend(icmps)
    # last small segment got through; server sees a hole and SACKs it
    last = sent[-1]
    t_sack = t + 6.4
    f.s_rcv = start
    f.s(t_sack, ".", opts=[("nop",), ("nop",), ("TS", f._sts(t_sack), f.last_cts), ("nop",), ("nop",),
                           ("sack", last.seq, last.seq + len(last.payload))])
    # host learned PMTU from the first ICMP and retransmits with smaller segments right away
    t_re = (icmps[0].ts - t0).total_seconds() * 1000 + 0.05
    off = 0
    redo = _tls_stream_segments(len(data) - len(last.payload), T.SEG_PAYLOAD_LIMIT)
    for i, sz in enumerate(redo):
        p = f.c(t_re + 0.011 * i, ".", sz, seq=start + off)
        p.payload = data[off:off + sz]
        off += sz
    f.s_rcv = f.cnxt
    t_ack = t_re + 6.3
    f.s(t_ack, ".")
    t_resp = t_ack + 41.7
    f.s(t_resp, "P.", resp_bytes + 22, payload_head=b"\x17\x03\x03")
    f.c_rcv = f.snxt
    f.c(t_resp + 0.1, ".")
    f.c(t_resp + 0.4, "F.")
    f.s_rcv = f.cnxt
    f.s(t_resp + 6.7, "F.")
    f.c_rcv = f.snxt
    f.c(t_resp + 6.8, ".")
    f.pkts.sort(key=lambda x: x.ts)
    return f.pkts


def conv_stale(rng: random.Random, t0: datetime, host_name: str, cport: int) -> tuple[list[Pkt], list[Pkt]]:
    host = T.HOST_IP[host_name]
    f = Flow(rng, t0, host, cport, T.OLD_LEDGER_IP, 443, s_ttl=64)
    syn_opts = lambda ms: [("mss", T.HOST_MSS), ("sackOK",), ("TS", f._cts(ms), 0), ("nop",), ("wscale", 7)]
    syns = []
    for ms in (0.0, 1003.4, 3027.9):
        syns.append(f.c(ms, "S", seq=f.cisn, opts=syn_opts(ms)))
    gw_id = rng.randrange(10000, 40000)
    icmps = [
        _icmp_host_unreach(t0 + timedelta(milliseconds=3009.6), gw_id + 1, host, syns[0]),
        _icmp_host_unreach(t0 + timedelta(milliseconds=4012.2), gw_id + 2, host, syns[1]),
    ]
    f.pkts.extend(icmps)
    f.pkts.sort(key=lambda x: x.ts)
    return f.pkts, icmps
