#!/usr/bin/env python3
"""Build the evidence pack for IncidentLab case `who-deleted-prod`.

Run from anywhere:  python3 generator/cases/who-deleted-prod/build.py

Python 3.10+ stdlib only. Deterministic: one random.Random(SEED), no wall-clock reads, sorted output.
Story, timeline and answers: docs/cases/who-deleted-prod.md (SPOILERS).

Outputs
  build/evidence/who-deleted-prod/...           the player evidence pack (wiped and recreated)
  build/truth/who-deleted-prod.answers.json     the six answers, plaintext
"""
from __future__ import annotations

import ipaddress
import json
import random
import shutil
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True  # keep the generator folder clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
import story as S  # noqa: E402
import texts  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
EVID = ROOT / "build" / "evidence" / S.CASE_ID
TRUTH = ROOT / "build" / "truth"

RNG = random.Random(S.SEED)
UTC = timezone.utc
EST = timezone(timedelta(hours=-5))


def die(msg: str) -> None:
    print(f"[{S.CASE_ID}] BUILD CHECK FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


# ----------------------------------------------------------------------------------------------
# small helpers
def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def waf_time(t: datetime) -> str:
    return t.astimezone(EST).strftime("%d/%b/%Y:%H:%M:%S -0500")


def s3_time(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%d/%b/%Y:%H:%M:%S +0000")


def epoch(t: datetime) -> int:
    return int(t.timestamp())


def hexs(n: int, upper: bool = False) -> str:
    v = f"{RNG.getrandbits(n * 4):0{n}x}"
    return v.upper() if upper else v


def uid() -> str:
    return str(uuid.UUID(int=RNG.getrandbits(128), version=4))


B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def b64ish(n: int) -> str:
    return "".join(RNG.choice(B64) for _ in range(n))


def rand_between(a: datetime, b: datetime) -> datetime:
    span = int((b - a).total_seconds() * 1000)
    return a + timedelta(milliseconds=RNG.randrange(max(span, 1)))


if EVID.exists():
    shutil.rmtree(EVID)
EVID.mkdir(parents=True)


def write(rel: str, content: str) -> None:
    p = EVID / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


# ----------------------------------------------------------------------------------------------
# address pools (all RFC 5737 documentation ranges, minus the reserved story addresses)
RESERVED = {
    S.ATTACKER_WAF_IP, S.ATTACKER_API_IP, S.SCANNER_IP, S.SCANNER2_IP, S.LEAK_IP, S.YONI_HOME_IP,
    S.OFFICE_IP, S.INSTANCE_PUBLIC_IP, S.NAT_IP, S.PARTNER_IMG_IP, S.PARTNER_DOCS_IP, S.EXAMPLE_COM_IP,
}
CLIENT_POOL = [
    f"{net}.{i}"
    for net in ("192.0.2", "198.51.100", "203.0.113")
    for i in range(2, 255)
    if f"{net}.{i}" not in RESERVED
]
BOT_IPS = RNG.sample(CLIENT_POOL, 6)
CLIENTS = [ip for ip in CLIENT_POOL if ip not in BOT_IPS]

BROWSERS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "FernhillApp/7.12.0 (iOS 18.1; iPhone15,2)",
    "FernhillApp/7.12.0 (Android 14; Pixel 8)",
]
BOT_UAS = [
    "Mozilla/5.0 zgrab/0.x",
    "python-requests/2.31.0",
    "Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)",
    "Go-http-client/1.1",
]

# ==============================================================================================
# 1. WAF / reverse-proxy access log  (local time, US Eastern, -0500)
# ==============================================================================================
waf_lines: list[tuple[datetime, str]] = []
flow_seed: list[tuple[datetime, str, int, str]] = []  # (time, client ip, bytes out, kind)


def waf(t: datetime, ip: str, method: str, uri: str, status: int, nbytes: int, ua: str,
        upstream: str, waf_action: str = "pass", rule: str = "-", ref: str = "-", rt: float | None = None,
        host: str = S.EDGE_HOST) -> None:
    if rt is None:
        rt = round(RNG.uniform(0.004, 0.180), 3)
    line = (f'{ip} - - [{waf_time(t)}] "{method} {uri} HTTP/1.1" {status} {nbytes} "{ref}" "{ua}" '
            f"host={host} upstream={upstream} rt={rt:.3f} waf={waf_action} rule={rule} rid={hexs(32)}")
    waf_lines.append((t, line))
    flow_seed.append((t, ip, nbytes, "in"))


APP_PATHS = [
    ("GET", "/", 200, (18000, 26000), "10.20.2.40:8080"),
    ("GET", "/login", 200, (9000, 12000), "10.20.2.40:8080"),
    ("POST", "/api/v1/session", 200, (600, 900), "10.20.2.31:8080"),
    ("GET", "/api/v1/accounts/me", 200, (1200, 2400), "10.20.2.31:8080"),
    ("GET", "/api/v1/accounts/me/transactions?page=1", 200, (4000, 9000), "10.20.2.31:8080"),
    ("GET", "/api/v1/statements?year=2026", 200, (2000, 5000), "10.20.2.32:8080"),
    ("GET", "/api/v1/cards", 200, (900, 1800), "10.20.2.31:8080"),
    ("GET", "/static/app.4f9c2a.js", 200, (310000, 312000), "10.20.2.40:8080"),
    ("GET", "/static/app.4f9c2a.css", 200, (48000, 49000), "10.20.2.40:8080"),
    ("GET", "/static/img/logo.svg", 304, (0, 0), "10.20.2.40:8080"),
    ("GET", "/help/articles/dispute-a-charge", 200, (14000, 17000), "10.20.2.41:8080"),
    ("GET", "/help/articles/download-statements", 200, (13000, 16000), "10.20.2.41:8080"),
    ("GET", "/favicon.ico", 200, (4286, 4286), "10.20.2.40:8080"),
]
APP_WEIGHTS = [10, 6, 5, 9, 7, 4, 4, 8, 8, 6, 2, 2, 3]

t = S.WINDOW_START
while t < S.WINDOW_END:
    # quieter in the middle of the US night
    hour_est = t.astimezone(EST).hour
    rate = 0.9 if hour_est in (17, 18, 19, 20) else 0.6 if hour_est in (21, 22) else 0.25
    t += timedelta(milliseconds=int(RNG.expovariate(rate) * 1000) + 1)
    if t >= S.WINDOW_END:
        break
    method, path, status, (lo, hi), up = RNG.choices(APP_PATHS, APP_WEIGHTS)[0]
    ip = RNG.choice(CLIENTS)
    if path == "/api/v1/accounts/me" and RNG.random() < 0.04:
        status, lo, hi = 401, 112, 112
    waf(t, ip, method, path, status, RNG.randint(lo, hi), RNG.choice(BROWSERS), up,
        ref=f"https://{S.EDGE_HOST}/" if path.startswith("/static") else "-")

# legitimate link previews from the help-center editor (staff, mostly the office)
PREVIEW_TARGETS = [
    ("https://img.partner.example/cards/visa-signature.png", S.PARTNER_IMG_IP, (38000, 52000)),
    ("https://img.partner.example/promo/holiday-2026.jpg", S.PARTNER_IMG_IP, (120000, 160000)),
    ("https://docs.partner.example/rates/2026-q4.html", S.PARTNER_DOCS_IP, (9000, 15000)),
    ("https://img.partner.example/icons/apple-pay.svg", S.PARTNER_IMG_IP, (2000, 3000)),
]
staff_ips = [S.OFFICE_IP, S.OFFICE_IP, S.OFFICE_IP, RNG.choice(CLIENTS), RNG.choice(CLIENTS)]
staff_ua = BROWSERS[1]
for _ in range(46):
    tt = rand_between(S.WINDOW_START, S.WINDOW_START + timedelta(hours=5))
    url, up, (lo, hi) = RNG.choice(PREVIEW_TARGETS)
    waf(tt, RNG.choice(staff_ips), "GET", f"/proxy/fetch?u={url}", 200, RNG.randint(lo, hi), staff_ua,
        f"{up}:443", ref=f"https://{S.EDGE_HOST}/help/editor")
    flow_seed.append((tt, up, 0, "fetch443"))

# internet background radiation: bots probing well-known paths
BOT_PATHS = ["/.env", "/wp-login.php", "/.git/config", "/phpmyadmin/", "/actuator/env", "/server-status",
             "/admin/config.php", "/cgi-bin/luci", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php"]
for _ in range(140):
    tt = rand_between(S.WINDOW_START, S.WINDOW_END)
    waf(tt, RNG.choice(BOT_IPS), "GET", RNG.choice(BOT_PATHS), RNG.choice([404, 404, 404, 403]),
        RNG.choice([153, 162, 548]), RNG.choice(BOT_UAS), "10.20.2.40:8080")

# scanner #1 (192.0.2.44): a noisy sweep incl. two metadata probes the WAF blocks
sc_t = S.SCANNER_SWEEP_START
scanner_uris = BOT_PATHS + ["/proxy/fetch?u=http://169.254.169.254/latest/meta-data/",
                            "/?url=http://169.254.169.254/", "/proxy/fetch?u=file:///etc/passwd",
                            "/api/v1/../../etc/passwd", "/.aws/credentials", "/proxy/fetch?u=http://localhost:22/"]
for i, uri in enumerate(sorted(scanner_uris * 3, key=lambda _: RNG.random())):
    sc_t += timedelta(milliseconds=RNG.randint(900, 7000))
    if "169.254.169.254" in uri:
        waf(sc_t, S.SCANNER_IP, "GET", uri, 403, 146, "Mozilla/5.0 zgrab/0.x", "-", "block", "100231")
    elif "file://" in uri or "localhost" in uri:
        waf(sc_t, S.SCANNER_IP, "GET", uri, 502, 157, "Mozilla/5.0 zgrab/0.x", "-")
    elif "/etc/passwd" in uri:
        waf(sc_t, S.SCANNER_IP, "GET", uri, 403, 146, "Mozilla/5.0 zgrab/0.x", "-", "block", "930100")
    else:
        waf(sc_t, S.SCANNER_IP, "GET", uri, 404, 153, "Mozilla/5.0 zgrab/0.x", "10.20.2.40:8080")
# scanner #1 also knocks on the metadata address via the Host header
waf(S.SCANNER_SWEEP_START + timedelta(seconds=95), S.SCANNER_IP, "GET", "/latest/meta-data/", 403, 146,
    "Mozilla/5.0 zgrab/0.x", "-", "block", "100230", host="169.254.169.254")

# scanner #2 (198.51.100.x): a one-off SSRF probe hours earlier, also blocked
waf(S.SCANNER2_TIME, S.SCANNER2_IP, "GET", "/proxy/fetch?u=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F",
    403, 146, "python-requests/2.31.0", "-", "block", "100231")
waf(S.SCANNER2_TIME + timedelta(seconds=2), S.SCANNER2_IP, "GET", "/proxy/fetch?u=http://169.254.169.254/",
    403, 146, "python-requests/2.31.0", "-", "block", "100231")

# the attacker (203.0.113.77). Times are fixed in story.py
DEC = str(int(ipaddress.IPv4Address("169.254.169.254")))
IMDS = "169.254.169.254:80"
ATT_UA = "curl/8.5.0"
role_path = f"/latest/meta-data/iam/security-credentials/{S.ROLE}"
attacker_waf = [
    (S.A_BROWSE, "GET", "/", 200, 21877, BROWSERS[4], "10.20.2.40:8080", "pass", "-"),
    (S.A_PROBE_EXT, "GET", "/proxy/fetch?u=http://www.example.com/", 200, 1256, ATT_UA, f"{S.EXAMPLE_COM_IP}:80", "pass", "-"),
    (S.A_CANARY, "GET", f"/proxy/fetch?u=http://{S.ATTACKER_WAF_IP}:8000/c", 200, 2, ATT_UA, f"{S.ATTACKER_WAF_IP}:8000", "pass", "-"),
    (S.A_BLOCKED, "GET", "/proxy/fetch?u=http://169.254.169.254/latest/meta-data/", 403, 146, ATT_UA, "-", "block", "100231"),
    (S.A_BLOCKED2, "GET", "/proxy/fetch?u=http://[::ffff:169.254.169.254]/latest/meta-data/", 403, 146, ATT_UA, "-", "block", "100231"),
    (S.A_IMDS_ROOT, "GET", f"/proxy/fetch?u=http://{DEC}/latest/meta-data/", 200, 312, ATT_UA, IMDS, "pass", "-"),
    (S.A_IMDS_LIST, "GET", f"/proxy/fetch?u=http://{DEC}/latest/meta-data/iam/security-credentials/", 200, len(S.ROLE), ATT_UA, IMDS, "pass", "-"),
    (S.A_CREDS_1, "GET", f"/proxy/fetch?u=http://{DEC}{role_path}", 200, 1308, ATT_UA, IMDS, "pass", "-"),
    (S.A_IDDOC, "GET", f"/proxy/fetch?u=http://{DEC}/latest/dynamic/instance-identity/document", 200, 476, ATT_UA, IMDS, "pass", "-"),
    (S.A_USERDATA, "GET", f"/proxy/fetch?u=http://{DEC}/latest/user-data", 404, 233, ATT_UA, IMDS, "pass", "-"),
    (S.A_CREDS_2, "GET", f"/proxy/fetch?u=http://{DEC}{role_path}", 200, 1308, ATT_UA, IMDS, "pass", "-"),
]
for (tt, m, uri, st, nb, ua, up, act, rule) in attacker_waf:
    waf(tt, S.ATTACKER_WAF_IP, m, uri, st, nb, ua, up, act, rule, rt=0.003 if up == IMDS else None)
flow_seed.append((S.A_CANARY, S.ATTACKER_WAF_IP, 0, "fetch8000"))
flow_seed.append((S.A_PROBE_EXT, S.EXAMPLE_COM_IP, 0, "fetch80"))

waf_lines.sort(key=lambda x: x[0])
write("waf/access.log", "".join(line + "\n" for _, line in waf_lines))
write("waf/edge-waf.conf", texts.WAF_CONF)

# cross-check: exactly one client IP got a 200 from the metadata upstream, and its first creds fetch
imds_ok = [(tt, line) for tt, line in waf_lines if f"upstream={IMDS}" in line and '" 200 ' in line]
if {ln.split()[0] for _, ln in imds_ok} != {S.ATTACKER_WAF_IP}:
    die("metadata 200s must come from exactly one client IP")
creds = [tt for tt, ln in imds_ok if f"security-credentials/{S.ROLE} " in ln]
if min(creds) != S.A_CREDS_1:
    die("first credential fetch time mismatch")

# ==============================================================================================
# 2. CloudTrail (JSON lines, UTC) + S3 server access logs for the prod exports bucket
# ==============================================================================================
ct: list[tuple[datetime, dict]] = []
s3log: list[tuple[datetime, str]] = []
S3_OWNER = hexs(64)

TLS = {"tlsVersion": "TLSv1.3", "cipherSuite": "TLS_AES_128_GCM_SHA256"}


def role_identity(role: str, role_id: str, session: str, key: str, created: datetime,
                  delivery: str | None) -> dict:
    ctx: dict = {
        "sessionIssuer": {"type": "Role", "principalId": role_id,
                          "arn": f"arn:aws:iam::{S.ACCOUNT}:role/{role}", "accountId": S.ACCOUNT, "userName": role},
        "attributes": {"creationDate": iso(created), "mfaAuthenticated": "false"},
    }
    if delivery:
        ctx["ec2RoleDelivery"] = delivery
    return {"type": "AssumedRole", "principalId": f"{role_id}:{session}",
            "arn": f"arn:aws:sts::{S.ACCOUNT}:assumed-role/{role}/{session}", "accountId": S.ACCOUNT,
            "accessKeyId": key, "sessionContext": ctx}


def ct_event(tt: datetime, ident: dict, source: str, name: str, ip: str, ua: str, req: dict | None = None,
             resp: dict | None = None, err: str | None = None, msg: str | None = None, read_only: bool = True,
             data: bool = False, resources: list | None = None, extra: dict | None = None,
             vpce: str | None = None, host: str | None = None) -> dict:
    ev: dict = {"eventVersion": "1.10" if data else "1.09", "userIdentity": ident, "eventTime": iso(tt),
                "eventSource": source, "eventName": name, "awsRegion": S.REGION, "sourceIPAddress": ip,
                "userAgent": ua}
    if err:
        ev["errorCode"] = err
        ev["errorMessage"] = msg
    ev["requestParameters"] = req
    ev["responseElements"] = resp
    if extra is not None:
        ev["additionalEventData"] = extra
    ev["requestID"] = hexs(16, upper=True) if source == "s3.amazonaws.com" else uid()
    ev["eventID"] = uid()
    ev["readOnly"] = read_only
    if resources:
        ev["resources"] = resources
    ev["eventType"] = "AwsApiCall"
    ev["managementEvent"] = not data
    ev["recipientAccountId"] = S.ACCOUNT
    if vpce:
        ev["vpcEndpointId"] = vpce
        ev["vpcEndpointAccountId"] = S.ACCOUNT
    ev["eventCategory"] = "Data" if data else "Management"
    if host:
        ev["tlsDetails"] = dict(TLS, clientProvidedHostHeader=host)
    ct.append((tt, ev))
    return ev


S3_OPS = {
    "GetObject": "REST.GET.OBJECT", "PutObject": "REST.PUT.OBJECT", "ListObjects": "REST.GET.BUCKET",
    "GetBucketLocation": "REST.GET.LOCATION", "DeleteObject": "REST.DELETE.OBJECT",
    "DeleteBucket": "REST.DELETE.BUCKET", "GetBucketVersioning": "REST.GET.VERSIONING",
    "GetBucketLifecycle": "REST.GET.LIFECYCLE", "PutBucketLifecycle": "REST.PUT.LIFECYCLE",
}
S3_ERR_STATUS = {"AccessDenied": 403, "NoSuchKey": 404, "NoSuchLifecycleConfiguration": 404}


def s3_call(tt: datetime, ident: dict | None, requester_arn: str, ip: str, ua: str, name: str, bucket: str,
            key: str | None = None, nbytes: int = 0, objsize: int | None = None, err: str | None = None,
            msg: str | None = None, req_extra: dict | None = None, vpce: str | None = None,
            in_ct: bool = True) -> None:
    host = f"{bucket}.s3.{S.REGION}.amazonaws.com"
    data = name in ("GetObject", "PutObject", "ListObjects", "DeleteObject")
    read_only = name.startswith(("Get", "List"))
    req: dict = {"bucketName": bucket, "Host": host}
    if key:
        req["key"] = key
    if name == "ListObjects":
        req.update({"list-type": "2", "prefix": key or "", "encoding-type": "url"})
        req.pop("key", None)
    if req_extra:
        req.update(req_extra)
    resources = None
    if data:
        resources = []
        if key and name != "ListObjects":
            resources.append({"type": "AWS::S3::Object", "ARN": f"arn:aws:s3:::{bucket}/{key}"})
        resources.append({"accountId": S.ACCOUNT, "type": "AWS::S3::Bucket", "ARN": f"arn:aws:s3:::{bucket}"})
    extra = {"SignatureVersion": "SigV4", "CipherSuite": "TLS_AES_128_GCM_SHA256",
             "bytesTransferredIn": objsize if (name == "PutObject" and objsize) else 0,
             "AuthenticationMethod": "AuthHeader", "x-amz-id-2": b64ish(76),
             "bytesTransferredOut": nbytes if not err else 0}
    reqid = hexs(16, upper=True)
    if in_ct and ident is not None and S.WINDOW_START <= tt < S.WINDOW_END:
        ev = ct_event(tt, ident, "s3.amazonaws.com", name, ip, ua, req=req, err=err, msg=msg,
                      read_only=read_only, data=data, resources=resources, extra=extra, vpce=vpce, host=host)
        ev["requestID"] = reqid
    if bucket == S.PROD_BUCKET and S.S3LOG_START <= tt < S.S3LOG_END:
        op = S3_OPS[name]
        status = S3_ERR_STATUS.get(err or "", 200)
        if name in ("DeleteObject", "DeleteBucket") and not err:
            status = 204
        if name == "ListObjects":
            uri = f"GET /?list-type=2&prefix={key or ''}&encoding-type=url HTTP/1.1"
            k = "-"
        elif name in ("GetBucketLocation", "GetBucketVersioning", "GetBucketLifecycle", "PutBucketLifecycle", "DeleteBucket"):
            q = {"GetBucketLocation": "location", "GetBucketVersioning": "versioning"}.get(name, "lifecycle")
            verb = {"PutBucketLifecycle": "PUT", "DeleteBucket": "DELETE"}.get(name, "GET")
            uri = f"{verb} /{'' if name == 'DeleteBucket' else '?' + q} HTTP/1.1"
            k = "-"
        else:
            verb = {"PutObject": "PUT", "DeleteObject": "DELETE"}.get(name, "GET")
            uri = f"{verb} /{key} HTTP/1.1"
            k = key or "-"
        sent = nbytes if (name == "GetObject" and not err) else (243 if err else 0)
        osz = objsize if objsize is not None and not err else "-"
        tot = RNG.randint(400, 2400) if sent > 100000 else RNG.randint(8, 60)
        line = (f"{S3_OWNER} {bucket} [{s3_time(tt)}] {ip} {requester_arn} {reqid} {op} {k} \"{uri}\" "
                f"{status} {err or '-'} {sent if sent else '-'} {osz} {tot} {max(1, tot // 9)} \"-\" \"{ua}\" - "
                f"{b64ish(76)} SigV4 TLS_AES_128_GCM_SHA256 AuthHeader {host} TLSv1.3 - -")
        s3log.append((tt, line))


# ---------------- prod exports bucket inventory ----------------
objects: dict[str, tuple[datetime, int]] = {}  # key -> (created, size)
for day in S.EXPORT_DAYS:
    n = RNG.randint(38, 46)
    created0 = datetime(2026, 11, day, 2, 0, 5, tzinfo=UTC)
    for i in range(n):
        k = f"exports/2026/11/{day:02d}/customers-part-{i:04d}.csv.gz"
        objects[k] = (created0 + timedelta(seconds=11 * i + RNG.randint(0, 9)), RNG.randint(38_000_000, 61_000_000))
    objects[f"manifests/2026-11-{day:02d}.json"] = (created0 + timedelta(seconds=11 * n + 20), RNG.randint(9000, 14000))

# ---------------- principals ----------------
WAF_ROLE_ID = "AROAEXAMPLEWAFEDGE7Q1"
K = S.INSTANCE_KEYS  # [(key, created), ...] in order


def instance_ident(tt: datetime) -> dict:
    key, created = [k for k in K if k[1] <= tt][-1]
    return role_identity(S.ROLE, WAF_ROLE_ID, S.INSTANCE_ID, key, created, "1.0")


def attacker_ident() -> dict:
    key, created = [k for k in K if k[1] <= S.A_CREDS_1][-1]
    return role_identity(S.ROLE, WAF_ROLE_ID, S.INSTANCE_ID, key, created, "1.0")


WAF_ARN = f"arn:aws:sts::{S.ACCOUNT}:assumed-role/{S.ROLE}/{S.INSTANCE_ID}"
SHIPPER_UA = "aws-sdk-go-v2/1.30.3 os/linux lang/go#1.22.5 md/GOOS#linux md/GOARCH#amd64 api/s3#1.58.2 waf-logshipper/3.4.1"
SSM_UA = "aws-sdk-go/1.44.302 (go1.22.5; linux; amd64) amazon-ssm-agent/3.3.987.0"


def cli_ua(cmd: str) -> str:
    return ("aws-cli/2.17.43 md/awscrt#0.21.2 ua/2.0 os/linux#6.5.0-41-generic md/arch#x86_64 lang/python#3.11.9 "
            f"md/pyimpl#CPython cfg/retry-mode#standard md/installer#exe md/distrib#ubuntu.22 md/prompt#off md/command#{cmd}")


# ---------------- the WAF instance itself (legit) ----------------
tt = S.WINDOW_START + timedelta(seconds=37)
i = 0
while tt < S.WINDOW_END:
    s3_call(tt, instance_ident(tt), WAF_ARN, S.INSTANCE_PUBLIC_IP, SHIPPER_UA, "PutObject", "fh-waf-logs",
            f"edge-waf-01/{tt:%Y/%m/%d/%H%M}.log.gz", objsize=RNG.randint(180_000, 900_000))
    if i % 3 == 0:
        for key in ("rules/edge-rules.conf", "rules/allowlist.txt"):
            t2 = tt + timedelta(seconds=RNG.randint(2, 20))
            s3_call(t2, instance_ident(t2), WAF_ARN, S.INSTANCE_PUBLIC_IP, SHIPPER_UA, "GetObject",
                    "fh-waf-config", key, nbytes=RNG.choice([18233, 18233, 18240]) if "rules" in key and "edge" in key else 2911)
    if i % 12 == 5:
        for key in ("geoip/geo-blocklist.dat", "bots/bad-bots.txt"):
            t2 = tt + timedelta(seconds=RNG.randint(25, 50))
            s3_call(t2, instance_ident(t2), WAF_ARN, S.INSTANCE_PUBLIC_IP, SHIPPER_UA, "GetObject",
                    "fh-waf-config", key, nbytes=4_812_004 if "geo" in key else 7731)
    t3 = tt + timedelta(seconds=RNG.randint(60, 200))
    if t3 < S.WINDOW_END:
        ct_event(t3, instance_ident(t3), "ssm.amazonaws.com", "UpdateInstanceInformation", S.INSTANCE_PUBLIC_IP,
                 SSM_UA, req={"instanceId": S.INSTANCE_ID, "agentVersion": "3.3.987.0", "agentStatus": "Active",
                              "platformType": "Linux", "platformName": "Amazon Linux", "platformVersion": "2023",
                              "iPAddress": S.INSTANCE_PRIVATE_IP, "computerName": "ip-10-20-1-15.ec2.internal"},
                 read_only=False)
    tt += timedelta(minutes=5, seconds=RNG.randint(-3, 3))
    i += 1

# ---------------- statements API (legit, IMDSv2, via VPC endpoint) ----------------
STMT_ROLE_ID = "AROAEXAMPLESTMTAPI3K9"
STMT_SESSIONS = [(S.STMT_INSTANCES[0], "ASIAEXAMPLESTMT01AA7", datetime(2026, 11, 17, 21, 12, 40, tzinfo=UTC)),
                 (S.STMT_INSTANCES[1], "ASIAEXAMPLESTMT02BB3", datetime(2026, 11, 17, 21, 40, 2, tzinfo=UTC))]
STMT_IPS = {S.STMT_INSTANCES[0]: "10.30.4.11", S.STMT_INSTANCES[1]: "10.30.4.12"}
STMT_UA = "aws-sdk-java/2.28.11 Linux/6.1.112-124.190.amzn2023.x86_64 OpenJDK_64-Bit_Server_VM/21.0.5+11-LTS Java/21.0.5 vendor/Amazon.com_Inc. io/sync http/Apache cfg/retry-mode/standard statements-api/4.2.0"


expire_times: dict[str, datetime] = {}
tt = S.WINDOW_START
while tt < S.S3LOG_END:
    hr = tt.astimezone(EST).hour
    gap = RNG.randint(25, 70) if 7 <= hr <= 22 else RNG.randint(60, 200)
    tt += timedelta(seconds=gap, milliseconds=RNG.randint(0, 999))
    sess, key_id, created = RNG.choice(STMT_SESSIONS)
    existing = [k for k, (c, _) in objects.items() if c <= tt and k.startswith("exports/")]
    if not existing:
        continue
    k = RNG.choice(existing)
    ident = role_identity("fh-statements-api-role", STMT_ROLE_ID, sess, key_id, created, "2.0")
    arn = f"arn:aws:sts::{S.ACCOUNT}:assumed-role/fh-statements-api-role/{sess}"
    gone = k in expire_times and expire_times[k] <= tt
    if gone:
        s3_call(tt, ident, arn, STMT_IPS[sess], STMT_UA, "GetObject", S.PROD_BUCKET, k,
                err="NoSuchKey", msg="The specified key does not exist.", vpce=S.VPCE)
    else:
        s3_call(tt, ident, arn, STMT_IPS[sess], STMT_UA, "GetObject", S.PROD_BUCKET, k,
                nbytes=objects[k][1], objsize=objects[k][1], vpce=S.VPCE)

# ---------------- nightly export batch (legit) ----------------
BATCH_ROLE_ID = "AROAEXAMPLEBATCHEXP2M"
batch_ident = role_identity("fh-export-batch-role", BATCH_ROLE_ID, "fh-nightly-export", "ASIAEXAMPLEBATCH9X2Q",
                            datetime(2026, 11, 18, 1, 59, 51, tzinfo=UTC), None)
BATCH_ARN = f"arn:aws:sts::{S.ACCOUNT}:assumed-role/fh-export-batch-role/fh-nightly-export"
BATCH_UA = "Boto3/1.35.54 md/Botocore#1.35.54 ua/2.0 os/linux#5.10.227-239.884.amzn2.x86_64 md/arch#x86_64 lang/python#3.12.7 md/pyimpl#CPython exec-env/AWS_Lambda_python3.12 cfg/retry-mode#legacy Botocore/1.35.54"
for k, (created, size) in sorted(objects.items(), key=lambda x: x[1][0]):
    if created.date() == datetime(2026, 11, 18).date():
        s3_call(created, batch_ident, BATCH_ARN, S.NAT_IP, BATCH_UA, "PutObject", S.PROD_BUCKET, k, objsize=size)
# day-19 batch is outside the CloudTrail window but lands in the S3 access log
day19: dict[str, tuple[datetime, int]] = {}
n19 = RNG.randint(38, 46)
for i in range(n19):
    k = f"exports/2026/11/19/customers-part-{i:04d}.csv.gz"
    c = datetime(2026, 11, 19, 2, 0, 5, tzinfo=UTC) + timedelta(seconds=11 * i + RNG.randint(0, 9))
    day19[k] = (c, RNG.randint(38_000_000, 61_000_000))
    s3_call(c, None, BATCH_ARN, S.NAT_IP, BATCH_UA,
            "PutObject", S.PROD_BUCKET, k, objsize=day19[k][1], in_ct=False)

# ---------------- humans and services (noise + red herrings) ----------------
SSO_ADMIN = "AWSReservedSSO_PlatformAdmin_5c2e9a1f7b3d4e60"
SSO_RO = "AWSReservedSSO_ReadOnly_8d1f4c7a2b9e6035"
CONSOLE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
yoni = role_identity(SSO_ADMIN, "AROAEXAMPLESSOADMIN4F", "yoni.ops@fernhill.example", "ASIAEXAMPLESSOY0N7P1",
                     S.YONI_LOGIN, None)
maya = role_identity(SSO_RO, "AROAEXAMPLESSOREAD82C", "maya.k@fernhill.example", "ASIAEXAMPLESSOM4Y1K8",
                     S.MAYA_LOGIN, None)


def console_login(tt: datetime, ident: dict, ip: str) -> None:
    ev = ct_event(tt, {k: v for k, v in ident.items() if k != "accessKeyId"}, "signin.amazonaws.com",
                  "ConsoleLogin", ip, CONSOLE_UA, resp={"ConsoleLogin": "Success"}, read_only=False)
    ev["eventType"] = "AwsConsoleSignIn"
    ev["additionalEventData"] = {"MobileVersion": "No", "MFAUsed": "Yes"}


console_login(S.MAYA_LOGIN, maya, S.OFFICE_IP)
for j in range(14):
    t2 = S.MAYA_LOGIN + timedelta(seconds=40 + j * RNG.randint(30, 90))
    name = RNG.choice(["DescribeInstances", "DescribeSecurityGroups", "DescribeAlarms", "GetMetricData"])
    src = "monitoring.amazonaws.com" if name in ("DescribeAlarms", "GetMetricData") else "ec2.amazonaws.com"
    ct_event(t2, maya, src, name, S.OFFICE_IP, "AWS Internal", req={"maxResults": 100})

# yoni.ops: change CHG-4471, staging cleanup from home (the "insider" red herring)
console_login(S.YONI_LOGIN, yoni, S.YONI_HOME_IP)
ct_event(S.YONI_LOGIN + timedelta(seconds=41), yoni, "s3.amazonaws.com", "ListBuckets", S.YONI_HOME_IP,
         "[S3Console/0.4, aws-internal/3 aws-sdk-java/1.12.769]", req={"Host": "s3.amazonaws.com"})
STG = "fh-staging-customer-exports"
OLD = "fh-staging-exports-2023"
ct_event(S.YONI_LIFECYCLE, yoni, "s3.amazonaws.com", "PutBucketLifecycle", S.YONI_HOME_IP,
         "[S3Console/0.4, aws-internal/3 aws-sdk-java/1.12.769]", read_only=False,
         req={"bucketName": STG, "Host": f"{STG}.s3.{S.REGION}.amazonaws.com", "lifecycle": "",
              "LifecycleConfiguration": {"xmlns": "http://s3.amazonaws.com/doc/2006-03-01/",
                                         "Rule": {"ID": "expire-staging-30d", "Status": "Enabled",
                                                  "Filter": {"Prefix": "exports/"}, "Expiration": {"Days": 30}}}},
         resources=[{"accountId": S.ACCOUNT, "type": "AWS::S3::Bucket", "ARN": f"arn:aws:s3:::{STG}"}],
         host=f"{STG}.s3.{S.REGION}.amazonaws.com")
yoni_ua = "[S3Console/0.4, aws-internal/3 aws-sdk-java/1.12.769]"
t2 = S.YONI_LIFECYCLE + timedelta(seconds=95)
ct_event(t2, yoni, "s3.amazonaws.com", "ListObjects", S.YONI_HOME_IP, yoni_ua,
         req={"bucketName": OLD, "Host": f"{OLD}.s3.{S.REGION}.amazonaws.com", "list-type": "2", "prefix": ""},
         data=True, resources=[{"accountId": S.ACCOUNT, "type": "AWS::S3::Bucket", "ARN": f"arn:aws:s3:::{OLD}"}])
for j in range(6):
    t2 += timedelta(seconds=RNG.randint(3, 9))
    ct_event(t2, yoni, "s3.amazonaws.com", "DeleteObject", S.YONI_HOME_IP, yoni_ua, read_only=False, data=True,
             req={"bucketName": OLD, "Host": f"{OLD}.s3.{S.REGION}.amazonaws.com",
                  "key": f"exports/2023/12/customers-part-{j:04d}.csv.gz"},
             resources=[{"type": "AWS::S3::Object", "ARN": f"arn:aws:s3:::{OLD}/exports/2023/12/customers-part-{j:04d}.csv.gz"},
                        {"accountId": S.ACCOUNT, "type": "AWS::S3::Bucket", "ARN": f"arn:aws:s3:::{OLD}"}])
ct_event(S.YONI_DELETE_BUCKET, yoni, "s3.amazonaws.com", "DeleteBucket", S.YONI_HOME_IP, yoni_ua, read_only=False,
         req={"bucketName": OLD, "Host": f"{OLD}.s3.{S.REGION}.amazonaws.com"},
         resources=[{"accountId": S.ACCOUNT, "type": "AWS::S3::Bucket", "ARN": f"arn:aws:s3:::{OLD}"}],
         host=f"{OLD}.s3.{S.REGION}.amazonaws.com")

# AWS Config (service-linked role) polling
cfg = role_identity("AWSServiceRoleForConfig", "AROAEXAMPLECONFIGSLR1", "AWSConfig-Describe",
                    "ASIAEXAMPLECONFIG7HZ", datetime(2026, 11, 17, 21, 30, 0, tzinfo=UTC), None)
tt = S.WINDOW_START + timedelta(minutes=4)
while tt < S.WINDOW_END:
    for name, src in (("DescribeInstances", "ec2.amazonaws.com"), ("GetBucketPolicy", "s3.amazonaws.com"),
                      ("ListAttachedRolePolicies", "iam.amazonaws.com"), ("DescribeSecurityGroups", "ec2.amazonaws.com")):
        ct_event(tt + timedelta(seconds=RNG.randint(0, 50)), cfg, src, name, "config.amazonaws.com",
                 "config.amazonaws.com", req={"maxResults": 100})
    tt += timedelta(minutes=30)

# leaked (already deactivated) dev key tried from the internet: fails
dana_ident = {"type": "IAMUser", "principalId": "AIDAEXAMPLEDANADEV4Q", "arn": f"arn:aws:iam::{S.ACCOUNT}:user/dana.dev",
              "accountId": S.ACCOUNT, "accessKeyId": S.LEAKED_KEY, "userName": "dana.dev"}
for j, (name, src) in enumerate([("GetCallerIdentity", "sts.amazonaws.com"), ("ListBuckets", "s3.amazonaws.com"),
                                 ("GetCallerIdentity", "sts.amazonaws.com"), ("DescribeInstances", "ec2.amazonaws.com"),
                                 ("ListUsers", "iam.amazonaws.com"), ("GetCallerIdentity", "sts.amazonaws.com")]):
    ct_event(S.LEAK_TRY + timedelta(seconds=j * RNG.randint(8, 30)), dana_ident, src, name, S.LEAK_IP,
             "python-requests/2.31.0 Boto3/1.34.0", err="InvalidClientTokenId",
             msg="The security token included in the request is invalid.")

# ---------------- the attacker, with the stolen instance credentials ----------------
A = attacker_ident()
AIP = S.ATTACKER_API_IP
ct_event(S.A_API_FIRST, A, "sts.amazonaws.com", "GetCallerIdentity", AIP, cli_ua("sts.get-caller-identity"))
ct_event(S.A_API_FIRST + timedelta(seconds=38), A, "s3.amazonaws.com", "ListBuckets", AIP, cli_ua("s3.ls"),
         req={"Host": "s3.amazonaws.com"})
ta = S.A_API_FIRST + timedelta(seconds=63)
for b in S.ALL_BUCKETS:
    ta += timedelta(seconds=RNG.randint(4, 14))
    s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.ls"), "GetBucketLocation", b,
            req_extra={"location": ""})
    ta += timedelta(seconds=RNG.randint(1, 4))
    if b == "fh-terraform-state":
        s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.ls"), "ListObjects", b, err="AccessDenied",
                msg=f"User: {WAF_ARN} is not authorized to perform: s3:ListBucket on resource: \"arn:aws:s3:::{b}\" "
                    "with an explicit deny in a resource-based policy")
    else:
        s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.ls"), "ListObjects", b)
ta = S.A_CONFIG_GRAB
for key in ("rules/edge-rules.conf", "rules/allowlist.txt", "nginx/edge-waf.conf"):
    ta += timedelta(seconds=RNG.randint(3, 9))
    s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.cp"), "GetObject", "fh-waf-config", key,
            nbytes={"rules/edge-rules.conf": 18233, "rules/allowlist.txt": 2911}.get(key, 6204))
ta = S.A_VAULT_TRY
for j in range(5):
    ta += timedelta(seconds=RNG.randint(2, 6))
    s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.cp"), "GetObject", "fh-prod-cardholder-vault",
            f"vault/2026/11/pan-tokens-{j:03d}.parquet", err="AccessDenied",
            msg=f"User: {WAF_ARN} is not authorized to perform: kms:Decrypt on the resource associated with this "
                "ciphertext because no identity-based policy allows the kms:Decrypt action")

# bulk download of the exports
listing = sorted(k for k, (c, _) in objects.items() if k.startswith("exports/") and c <= S.A_EXFIL_START)
ta = S.A_EXFIL_START
exfil_ok: set[tuple[str, str]] = {("fh-waf-config", k) for k in ("rules/edge-rules.conf", "rules/allowlist.txt", "nginx/edge-waf.conf")}
retry_idx = set(RNG.sample(range(len(listing)), S.EXFIL_RETRIES))
for n, k in enumerate(listing):
    size = objects[k][1]
    ta += timedelta(seconds=size / 3_600_000 + RNG.uniform(0.3, 2.5))
    s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.cp"), "GetObject", S.PROD_BUCKET, k, nbytes=size, objsize=size)
    exfil_ok.add((S.PROD_BUCKET, k))
    if n in retry_idx:
        ta += timedelta(seconds=size / 3_600_000 + RNG.uniform(0.3, 1.5))
        s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.cp"), "GetObject", S.PROD_BUCKET, k, nbytes=size, objsize=size)
    if k.endswith("customers-part-0000.csv.gz") and "/18/" in k:
        for miss in ("exports/2026/11/18/_SUCCESS", "exports/2026/11/18/_manifest.json", "exports/2026/11/19/customers-part-0000.csv.gz"):
            ta += timedelta(seconds=RNG.uniform(1, 3))
            s3_call(ta, A, WAF_ARN, AIP, cli_ua("s3.cp"), "GetObject", S.PROD_BUCKET, miss,
                    err="NoSuchKey", msg="The specified key does not exist.")
if ta >= S.A_DELETE_TRY:
    die(f"exfil overruns the delete attempt ({iso(ta)})")

# trying to destroy prod: explicit deny on delete, then the lifecycle rule
DENY = "with an explicit deny in an identity-based policy"
victim = listing[0]
s3_call(S.A_DELETE_TRY, A, WAF_ARN, AIP, cli_ua("s3api.delete-object"), "DeleteObject", S.PROD_BUCKET, victim,
        err="AccessDenied", msg=f"User: {WAF_ARN} is not authorized to perform: s3:DeleteObject on resource: "
                                f"\"arn:aws:s3:::{S.PROD_BUCKET}/{victim}\" {DENY}")
s3_call(S.A_DELETE_TRY + timedelta(seconds=52), A, WAF_ARN, AIP, cli_ua("s3.rm"), "DeleteObject", S.PROD_BUCKET,
        listing[1], err="AccessDenied", msg=f"User: {WAF_ARN} is not authorized to perform: s3:DeleteObject on "
                                            f"resource: \"arn:aws:s3:::{S.PROD_BUCKET}/{listing[1]}\" {DENY}")
s3_call(S.A_DELETE_BUCKET_TRY, A, WAF_ARN, AIP, cli_ua("s3api.delete-bucket"), "DeleteBucket", S.PROD_BUCKET,
        err="AccessDenied", msg=f"User: {WAF_ARN} is not authorized to perform: s3:DeleteBucket on resource: "
                                f"\"arn:aws:s3:::{S.PROD_BUCKET}\" {DENY}")
s3_call(S.A_DELETE_BUCKET_TRY + timedelta(seconds=74), A, WAF_ARN, AIP, cli_ua("s3api.get-bucket-versioning"),
        "GetBucketVersioning", S.PROD_BUCKET, req_extra={"versioning": ""})
s3_call(S.A_DELETE_BUCKET_TRY + timedelta(seconds=139), A, WAF_ARN, AIP, cli_ua("s3api.get-bucket-lifecycle-configuration"),
        "GetBucketLifecycle", S.PROD_BUCKET, err="NoSuchLifecycleConfiguration",
        msg="The lifecycle configuration does not exist", req_extra={"lifecycle": ""})
s3_call(S.A_LIFECYCLE, A, WAF_ARN, AIP, cli_ua("s3api.put-bucket-lifecycle-configuration"), "PutBucketLifecycle",
        S.PROD_BUCKET, req_extra={"lifecycle": "", "LifecycleConfiguration": {
            "xmlns": "http://s3.amazonaws.com/doc/2006-03-01/",
            "Rule": {"ID": S.LIFECYCLE_RULE_ID, "Status": "Enabled", "Filter": {"Prefix": ""},
                     "Expiration": {"Days": S.LIFECYCLE_DAYS}}}})
s3_call(S.A_LIFECYCLE + timedelta(seconds=33), A, WAF_ARN, AIP, cli_ua("s3api.get-bucket-lifecycle-configuration"),
        "GetBucketLifecycle", S.PROD_BUCKET, req_extra={"lifecycle": ""})
ct_event(S.A_API_LAST, A, "sts.amazonaws.com", "GetCallerIdentity", AIP, cli_ua("sts.get-caller-identity"))

# ---------------- lifecycle expirations (S3 access log only; no CloudTrail event) ----------------
# Retro-fit statements reads that happen after expiry: regenerate those lines below.
all_objs = dict(objects)
all_objs.update(day19)
for k in sorted(all_objs):
    created, _ = all_objs[k]
    d = (created + timedelta(days=S.LIFECYCLE_DAYS)).date()
    eligible = datetime(d.year, d.month, d.day, tzinfo=UTC) + timedelta(days=1)
    if eligible <= S.EXPIRE_START:
        expire_times[k] = rand_between(S.EXPIRE_START, S.EXPIRE_END)
for k, et in expire_times.items():
    line = (f"{S3_OWNER} {S.PROD_BUCKET} [{s3_time(et)}] - AmazonS3 {hexs(16, upper=True)} S3.EXPIRE.OBJECT {k} "
            f"\"-\" - - - {all_objs[k][1]} - - \"-\" \"-\" - - - - - - - - -")
    s3log.append((et, line))

# statements reads after expiry must 404: rewrite the affected S3 log lines (reads after the CloudTrail window)
fixed: list[tuple[datetime, str]] = []
for tt, line in s3log:
    parts = line.split(" ")
    if (" REST.GET.OBJECT " in line and "fh-statements-api-role" in line and parts[8] in expire_times
            and expire_times[parts[8]] <= tt):
        line = line.replace('HTTP/1.1" 200 - ', 'HTTP/1.1" 404 NoSuchKey ', 1)
        segs = line.split('" 404 NoSuchKey ', 1)
        rest = segs[1].split(" ")
        rest[0] = "243"
        rest[1] = "-"
        line = segs[0] + '" 404 NoSuchKey ' + " ".join(rest)
    fixed.append((tt, line))
s3log = fixed

# ---------------- write CloudTrail, split by UTC day ----------------
ct.sort(key=lambda x: (x[0], x[1]["eventID"]))
by_day: dict[str, list[str]] = {}
for tt, ev in ct:
    by_day.setdefault(tt.strftime("%Y%m%d"), []).append(json.dumps(ev, separators=(",", ":")))
ct_files = []
for day, lines in sorted(by_day.items()):
    rel = f"cloudtrail/{S.ACCOUNT}_CloudTrail_{S.REGION}_{day}.jsonl"
    write(rel, "\n".join(lines) + "\n")
    ct_files.append(rel)

# ---------------- write S3 access logs, split by UTC day ----------------
s3log.sort(key=lambda x: x[0])
s3_by_day: dict[str, list[str]] = {}
for tt, line in s3log:
    s3_by_day.setdefault(tt.strftime("%Y-%m-%d"), []).append(line)
s3_files = []
for day, lines in sorted(s3_by_day.items()):
    rel = f"s3-access-logs/{S.PROD_BUCKET}/{day}.log"
    write(rel, "\n".join(lines) + "\n")
    s3_files.append(rel)

# ---------------- cross-checks on what was actually written ----------------
att_events = [ev for _, ev in ct if ev["sourceIPAddress"] == AIP]
keys_used = {ev["userIdentity"]["accessKeyId"] for ev in att_events}
outside = {ev["userIdentity"]["accessKeyId"] for _, ev in ct
           if ev["userIdentity"].get("sessionContext", {}).get("sessionIssuer", {}).get("userName") == S.ROLE
           and ev["sourceIPAddress"] not in (S.INSTANCE_PUBLIC_IP, S.INSTANCE_PRIVATE_IP)}
if keys_used != outside or len(outside) != 1:
    die(f"expected exactly one access key used outside the instance, got {sorted(outside)}")
stolen_key = next(iter(outside))
if stolen_key != [k for k in K if k[1] <= S.A_CREDS_1][-1][0]:
    die("stolen key is not the one IMDS served at the first credential fetch")
got = {(ev["requestParameters"]["bucketName"], ev["requestParameters"]["key"]) for ev in att_events
       if ev["eventName"] == "GetObject" and "errorCode" not in ev}
if got != exfil_ok:
    die("attacker GetObject set mismatch")
q4 = len(got)
s3_att = {ln.split(" ")[8] for _, ln in s3log if f" {AIP} " in ln and " REST.GET.OBJECT " in ln and '" 200 ' in ln}
if len(s3_att) != len([1 for b, _ in got if b == S.PROD_BUCKET]):
    die("S3 access log and CloudTrail disagree on exfiltrated prod objects")
writes = [ev for ev in att_events if not ev["readOnly"] and "errorCode" not in ev
          and (ev.get("requestParameters") or {}).get("bucketName") == S.PROD_BUCKET]
if [ev["eventName"] for ev in writes] != ["PutBucketLifecycle"]:
    die(f"attacker successful writes on prod: {[ev['eventName'] for ev in writes]}")
if not expire_times:
    die("no lifecycle expirations written")
# the instance itself must use all three keys, so 'which key' really needs the source IP
inst_keys = {ev["userIdentity"]["accessKeyId"] for _, ev in ct if ev["sourceIPAddress"] == S.INSTANCE_PUBLIC_IP}
if inst_keys != {k for k, _ in K}:
    die("instance should have used every rotated key")

# ==============================================================================================
# 3. VPC flow logs for the WAF instance ENI (v2 default format, epoch seconds)
# ==============================================================================================
flows: list[tuple[int, str]] = []
agg: dict[tuple[str, int, str], int] = {}
for tt, ip, nb, kind in flow_seed:
    minute = epoch(tt) // 600 * 600  # default 10-minute aggregation interval
    agg[(ip, minute, kind)] = agg.get((ip, minute, kind), 0) + max(nb, 200)
for (ip, minute, kind), nb in sorted(agg.items()):
    start = minute + RNG.randint(0, 9)
    end = minute + 600 + RNG.randint(0, 5)
    sport = RNG.randint(32768, 60999)
    pk_in = max(3, nb // 9000 + RNG.randint(2, 6))
    if kind == "in":
        flows.append((start, f"2 {S.ACCOUNT} {S.ENI} {ip} {S.INSTANCE_PRIVATE_IP} {sport} 443 6 {pk_in} {RNG.randint(900, 4200)} {start} {end} ACCEPT OK"))
        flows.append((start, f"2 {S.ACCOUNT} {S.ENI} {S.INSTANCE_PRIVATE_IP} {ip} 443 {sport} 6 {max(3, nb // 1400)} {nb + RNG.randint(400, 2000)} {start} {end} ACCEPT OK"))
    else:
        dport = {"fetch443": 443, "fetch8000": 8000, "fetch80": 80}[kind]
        flows.append((start, f"2 {S.ACCOUNT} {S.ENI} {S.INSTANCE_PRIVATE_IP} {ip} {sport} {dport} 6 {RNG.randint(4, 9)} {RNG.randint(400, 900)} {start} {end} ACCEPT OK"))
        flows.append((start, f"2 {S.ACCOUNT} {S.ENI} {ip} {S.INSTANCE_PRIVATE_IP} {dport} {sport} 6 {RNG.randint(4, 40)} {RNG.randint(600, 60000)} {start} {end} ACCEPT OK"))
# port probes the security group rejects
for ip, base in ([(S.SCANNER_IP, S.SCANNER_SWEEP_START - timedelta(minutes=3))]
                 + [(b, rand_between(S.WINDOW_START, S.WINDOW_END)) for b in BOT_IPS]):
    for port in (22, 23, 3389, 8080, 6379, 9200, 5432):
        st = epoch(base) // 60 * 60 + RNG.randint(0, 50)
        flows.append((st, f"2 {S.ACCOUNT} {S.ENI} {ip} {S.INSTANCE_PRIVATE_IP} {RNG.randint(32768, 60999)} {port} 6 1 44 {st} {st + 58} REJECT OK"))
flows.sort(key=lambda x: x[0])
write(f"vpc-flow-logs/{S.ENI}.log",
      "version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status\n"
      + "".join(line + "\n" for _, line in flows))
if any("169.254.169.254" in ln for _, ln in flows):
    die("flow logs must not contain IMDS traffic")

# ==============================================================================================
# 4. config snapshots, GuardDuty, Slack, ticket, README
# ==============================================================================================
write("ec2/describe-instances.json", json.dumps(texts.describe_instances(S), indent=2) + "\n")
write(f"iam/roles/{S.ROLE}.json", json.dumps(texts.waf_role(S), indent=2) + "\n")
write("iam/roles/fh-statements-api-role.json", json.dumps(texts.stmt_role(S), indent=2) + "\n")
write("iam/access-keys.csv", texts.ACCESS_KEYS_CSV.format(leaked=S.LEAKED_KEY))
write("guardduty/findings.json", json.dumps(texts.guardduty(S), indent=2) + "\n")
write("guardduty/suppression-rules.json", json.dumps(texts.guardduty_filters(S), indent=2) + "\n")
write("slack/inc-prod-exports.json", json.dumps(texts.slack(S), indent=2, ensure_ascii=False) + "\n")
write("tickets/CHG-4471.txt", texts.CHANGE_TICKET)

files = sorted(str(p.relative_to(EVID)) for p in EVID.rglob("*") if p.is_file()) + ["README_FIRST.txt"]
write("README_FIRST.txt", texts.readme(sorted(files)))

# ==============================================================================================
# 5. answers + final checks
# ==============================================================================================
answers = {
    "q1": S.ATTACKER_WAF_IP,
    "q2": S.A_CREDS_1.strftime("%H:%M:%S"),
    "q3": stolen_key,
    "q4": str(q4),
    "q5": "PutBucketLifecycle",
    "q6": S.ROOT_CAUSE_SID,
}
policy_sids = [st["Sid"] for st in texts.waf_role(S)["RolePolicies"][0]["PolicyDocument"]["Statement"]]
if S.ROOT_CAUSE_SID not in policy_sids:
    die("root-cause Sid missing from the role policy")
readme_text = (EVID / "README_FIRST.txt").read_text(encoding="utf-8").lower()
for q, a in answers.items():
    if a.lower() in readme_text:
        die(f"README_FIRST.txt leaks the answer to {q}")
total = 0
for p in EVID.rglob("*"):
    if p.is_file():
        sz = p.stat().st_size
        if sz > 15 * 1024 * 1024:
            die(f"{p} is over 15 MB")
        total += sz
if total > 40 * 1024 * 1024:
    die("evidence directory over 40 MB")

TRUTH.mkdir(parents=True, exist_ok=True)
with open(TRUTH / f"{S.CASE_ID}.answers.json", "w", encoding="utf-8", newline="\n") as fh:
    fh.write(json.dumps({"caseId": S.CASE_ID, "answers": answers}, indent=2) + "\n")
print(f"[{S.CASE_ID}] evidence -> {EVID.relative_to(ROOT)} ({total / 1024 / 1024:.1f} MB), "
      f"truth -> build/truth/{S.CASE_ID}.answers.json")
