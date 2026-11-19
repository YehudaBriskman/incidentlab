"""Canonical constants for case `3am-outage`. Every generator imports from here.

All datetimes are timezone-aware UTC. See docs/CASE_BIBLE.md for the story.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20261113
CASE_ID = "3am-outage"

UTC = timezone.utc
LOCAL_TZ = timezone(timedelta(hours=2), "IST")  # Asia/Jerusalem, November = UTC+02:00

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
EVIDENCE_DIR = BUILD / "evidence" / CASE_ID
TRUTH_DIR = BUILD / "truth"


def utc(h: int, m: int, s: int, ms: int = 0, day: int = 13) -> datetime:
    return datetime(2026, 11, day, h, m, s, ms * 1000, tzinfo=UTC)


WINDOW_START = utc(0, 0, 0)
WINDOW_END = utc(2, 30, 0)

DEPLOY_V2140 = utc(0, 40, 12)        # decoy deploy
DEPLOY_V2141 = utc(0, 58, 3)         # the bad deploy
BACKUP_START = utc(1, 5, 0)          # red herring
BACKUP_END = utc(1, 22, 40)
ALERT_FIRED = utc(1, 15, 30)
PAYMENTS_DEPLOY = utc(1, 20, 31)     # unrelated noise
ROLLBACK = utc(1, 39, 51)
LAST_5XX_APPROX = utc(1, 40, 25)

NGINX_PROXY_READ_TIMEOUT_S = 30

POISON_ORDER = "ORD-7Q4K9X"
POISON_CUSTOMER = "cus_4417"
POISON_GIFT_MESSAGE = (
    "Happy 30th birthday Noa Love you to the moon and back "
    "you are the best sister in the whole world!!!"
)
POISON_GIFT_MESSAGE_LEN = len(POISON_GIFT_MESSAGE)  # 99

# 9 submissions in total (1 original + 8 retries). First one MUST be 01:12:44.
POISON_ATTEMPTS = [
    utc(1, 12, 44, 118),
    utc(1, 13, 52, 402),
    utc(1, 15, 9, 77),
    utc(1, 17, 41, 905),
    utc(1, 21, 3, 260),
    utc(1, 24, 58, 731),
    utc(1, 29, 16, 44),
    utc(1, 33, 40, 588),
    utc(1, 38, 10, 213),
]
FIRST_5XX = POISON_ATTEMPTS[0] + timedelta(seconds=NGINX_PROXY_READ_TIMEOUT_S)  # 01:13:14.118

INCIDENT_START = POISON_ATTEMPTS[0]
INCIDENT_END = ROLLBACK + timedelta(seconds=35)  # pods fully rolled by ~01:40:26

PODS_V2134 = ["checkout-5c8d7b-h7m2p", "checkout-5c8d7b-q9w4z", "checkout-5c8d7b-t3n8k"]
PODS_V2140 = ["checkout-6b7f9c-a1b2c", "checkout-6b7f9c-d4e5f", "checkout-6b7f9c-g7h8j"]
PODS_V2141 = ["checkout-7d9f8a-x2kq4", "checkout-7d9f8a-m5r7v", "checkout-7d9f8a-p8s1w"]
PODS_ROLLBACK = ["checkout-6b7f9c-k3l9n", "checkout-6b7f9c-u6v2y", "checkout-6b7f9c-z4c8e"]

SYNTHETIC_CUSTOMER = "cus_synthetic"
SYNTHETIC_UA = "Shipfast-Synthetic/1.0"
SYNTHETIC_INTERVAL_S = 30

PEOPLE = {
    "dana.k": "Dana Katz",      # dev who shipped v2.14.1
    "amir.t": "Amir Tal",       # on-call SRE
    "yossi.b": "Yossi Ben-Ami",
    "maya.r": "Maya Rosen",
    "lior.m": "Lior Mizrahi",   # payments
    "noa.s": "Noa Shapira",     # eng manager
}


def to_local(dt: datetime) -> datetime:
    return dt.astimezone(LOCAL_TZ)
