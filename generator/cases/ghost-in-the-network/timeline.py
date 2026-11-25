"""Canonical constants for case `ghost-in-the-network`. See docs/cases/ghost-in-the-network.md.

Every datetime is timezone-aware UTC. The incident day is Wednesday 2026-11-18.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20261118
CASE_ID = "ghost-in-the-network"

UTC = timezone.utc
LOCAL_TZ = timezone(timedelta(hours=2), "IST")  # Asia/Jerusalem in November = UTC+02:00

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
BUILD = ROOT / "build"
EVIDENCE_DIR = BUILD / "evidence" / CASE_ID
TRUTH_DIR = BUILD / "truth"


def utc(day: int, h: int, m: int, s: int, ms: int = 0) -> datetime:
    return datetime(2026, 11, day, h, m, s, ms * 1000, tzinfo=UTC)


# ---------------------------------------------------------------- topology
ORG = "Kestrel Freight"
LEDGER_NAME = "ledger.int.kestrel.internal"
ZONE = "int.kestrel.internal"
OLD_LEDGER_IP = "10.20.4.15"      # dc1 VM, decommissioned Tuesday evening (the ghost)
NEW_LEDGER_IP = "10.40.8.21"      # cloud load balancer
GW_IP = "10.20.12.1"              # gw-dc1, default gateway of the app VLAN
NS_IP = "10.20.0.53"              # ns1, authoritative for the internal zone (also recursive)

# (host, ip, rack, dns_role)
HOSTS = [
    ("app-01", "10.20.12.11", "A", "node-dns-v1"),
    ("app-02", "10.20.12.12", "A", "node-dns-v1"),
    ("app-03", "10.20.12.13", "A", "node-dns-v1"),
    ("app-04", "10.20.12.14", "A", "node-dns-v1"),
    ("app-05", "10.20.12.15", "B", "node-dns-v2"),
    ("app-06", "10.20.12.16", "B", "node-dns-v2"),
    ("app-07", "10.20.12.17", "B", "node-dns-v2"),
    ("app-08", "10.20.12.18", "B", "node-dns-v2"),
]
HOST_IP = {h: ip for h, ip, _, _ in HOSTS}
HOST_NAMES = [h for h, _, _, _ in HOSTS]

PPP_MTU = 1492                     # dc1 internet circuit is PPPoE
TUNNEL_MTU = PPP_MTU - 80          # wg-quick default: route MTU minus WireGuard overhead = 1412
MSS_CLAMP = TUNNEL_MTU - 40        # 20 IPv4 + 20 TCP  -> the q3 answer
SEG_PAYLOAD_LIMIT = TUNNEL_MTU - 52  # 20 IP + 32 TCP (timestamps) -> largest payload that fits
HOST_MSS = 1460                    # what app hosts advertise (eth0 MTU 1500)
SERVER_MSS = 8961                  # cloud LB (ens5 MTU 9001)

# unbound
ZONE_TTL = 60
CACHE_MIN_TTL = 86400

# ---------------------------------------------------------------- change IDs
CHG_LOGROTATE = "CHG-7301"
CHG_TTL_LOWER = "CHG-7305"
CHG_STORAGE = "CHG-7311"
CHG_DNS_ROLE = "CHG-7318"
CHG_DNS_CUTOVER = "CHG-7329"
CHG_TUNNEL = "CHG-7330"
CHG_REBOOT07 = "CHG-7336"
CHG_LEDGER_DEPLOY = "CHG-7339"
CHG_BASELINE = "CHG-7342"          # the trigger of the black hole -> q2
CHG_JUMBO = "CHG-7344"
CHG_FLUSH = "CHG-7347"
CHG_ICMP_ROLLBACK = "CHG-7348"

# ---------------------------------------------------------------- timeline
TTL_LOWERED = utc(16, 15, 2, 11)
ROLE_RESTART = {                    # node-dns-v2 rollout restarts unbound -> cache refilled with floor 86400
    "app-05": utc(17, 14, 21, 9, 412),
    "app-06": utc(17, 14, 23, 40, 77),
    "app-07": utc(17, 14, 26, 2, 930),
    "app-08": utc(17, 14, 28, 51, 260),
}
DNS_CUTOVER = utc(17, 20, 0, 42)
OLD_VM_OFF = utc(17, 20, 31, 5)
TUNNEL_CUTOVER = utc(17, 22, 0, 0)
TUNNEL_UP = utc(17, 22, 6, 30)
VALIDATION_CAPTURE = utc(17, 22, 41, 5, 118)
APP07_REBOOT = utc(18, 6, 10, 44)
APP07_FIRST_RESOLVE = utc(18, 6, 11, 31, 506)

WINDOW_START = utc(18, 7, 0, 0)
WINDOW_END = utc(18, 12, 45, 0)

LEDGER_DEPLOY_START = utc(18, 8, 55, 0)
LEDGER_DEPLOY_END = utc(18, 8, 56, 40)

HARDEN_APPLIED = {h: utc(18, 9, 12, 5 + 4 * i, 311) for i, h in enumerate(HOST_NAMES)}
# each host's cached PMTU (1412) expires up to 10 min after it was last learned; after that, black hole
PMTU_EXPIRES = {
    "app-01": utc(18, 9, 18, 21, 640),
    "app-02": utc(18, 9, 21, 47, 92),
    "app-03": utc(18, 9, 14, 36, 505),
    "app-04": utc(18, 9, 19, 55, 813),
    "app-07": utc(18, 9, 16, 12, 288),
}
JUMBO_CHANGE = utc(18, 9, 40, 0)
DNS_FLUSH = {
    "app-05": utc(18, 11, 52, 10, 33),
    "app-06": utc(18, 11, 52, 31, 470),
    "app-07": utc(18, 11, 52, 52, 902),
    "app-08": utc(18, 11, 53, 14, 155),
}
ICMP_ROLLBACK = {h: utc(18, 12, 18, 30 + 3 * i, 120) for i, h in enumerate(HOST_NAMES)}

STALE_HOSTS = ["app-05", "app-06", "app-08"]   # q5 answer = len(STALE_HOSTS)

DIG_TIMES = {
    "app-02": utc(18, 11, 30, 40),
    "app-05": utc(18, 11, 31, 7),
    "app-07": utc(18, 11, 33, 15),
    "app-08": utc(18, 11, 34, 2),
}

CAPTURE_SMALL = utc(18, 10, 30, 58, 104)
CAPTURE_LARGE = utc(18, 10, 31, 7, 412)
CAPTURE_STALE = utc(18, 10, 44, 12, 220)

CLIENT_TIMEOUT_MS = 30000
CONNECT_TIMEOUT_MS = 5000

# last boot (for kernel uptime stamps and the inventory)
LAST_BOOT = {
    "app-01": utc(4, 3, 12, 50),
    "app-02": utc(4, 3, 19, 7),
    "app-03": utc(4, 3, 25, 41),
    "app-04": utc(4, 3, 31, 2),
    "app-05": utc(4, 3, 38, 18),
    "app-06": utc(4, 3, 44, 55),
    "app-07": APP07_REBOOT,
    "app-08": utc(4, 3, 57, 36),
}


def to_local(dt: datetime) -> datetime:
    return dt.astimezone(LOCAL_TZ)
