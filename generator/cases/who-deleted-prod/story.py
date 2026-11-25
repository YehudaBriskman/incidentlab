"""Canonical constants for case `who-deleted-prod`. SPOILERS: see docs/cases/who-deleted-prod.md.

All datetimes are timezone-aware UTC. The company's servers log in US Eastern (EST, -05:00 in November).
"""
from __future__ import annotations

from datetime import datetime, timezone

CASE_ID = "who-deleted-prod"
SEED = 20261118

UTC = timezone.utc


def utc(day: int, h: int, m: int, s: int) -> datetime:
    return datetime(2026, 11, day, h, m, s, tzinfo=UTC)


ACCOUNT = "111122223333"
REGION = "us-east-1"
EDGE_HOST = "edge.fernhill.example"

# ---------------------------------------------------------------------------------------------- windows
WINDOW_START = utc(17, 22, 0, 0)   # CloudTrail / WAF / flow logs: 17:00 EST on Tue 17 Nov
WINDOW_END = utc(18, 8, 0, 0)      # 03:00 EST on Wed 18 Nov
S3LOG_START = utc(18, 0, 0, 0)     # S3 server access logs of the prod bucket
S3LOG_END = utc(19, 13, 0, 0)

# ---------------------------------------------------------------------------------------------- addresses
ATTACKER_WAF_IP = "203.0.113.77"    # sends the SSRF requests through the WAF  (q1)
ATTACKER_API_IP = "203.0.113.140"   # uses the stolen credentials against the AWS API
SCANNER_IP = "192.0.2.44"           # noisy scanner, blocked by the WAF (red herring)
SCANNER2_IP = "198.51.100.163"      # one-off SSRF probe, blocked (red herring)
LEAK_IP = "192.0.2.201"             # tries the leaked, already deactivated dev key (red herring)
YONI_HOME_IP = "192.0.2.150"        # yoni.ops working from home (insider red herring)
OFFICE_IP = "198.51.100.77"
INSTANCE_PUBLIC_IP = "198.51.100.20"  # EIP of edge-waf-01
INSTANCE_PRIVATE_IP = "10.20.1.15"
NAT_IP = "198.51.100.31"
PARTNER_IMG_IP = "192.0.2.80"
PARTNER_DOCS_IP = "192.0.2.81"
EXAMPLE_COM_IP = "192.0.2.10"

# ---------------------------------------------------------------------------------------------- the instance
INSTANCE_ID = "i-0f3a9c2e7b5d14a86"
ENI = "eni-0c7d1e2f3a4b5c6d7"
ROLE = "fh-waf-edge-role"
# IMDS rotates the role credentials. (access key id, session creationDate)
INSTANCE_KEYS = [
    ("ASIAEXAMPLEQ7H2W0D4R", utc(17, 17, 57, 40)),
    ("ASIAEXAMPLEW7K2QZ4NB", utc(17, 23, 58, 12)),   # served by IMDS at the theft -> q3
    ("ASIAEXAMPLEM3R8T6C1J", utc(18, 4, 1, 30)),
]
STMT_INSTANCES = ["i-07b2d4f6a8c0e1357", "i-0a9c8e7d6b5f40312"]
VPCE = "vpce-0d4c3b2a1f0e9d8c7"
LEAKED_KEY = "AKIAEXAMPLEDANA0LD1Q"

# ---------------------------------------------------------------------------------------------- buckets
PROD_BUCKET = "fh-prod-customer-exports"
ALL_BUCKETS = [
    "fh-cloudtrail-111122223333", "fh-prod-app-logs", "fh-prod-cardholder-vault", PROD_BUCKET,
    "fh-staging-customer-exports", "fh-terraform-state", "fh-waf-config", "fh-waf-logs",
]
EXPORT_DAYS = range(12, 19)        # exports/2026/11/12 .. /18 exist when the attacker lists the bucket
LIFECYCLE_DAYS = 1
LIFECYCLE_RULE_ID = "tmp-cleanup"
EXPIRE_START = utc(19, 0, 9, 12)   # S3 lifecycle worker removes the expired objects
EXPIRE_END = utc(19, 1, 52, 40)
EXFIL_RETRIES = 9                  # objects downloaded twice (must not be double counted)
ROOT_CAUSE_SID = "TempLogMigration"  # q6

# ---------------------------------------------------------------------------------------------- noise / red herrings
MAYA_LOGIN = utc(17, 22, 5, 41)
YONI_LOGIN = utc(17, 22, 27, 9)
YONI_LIFECYCLE = utc(17, 22, 31, 5)
YONI_DELETE_BUCKET = utc(17, 22, 38, 12)
SCANNER2_TIME = utc(17, 23, 14, 6)
LEAK_TRY = utc(18, 1, 10, 33)
SCANNER_SWEEP_START = utc(18, 1, 48, 2)

# ---------------------------------------------------------------------------------------------- the attack
A_BROWSE = utc(18, 3, 19, 52)
A_PROBE_EXT = utc(18, 3, 20, 15)
A_CANARY = utc(18, 3, 22, 41)
A_BLOCKED = utc(18, 3, 24, 5)
A_BLOCKED2 = utc(18, 3, 24, 48)
A_IMDS_ROOT = utc(18, 3, 26, 33)   # first 200 from the metadata service
A_IMDS_LIST = utc(18, 3, 26, 58)   # lists the role name (no credentials yet)
A_CREDS_1 = utc(18, 3, 27, 19)     # first credential fetch -> q2 (22:27:19 EST on 17 Nov)
A_IDDOC = utc(18, 3, 27, 44)
A_USERDATA = utc(18, 3, 28, 10)
A_CREDS_2 = utc(18, 3, 58, 2)      # checks the expiry again (still the same key)

A_API_FIRST = utc(18, 3, 31, 2)
A_CONFIG_GRAB = utc(18, 3, 35, 10)
A_VAULT_TRY = utc(18, 3, 36, 30)
A_EXFIL_START = utc(18, 3, 38, 0)
A_DELETE_TRY = utc(18, 5, 1, 12)
A_DELETE_BUCKET_TRY = utc(18, 5, 2, 40)
A_LIFECYCLE = utc(18, 5, 9, 47)    # the call that deleted prod -> q5
A_API_LAST = utc(18, 5, 13, 55)
