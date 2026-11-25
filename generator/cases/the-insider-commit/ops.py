"""Operational evidence for `the-insider-commit`: login timing, fleet dpkg logs, profiler output,
GOT audit, chat, mailing list, distro changelog and README_FIRST."""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
CET = timezone(timedelta(hours=1))


def cet(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CET)


# --------------------------------------------------------------------------------------------
# Fleet plan
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class ZfEvent:
    kind: str          # "upgrade" | "fail" | "really"
    when: datetime     # CET-aware
    old: str
    new: str


V546, V550, V551, VREALLY = "5.4.6-1", "5.5.0-1", "5.5.1-1", "5.5.1+really5.5.0-1"
BENCH01_BAD = cet("2026-11-12 14:03:41")
BENCH01_BACK = cet("2026-11-19 16:40:12")
OPENSSH_AT = "2026-11-11 09:31:"
LIBSSL_AT = cet("2026-11-12 10:12:05")


def fleet_plan() -> dict[str, list[ZfEvent]]:
    rnd = random.Random("fleet-plan")
    hosts: dict[str, list[ZfEvent]] = {}

    def t(day: str, h: int, m0: int, m1: int) -> datetime:
        return cet(f"{day} {h:02d}:{rnd.randint(m0, m1):02d}:{rnd.randint(0, 59):02d}")

    def base(h: str) -> list[ZfEvent]:
        return [ZfEvent("upgrade", t("2026-11-02", 6, 2, 40), V546, V550)]

    hosts["bench-01"] = base("bench-01") + [ZfEvent("upgrade", BENCH01_BAD, V550, V551), ZfEvent("really", BENCH01_BACK, V551, VREALLY)]
    hosts["bench-02"] = base("bench-02") + [ZfEvent("upgrade", cet("2026-11-13 09:22:10"), V550, V551)]
    hosts["bench-03"] = base("bench-03")
    hosts["bench-04"] = base("bench-04") + [ZfEvent("fail", cet("2026-11-13 09:25:33"), V550, V551)]
    for i in range(1, 13):
        h = f"web-{i:02d}"
        ev = base(h)
        if i <= 8:
            ev.append(ZfEvent("upgrade", t("2026-11-14", 6, 1, 45), V550, V551))
            if i <= 5:
                ev.append(ZfEvent("really", t("2026-11-19", 18, 5, 50), V551, VREALLY))
        elif i == 11:
            ev.append(ZfEvent("fail", t("2026-11-15", 6, 1, 45), V550, V551))
        else:
            ev.append(ZfEvent("upgrade", t("2026-11-15", 6, 1, 45), V550, V551))
        hosts[h] = ev
    for i in range(1, 9):
        h = f"ci-{i:02d}"
        ev = base(h)
        if i <= 4:
            ev.append(ZfEvent("upgrade", t("2026-11-12", 6, 1, 45), V550, V551))
            ev.append(ZfEvent("really", t("2026-11-19", 19, 2, 40), V551, VREALLY))
        else:
            ev.append(ZfEvent("really", t("2026-11-19", 19, 2, 40), V550, VREALLY))
        hosts[h] = ev
    for i in range(1, 4):
        hosts[f"db-{i:02d}"] = []          # pinned to the stable release, still on 5.4.6
    hosts["bastion-01"] = base("bastion-01") + [ZfEvent("upgrade", t("2026-11-16", 6, 1, 45), V550, V551)]
    hosts["bastion-02"] = base("bastion-02")
    return hosts


def exposed_hosts(plan: dict[str, list[ZfEvent]]) -> list[str]:
    return sorted(h for h, evs in plan.items() if any(e.kind == "upgrade" and e.new == V551 for e in evs))


def bad_window_utc(plan: dict[str, list[ZfEvent]], host: str) -> tuple[datetime, datetime] | None:
    start = end = None
    for e in plan[host]:
        if e.kind == "upgrade" and e.new == V551:
            start = e.when
        if e.kind == "really" and e.old == V551:
            end = e.when
    if start is None:
        return None
    return start.astimezone(UTC), (end or datetime(2100, 1, 1, tzinfo=UTC)).astimezone(UTC)


# --------------------------------------------------------------------------------------------
# dpkg log
# --------------------------------------------------------------------------------------------

def dpkg_upgrade(pkg: str, old: str, new: str, when: datetime) -> list[tuple[datetime, str]]:
    t0, t1 = when - timedelta(seconds=1), when
    return [
        (t0, "startup archives unpack"),
        (t0, f"upgrade {pkg} {old} {new}"),
        (t0, f"status half-configured {pkg} {old}"),
        (t0, f"status unpacked {pkg} {old}"),
        (t0, f"status half-installed {pkg} {old}"),
        (t1, f"status unpacked {pkg} {new}"),
        (t1, "startup packages configure"),
        (t1, f"configure {pkg} {new} <none>"),
        (t1, f"status unpacked {pkg} {new}"),
        (t1, f"status half-configured {pkg} {new}"),
        (t1, f"status installed {pkg} {new}"),
    ]


def dpkg_failed(pkg: str, old: str, new: str, when: datetime) -> list[tuple[datetime, str]]:
    t0 = when - timedelta(seconds=1)
    return [
        (t0, "startup archives unpack"),
        (t0, f"upgrade {pkg} {old} {new}"),
        (t0, f"status half-configured {pkg} {old}"),
        (t0, f"status unpacked {pkg} {old}"),
        (t0, f"status half-installed {pkg} {old}"),
        (when, f"status half-installed {pkg} {old}"),
        (when, f"status unpacked {pkg} {old}"),
        (when, "startup packages configure"),
        (when, f"configure {pkg} {old} {old}"),
        (when, f"status half-configured {pkg} {old}"),
        (when, f"status installed {pkg} {old}"),
    ]


NOISE_PKGS = [("tzdata", "2026b-1", "2026c-1"), ("curl", "8.11.1-1", "8.11.1-2"), ("libcurl4t64:amd64", "8.11.1-1", "8.11.1-2"),
              ("vim-common", "2:9.1.0861-1", "2:9.1.0861-2"), ("python3.13:amd64", "3.13.9-1", "3.13.9-2"),
              ("ca-certificates", "20250419", "20251109"), ("libgnutls30t64:amd64", "3.8.9-2", "3.8.9-3"),
              ("systemd:amd64", "257.9-1", "257.9-2"), ("libsystemd0:amd64", "257.9-1", "257.9-2"),
              ("rsyslog:amd64", "8.2504.0-1", "8.2504.0-2")]


def dpkg_fleet(plan: dict[str, list[ZfEvent]]) -> str:
    rnd = random.Random("dpkg-fleet")
    rows: list[tuple[datetime, str, int, str]] = []
    seq = 0

    def add(host: str, items: list[tuple[datetime, str]]) -> None:
        nonlocal seq
        for when, text in items:
            seq += 1
            rows.append((when, host, seq, text))

    for host, evs in plan.items():
        # daily unattended-upgrades noise
        for d in range(1, 21):
            if rnd.random() < 0.45:
                when = cet(f"2026-11-{d:02d} 06:{rnd.randint(0, 50):02d}:{rnd.randint(0, 59):02d}")
                name, old, new = rnd.choice(NOISE_PKGS)
                add(host, dpkg_upgrade(name if ":" in name else name + ":all" if name in ("tzdata", "ca-certificates", "vim-common") else name + ":amd64", old, new, when))
                add(host, [(when + timedelta(seconds=1), "trigproc man-db:amd64 2.13.0-1 <none>")])
        # openssh bump on every host except db-* (red herring)
        if not host.startswith("db-"):
            w = cet(OPENSSH_AT + f"{rnd.randint(0, 59):02d}") + timedelta(minutes=rnd.randint(0, 90))
            for p in ("openssh-client:amd64", "openssh-sftp-server:amd64", "openssh-server:amd64"):
                add(host, dpkg_upgrade(p, "1:9.6p1-3", "1:9.6p1-4", w))
                w += timedelta(seconds=2)
        if host == "bench-01":
            add(host, dpkg_upgrade("libssl3t64:amd64", "3.0.15-1", "3.0.15-2", LIBSSL_AT))
            add(host, dpkg_upgrade("openssl:amd64", "3.0.15-1", "3.0.15-2", LIBSSL_AT + timedelta(seconds=3)))
        for e in evs:
            if e.kind == "fail":
                add(host, dpkg_failed("libzfold5:amd64", e.old, e.new, e.when))
            else:
                add(host, dpkg_upgrade("libzfold5:amd64", e.old, e.new, e.when))
                add(host, dpkg_upgrade("zfold-utils:amd64", e.old, e.new, e.when + timedelta(seconds=2)))
                add(host, [(e.when + timedelta(seconds=3), "trigproc libc-bin:amd64 2.41-6 <none>"),
                           (e.when + timedelta(seconds=3), "status half-configured libc-bin:amd64 2.41-6"),
                           (e.when + timedelta(seconds=3), "status installed libc-bin:amd64 2.41-6")])
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return "".join(f"{h} {w.strftime('%Y-%m-%d %H:%M:%S')} {txt}\n" for w, h, _, txt in rows)


# --------------------------------------------------------------------------------------------
# Login timing CSV
# --------------------------------------------------------------------------------------------

def timing_csv(plan: dict[str, list[ZfEvent]]) -> tuple[str, datetime]:
    rnd = random.Random("sshd-timing")
    start = datetime(2026, 11, 8, 0, 0, tzinfo=UTC)
    end = datetime(2026, 11, 20, 6, 0, tzinfo=UTC)
    hosts = ["bench-01", "bench-02", "bench-03", "bench-04"]
    base_ms = {"bench-01": 63, "bench-02": 66, "bench-03": 61, "bench-04": 68}
    rows = ["ts_epoch,host,probe_user,result,connect_ms,auth_ms,total_ms"]
    first_slow: datetime | None = None
    last_spike: dict[str, bool] = {h: False for h in hosts}
    t = start
    while t < end:
        for i, h in enumerate(hosts):
            ts = t + timedelta(seconds=7 * i + rnd.randint(0, 3))
            if h == "bench-03" and datetime(2026, 11, 15, 2, 0, tzinfo=UTC) <= ts < datetime(2026, 11, 15, 4, 30, tzinfo=UTC):
                continue  # maintenance window, probe disabled
            sshd_restart = (h.startswith("bench") and ts.strftime("%Y-%m-%d %H") == "2026-11-11 08"
                            and 40 <= ts.minute <= 50 and i % 2 == 0)
            if sshd_restart:
                rows.append(f"{int(ts.timestamp())},{h},probe,refused,,,")
                continue
            conn = max(1, round(rnd.gauss(3.0, 0.8)))
            auth = rnd.gauss(base_ms[h], 5.0)
            win = bad_window_utc(plan, h)
            slow = win is not None and win[0] <= ts < win[1]
            if slow:
                auth += rnd.gauss(507, 9)
                if h == "bench-01" and first_slow is None:
                    first_slow = ts
            if not last_spike[h] and rnd.random() < 0.004:
                auth += rnd.uniform(160, 900)
                last_spike[h] = True
            else:
                last_spike[h] = False
            auth_i = max(20, round(auth))
            rows.append(f"{int(ts.timestamp())},{h},probe,ok,{conn},{auth_i},{conn + auth_i + rnd.randint(2, 6)}")
        t += timedelta(minutes=10)
    if first_slow is None:
        raise SystemExit("timing: bench-01 never slowed down")
    return "\n".join(rows) + "\n", first_slow


# --------------------------------------------------------------------------------------------
# Profiler, GOT audit, benchmarks
# --------------------------------------------------------------------------------------------

PERF_BEFORE = """# perf report --stdio --children --sort comm,dso,sym -i perf-sshd-before.data
# Host bench-01, recorded 2026-11-10 15:20 UTC by elif.v
# Workload: 50 x `ssh -o BatchMode=yes -i ~/.ssh/probe_rsa probe@bench-01 true` (RSA key, run back to back)
# Recorded with: perf record -a -g -F 999 --call-graph dwarf -- sleep 30   (filtered to comm=sshd)
# Packages: openssh-server 1:9.6p1-3, libzfold5 5.5.0-1, libssl3t64 3.0.15-1
#
# Total Lost Samples: 0
#
# Samples: 3K of event 'cpu-clock:ppp'
# Event count (approx.): 3184000000
#
# Children      Self  Command  Shared Object             Symbol
# ........  ........  .......  ........................  ...............................................
#
    41.27%     0.00%  sshd     sshd                      [.] main
    33.88%     0.31%  sshd     sshd                      [.] do_authentication2
    29.91%     0.00%  sshd     sshd                      [.] userauth_pubkey
    27.14%     0.09%  sshd     sshd                      [.] sshkey_verify
    26.70%     0.00%  sshd     sshd                      [.] ssh_rsa_verify
    26.42%     0.47%  sshd     libcrypto.so.3            [.] EVP_PKEY_verify
    24.19%    24.19%  sshd     libcrypto.so.3            [.] bn_mul_mont
    18.56%     0.00%  sshd     ld-linux-x86-64.so.2      [.] _dl_start_final
    18.40%     2.20%  sshd     ld-linux-x86-64.so.2      [.] _dl_relocate_object
    11.03%    11.03%  sshd     ld-linux-x86-64.so.2      [.] _dl_lookup_symbol_x
     7.95%     7.95%  sshd     libcrypto.so.3            [.] sha256_block_data_order_avx2
     5.17%     5.17%  sshd     ld-linux-x86-64.so.2      [.] do_lookup_x
     4.88%     0.00%  sshd     sshd                      [.] kex_exchange_identification
     4.21%     4.21%  sshd     libcrypto.so.3            [.] x25519_fe64_mul
     3.33%     3.33%  sshd     [kernel.kallsyms]         [k] clear_page_erms
     2.71%     2.71%  sshd     libc.so.6                 [.] __memmove_avx_unaligned_erms
     0.04%     0.04%  sshd     libzfold.so.5.5.0         [.] zf_crc64_resolve
     0.02%     0.02%  sshd     libzfold.so.5.5.0         [.] zf_cpu_has_clmul
#
# Per-login CPU in sshd (pre-auth + auth child), from the same capture:
#   mean 61.8 ms   median 61 ms   p95 72 ms   (n=50)
"""

PERF_AFTER = """# perf report --stdio --children --sort comm,dso,sym -i perf-sshd-after.data
# Host bench-01, recorded 2026-11-17 10:05 UTC by elif.v
# Workload: 50 x `ssh -o BatchMode=yes -i ~/.ssh/probe_rsa probe@bench-01 true` (RSA key, run back to back)
# Recorded with: perf record -a -g -F 999 --call-graph dwarf -- sleep 60   (filtered to comm=sshd)
# Packages: openssh-server 1:9.6p1-4, libzfold5 5.5.1-1, libssl3t64 3.0.15-2
#
# Total Lost Samples: 0
#
# Samples: 28K of event 'cpu-clock:ppp'
# Event count (approx.): 28467000000
#
# Children      Self  Command  Shared Object             Symbol
# ........  ........  .......  ........................  ...............................................
#
    90.41%     0.00%  sshd     ld-linux-x86-64.so.2      [.] _dl_start_final
    90.38%     0.18%  sshd     ld-linux-x86-64.so.2      [.] _dl_relocate_object
    88.52%     0.03%  sshd     libzfold.so.5.5.1         [.] zf_crc64_resolve
            |
            ---_dl_start_final
               _dl_relocate_object
               elf_machine_rela (inlined)
               elf_ifunc_invoke (inlined)
               zf_crc64_resolve
               |
               |--58.77%--0x0000000000027f30
               |          |
               |           --41.02%--_dl_lookup_symbol_x
               |
               |--19.62%--0x0000000000028a14
               |
                --10.10%--0x0000000000029330
    58.77%    17.75%  sshd     libzfold.so.5.5.1         [.] 0x0000000000027f30
    41.02%    41.02%  sshd     ld-linux-x86-64.so.2      [.] _dl_lookup_symbol_x
    19.62%    19.62%  sshd     libzfold.so.5.5.1         [.] 0x0000000000028a14
    10.10%    10.10%  sshd     libzfold.so.5.5.1         [.] 0x0000000000029330
     4.61%     0.00%  sshd     sshd                      [.] main
     3.80%     0.02%  sshd     sshd                      [.] do_authentication2
     3.36%     0.00%  sshd     sshd                      [.] userauth_pubkey
     3.05%     0.01%  sshd     sshd                      [.] sshkey_verify
     3.01%     0.00%  sshd     sshd                      [.] ssh_rsa_verify
            |
            ---ssh_rsa_verify
               openssh_RSA_verify (inlined)
               |
                --2.98%--0x0000000000021b40
                          |
                           --2.93%--EVP_PKEY_verify
     2.98%     0.05%  sshd     libzfold.so.5.5.1         [.] 0x0000000000021b40
     2.93%     0.05%  sshd     libcrypto.so.3            [.] EVP_PKEY_verify
     2.71%     2.71%  sshd     libcrypto.so.3            [.] bn_mul_mont
     0.88%     0.88%  sshd     libcrypto.so.3            [.] sha256_block_data_order_avx2
     0.54%     0.54%  sshd     libcrypto.so.3            [.] x25519_fe64_mul
     0.37%     0.37%  sshd     [kernel.kallsyms]         [k] clear_page_erms
#
# Per-login CPU in sshd (pre-auth + auth child), from the same capture:
#   mean 569.3 ms   median 568 ms   p95 584 ms   (n=50)
#
# elif.v: why is a COMPRESSION library's CRC resolver burning ~half a second inside ld.so,
#         in a daemon that never compresses anything? And why is there a libzfold frame
#         between sshd's RSA verify code and libcrypto? Raw addresses = no symbols (stripped).
"""

LIB_RANGES = {
    "/usr/sbin/sshd": (0x55d0c3a00000, 0x55d0c3ab4000),
    "/usr/lib/x86_64-linux-gnu/libsdnotify.so.1.4.2": (0x7f3a9c100000, 0x7f3a9c10c000),
    "/usr/lib/x86_64-linux-gnu/libzfold.so.5.5.1": (0x7f3a9c200000, 0x7f3a9c23e000),
    "/usr/lib/x86_64-linux-gnu/libcrypto.so.3": (0x7f3a9c400000, 0x7f3a9c6f8000),
    "/usr/lib/x86_64-linux-gnu/libz.so.1.3.1": (0x7f3a9c800000, 0x7f3a9c81a000),
    "/usr/lib/x86_64-linux-gnu/libc.so.6": (0x7f3a9cc00000, 0x7f3a9cdd5000),
    "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2": (0x7f3a9d000000, 0x7f3a9d02c000),
}
HOOKED = "RSA_public_decrypt"
HOOK_TARGET = 0x7f3a9c221b40

GOT_IMPORTS: list[tuple[str, str]] = [
    ("BN_bin2bn", "crypto"), ("BN_free", "crypto"), ("BN_new", "crypto"), ("BN_num_bits", "crypto"),
    ("CRYPTO_free", "crypto"), ("DH_free", "crypto"), ("ECDSA_SIG_free", "crypto"), ("EC_KEY_free", "crypto"),
    ("EC_POINT_free", "crypto"), ("ERR_get_error", "crypto"), ("EVP_CIPHER_CTX_free", "crypto"),
    ("EVP_DigestFinal_ex", "crypto"), ("EVP_DigestInit_ex", "crypto"), ("EVP_DigestUpdate", "crypto"),
    ("EVP_MD_CTX_free", "crypto"), ("EVP_MD_CTX_new", "crypto"), ("EVP_PKEY_free", "crypto"),
    ("EVP_PKEY_get1_RSA", "crypto"), ("EVP_PKEY_verify", "crypto"), ("RAND_bytes", "crypto"),
    ("RSA_free", "crypto"), ("RSA_get0_key", "crypto"), ("RSA_new", "crypto"), (HOOKED, "crypto"),
    ("RSA_size", "crypto"), ("RSA_verify", "crypto"),
    ("sd_notify", "sdnotify"), ("inflate", "z"), ("deflate", "z"),
    ("__stack_chk_fail", "c"), ("calloc", "c"), ("close", "c"), ("execv", "c"), ("fork", "c"), ("free", "c"),
    ("getpwnam", "c"), ("malloc", "c"), ("memcpy", "c"), ("open", "c"), ("read", "c"), ("setsockopt", "c"),
    ("strlen", "c"), ("syslog", "c"), ("write", "c"),
]


def got_audit() -> tuple[str, str]:
    rnd = random.Random("got-audit")
    libmap = {"crypto": "/usr/lib/x86_64-linux-gnu/libcrypto.so.3", "sdnotify": "/usr/lib/x86_64-linux-gnu/libsdnotify.so.1.4.2",
              "z": "/usr/lib/x86_64-linux-gnu/libz.so.1.3.1", "c": "/usr/lib/x86_64-linux-gnu/libc.so.6"}
    L = ["# GOT audit of a live sshd pre-auth child on bench-01 (libzfold5 5.5.1-1), 2026-11-17 10:41 UTC, elif.v",
         "# Question: for every function sshd imports, where does its GOT slot point right now?",
         "# A slot should point into the library that defines the function. Addresses are absolute (ASLR, this process only).",
         "",
         "$ sudo gdb -q -p 48211 -batch -ex 'info proc mappings' | awk '$5 ~ /\\.so|sshd/ && $4 == \"0x0\"'",
         "          Start Addr           End Addr       Size     Offset  Perms  objfile"]
    for path, (lo, hi) in LIB_RANGES.items():
        L.append(f"      {lo:#018x} {hi:#018x} {hi - lo:#10x}        0x0  r-xp   {path}")
    L += ["# (only the executable mapping of each object is shown: start .. end of its code)", "",
          "$ sudo gdb -q -p 48211 -batch -x dump-got.py",
          "# dump-got.py walks sshd's .rela.plt and prints each slot and the address stored in it",
          "GOT slot              import                         points to"]
    hits = 0
    slot = 0x55d0c3aaf018
    for name, lib in GOT_IMPORTS:
        if name == HOOKED:
            target = HOOK_TARGET
        else:
            lo, hi = LIB_RANGES[libmap[lib]]
            target = lo + (rnd.randrange(0x1000, (hi - lo) - 0x1000) & ~0xF)
        lo_z, hi_z = LIB_RANGES["/usr/lib/x86_64-linux-gnu/libzfold.so.5.5.1"]
        if lo_z <= target < hi_z:
            hits += 1
        L.append(f"{slot:#018x}    {name:<30} {target:#018x}")
        slot += 8
    if hits != 1:
        raise SystemExit(f"got_audit: expected exactly one slot into libzfold, got {hits}")
    L += ["", "# Same check on bench-03 (libzfold5 5.5.0-1, the control box): every slot points into the",
          "# library that defines the function. No exceptions.", ""]
    return "\n".join(L), HOOKED


HYPERFINE = """# hyperfine, run from the perf team's jump box (all hosts on the same switch)
# Command under test: ssh -o BatchMode=yes -o ControlMaster=no -i ~/.ssh/probe_rsa probe@<host> true

## 2026-11-10 15:05 UTC
Benchmark 1: ssh probe@bench-01 true
  Time (mean ± σ):      98.4 ms ±   4.1 ms    [User: 9.2 ms, System: 3.1 ms]
  Range (min … max):    91.7 ms … 109.8 ms    30 runs

Benchmark 2: ssh probe@bench-03 true
  Time (mean ± σ):      96.9 ms ±   3.8 ms    [User: 9.0 ms, System: 3.2 ms]
  Range (min … max):    90.2 ms … 106.1 ms    30 runs

## 2026-11-17 09:48 UTC
Benchmark 1: ssh probe@bench-01 true
  Time (mean ± σ):     606.2 ms ±   9.7 ms    [User: 9.4 ms, System: 3.0 ms]
  Range (min … max):   589.0 ms … 627.3 ms    30 runs

Benchmark 2: ssh probe@bench-03 true
  Time (mean ± σ):      97.5 ms ±   4.4 ms    [User: 9.1 ms, System: 3.1 ms]
  Range (min … max):    90.8 ms … 108.9 ms    30 runs

Benchmark 3: ssh -o UseDNS=no probe@bench-01 true   (server-side UseDNS already 'no', checked sshd -T)
  Time (mean ± σ):     604.8 ms ±  10.2 ms    [User: 9.3 ms, System: 3.1 ms]

Benchmark 4: ssh probe@bench-01 true  with sshd started as  env LD_BIND_NOW= ZF_NO_IFUNC=1 ...  (no effect, as expected)
  Time (mean ± σ):     607.9 ms ±   8.8 ms

Summary
  The client side is identical. All the extra time is spent on the SERVER, inside sshd, before auth completes.
"""

VALGRIND = """# valgrind on the zfold 5.5.1 Corvid package build tree (bench-01, elif.v, 2026-11-17 13:22 UTC)
$ valgrind --error-exitcode=1 ./src/cli/zf -V
==48803== Memcheck, a memory error detector
==48803== Command: ./src/cli/zf -V
==48803==
==48803== Invalid read of size 8
==48803==    at 0x4867F30: ??? (in /build/zfold-5.5.1/src/.libs/libzfold.so.5.5.1)
==48803==    by 0x4859180: zf_crc64_resolve (crc64_fast.c:14)
==48803==    by 0x4012A1C: _dl_relocate_object (dl-reloc.c:301)
==48803==    by 0x4001F2B: _dl_start_final (rtld.c:507)
==48803==  Address 0x1ffefff7e8 is on thread 1's stack
==48803==
==48803== Invalid write of size 8
==48803==    at 0x4868A14: ??? (in /build/zfold-5.5.1/src/.libs/libzfold.so.5.5.1)
==48803==    by 0x4859191: zf_crc64_resolve (crc64_fast.c:14)
==48803==    by 0x4012A1C: _dl_relocate_object (dl-reloc.c:301)
==48803==
zf 5.5.1
==48803== ERROR SUMMARY: 2 errors from 2 contexts (suppressed: 0 from 0)

# Same command on a build from `git clone` + `git checkout v5.5.1` + ./autogen.sh + configure + make:
==48911== ERROR SUMMARY: 0 errors from 0 contexts (suppressed: 0 from 0)
# Same command on the 5.5.0 Corvid package build tree:
==48925== ERROR SUMMARY: 0 errors from 0 contexts (suppressed: 0 from 0)
"""


# --------------------------------------------------------------------------------------------
# Chat (epoch strings, like Slack)
# --------------------------------------------------------------------------------------------

def chat() -> str:
    msgs = [
        ("2026-11-17 08:52:10", "elif.v", "Morning. Our login probe on bench-01 has been ~500 ms slower for days. Not network: connect_ms is flat. Graph attached (perf/sshd-auth-timing.csv)."),
        ("2026-11-17 08:55:41", "oren.b", "openssh-server got bumped last week (9.6p1-3 -> -4). My money is on that."),
        ("2026-11-17 08:57:03", "oren.b", "or UseDNS. reverse DNS for the probe subnet has been flaky since the resolver change."),
        ("2026-11-17 09:03:18", "elif.v", "UseDNS is already no (sshd -T). And bench-03 got the same openssh bump and is fine."),
        ("2026-11-17 09:10:27", "noa.h", "bench-01 also got the libssl3 update on the 12th. Crypto library, login slowdown... feels related?"),
        ("2026-11-17 09:12:55", "elif.v", "Possible. I'll line the probe timestamps up against dpkg.log properly. Careful: dpkg.log is in local time, the probe CSV is epoch."),
        ("2026-11-17 09:49:30", "elif.v", "hyperfine: bench-01 606 ms vs bench-03 97 ms. All on the server side. Recording perf now."),
        ("2026-11-17 10:20:02", "elif.v", "perf says sshd spends ~0.5 s inside ld.so relocating... libzfold. A compression library. sshd doesn't compress anything."),
        ("2026-11-17 10:22:47", "oren.b", "sshd links libzfold? since when"),
        ("2026-11-17 10:24:10", "noa.h", "Corvid patches sshd to link libsdnotify for readiness notification, and libsdnotify pulls in libzfold for compressed journal fields. So every sshd process loads it."),
        ("2026-11-17 10:31:44", "oren.b", "zfold had a big release in October, the multithreaded decoder one. Thread pool init at load time would explain a startup cost."),
        ("2026-11-17 10:33:12", "elif.v", "bench-03 runs that same big release and logs in in 61 ms. So not that one."),
        ("2026-11-17 10:44:58", "elif.v", "GOT audit of a live sshd child in perf/gdb-got-audit.txt. One slot is not pointing where it should. I'd like a second pair of eyes before I say it out loud."),
        ("2026-11-17 13:30:21", "elif.v", "valgrind complains inside the resolver on the distro build only. A build from git is clean. The tarball and git don't build the same thing."),
        ("2026-11-17 13:41:09", "sam.k", "SecOps here. Stop speculating in this channel, moving to #sec-zfold. Do not upgrade or downgrade anything else yet, we need the evidence intact."),
        ("2026-11-18 16:15:33", "sam.k", "Diffed both release tarballs against their git tags: release/tarball-vs-git-tag.diff. Lots of normal autotools noise in both. Look at what is new in the second one."),
        ("2026-11-18 16:19:50", "noa.h", "Upstream mailing list archive is in mail/. Note how the co-maintainer got the job. And how fast the distro was asked to take the new release."),
        ("2026-11-19 12:02:44", "sam.k", "Corvid has published 5.5.x+really rollback packages. Rolling out to bench-01 and part of web/ci today. Do NOT treat 'has the rollback package' as 'was never exposed'."),
        ("2026-11-19 21:20:15", "sam.k", "Recovered the stage-1 script in a sandbox (release/stage1-recovered.txt, defanged). It only fires on distro package builds on x86-64. That's why upstream CI and the git build look clean."),
        ("2026-11-20 08:05:00", "sam.k", "RCA today. I need: which release, which file, where the payload hides, what it hooks, which commit planted it, and how many hosts ever ran it."),
    ]
    out = []
    for i, (when, user, text) in enumerate(msgs):
        ts = int(cet(when).timestamp())
        out.append({"ts": f"{ts}.{(i + 1) * 100:06d}", "user": user, "text": text})
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


# --------------------------------------------------------------------------------------------
# Mailing list (mbox)
# --------------------------------------------------------------------------------------------

MAIL = [
    ("Matti Lindqvist <matti@zfold.example>", "Thu, 02 Nov 2023 19:03:11 +0200", "Re: [PATCH] doc: fix typo in zf.1 synopsis",
     "Applied, thanks Jun. Small fixes like this are always welcome.\n\nMatti"),
    ("Jun Tarrow <jun.tarrow@mailbox.example>", "Tue, 27 Feb 2024 10:51:02 +0800", "[PATCH 0/3] CMake build support",
     "Hi all,\n\nThis series adds an experimental CMake build next to autotools. It should make\nlife easier for Windows and embedded users. Happy to maintain it.\n\nJun"),
    ("Matti Lindqvist <matti@zfold.example>", "Wed, 28 Feb 2024 22:14:40 +0200", "Re: [PATCH 0/3] CMake build support",
     "Looks good. Merged. Jun, you have been doing a lot of useful work lately, thank you."),
    ("Oskar Brenn <oskar.brenn@freemail.example>", "Mon, 10 Mar 2025 08:12:55 +0000", "Is zfold still maintained?",
     "Patches sit on this list for months. The multithreaded decoder patch has been waiting\nforever. Is this project dead? Distros depend on it. Maybe it needs a new maintainer."),
    ("Matti Lindqvist <matti@zfold.example>", "Mon, 10 Mar 2025 23:40:19 +0200", "Re: Is zfold still maintained?",
     "It is maintained, just slowly. This is an unpaid hobby project and I have limited\nenergy right now for personal reasons. Jun has been helping a lot with reviews."),
    ("Priya Dhal <pdhal@quickmail.example>", "Fri, 04 Apr 2025 14:30:02 +0530", "Re: Is zfold still maintained?",
     "With respect, \"slowly\" is not good enough for a library this important. Over a year\nsince the last feature release. Why not hand it over to someone with time? Jun clearly\nknows the code."),
    ("Oskar Brenn <oskar.brenn@freemail.example>", "Tue, 13 May 2025 09:02:31 +0000", "Re: Is zfold still maintained?",
     "Still nothing. You ignore the community. Submitting patches here is pointless until\nthere is a change of maintainer."),
    ("Matti Lindqvist <matti@zfold.example>", "Wed, 14 May 2025 00:12:47 +0300", "Re: Is zfold still maintained?",
     "I hear you. I'm not burned out on zfold itself, but my ability to care for it has been\nlimited by things outside the project. Jun has been extremely helpful off-list and I\nexpect him to take a bigger role soon."),
    ("Matti Lindqvist <matti@zfold.example>", "Tue, 24 Jun 2025 21:20:33 +0300", "Jun Tarrow is now co-maintainer",
     "Hi all,\n\nJun Tarrow is now a co-maintainer of zfold with commit and release rights. He will\nsign the next release. Thank you, Jun.\n\nMatti"),
    ("Priya Dhal <pdhal@quickmail.example>", "Wed, 25 Jun 2025 07:45:10 +0530", "Re: Jun Tarrow is now co-maintainer",
     "Finally. Congratulations Jun, looking forward to faster releases."),
    ("Jun Tarrow <jun.tarrow@mailbox.example>", "Tue, 27 Oct 2026 11:40:51 +0800", "[ANNOUNCE] zfold 5.5.0",
     "zfold 5.5.0 is out: multithreaded decoder, --threads=0, faster CRC64 on x86-64.\nTarballs and signatures on the release page."),
    ("Jun Tarrow <jun.tarrow@mailbox.example>", "Tue, 03 Nov 2026 09:30:12 +0800", "[PATCH] tests: add trailing-index and large-window test files",
     "Two new binary test files for index and window edge cases. They are generated by a\nlocal script, I will publish it later. Already pushed since it is test-only."),
    ("Jun Tarrow <jun.tarrow@mailbox.example>", "Mon, 09 Nov 2026 18:22:07 +0800", "[ANNOUNCE] zfold 5.5.1",
     "zfold 5.5.1: fixes valgrind warnings some users saw in the CRC64 ifunc resolver and adds\nnew test files. Everyone on 5.5.0 should upgrade."),
    ("Priya Dhal <pdhal@quickmail.example>", "Mon, 09 Nov 2026 21:02:44 +0530", "Re: [ANNOUNCE] zfold 5.5.1",
     "Great. I filed Corvid bug #10442 asking them to take 5.5.1 into unstable quickly, our\nCI is full of valgrind noise. Others should ask their distros too."),
    ("Oskar Brenn <oskar.brenn@freemail.example>", "Tue, 10 Nov 2026 07:15:30 +0000", "Re: [ANNOUNCE] zfold 5.5.1",
     "+1, please get this into every distro before the freeze."),
    ("Matti Lindqvist <matti@zfold.example>", "Fri, 20 Nov 2026 06:58:01 +0200", "zfold 5.5.1 release tarball",
     "I have been told the 5.5.1 release tarball contains files that are not in git. I did not\nprepare that release. I am looking into it with distro security teams. Do not use 5.5.1."),
]


def mbox() -> str:
    out = []
    for i, (frm, date, subj, body) in enumerate(MAIL):
        addr = frm.split("<")[1].rstrip(">")
        out.append(f"From {addr} {date}\nFrom: {frm}\nTo: zfold-devel@lists.zfold.example\nDate: {date}\n"
                   f"Subject: {subj}\nMessage-ID: <zfold-{i + 1:04d}@lists.zfold.example>\n\n{body}\n")
    return "\n".join(out)


CHANGELOG = """zfold (5.5.1+really5.5.0-1) unstable; urgency=critical

  * Revert to upstream 5.5.0. The 5.5.1 release tarball is under investigation.
  * Version kept above 5.5.1-1 so that apt upgrades affected systems.

 -- Mika Stahl <mstahl@corvid.example>  Thu, 19 Nov 2026 10:31:02 +0000

zfold (5.5.1-1) unstable; urgency=medium

  * New upstream release.
    - Fixes valgrind warnings in the CRC64 ifunc resolver (Closes: #10442).
    - New upstream test files.
  * Uploaded at the request of upstream and several users.

 -- Mika Stahl <mstahl@corvid.example>  Tue, 10 Nov 2026 16:02:11 +0000

zfold (5.5.0-1) unstable; urgency=medium

  * New upstream release (multithreaded decoder).
  * libzfold5: bump shlibs.

 -- Mika Stahl <mstahl@corvid.example>  Thu, 29 Oct 2026 08:10:40 +0000

zfold (5.4.6-1) unstable; urgency=medium

  * New upstream release.

 -- Mika Stahl <mstahl@corvid.example>  Sat, 18 Apr 2026 12:44:09 +0000
"""

BUG = """Corvid Linux bug #10442
Package: zfold   Version: 5.5.0-1   Severity: important
Reported-by: Priya Dhal <pdhal@quickmail.example>
Date: Mon, 09 Nov 2026 15:31:20 +0000

Subject: please package zfold 5.5.1 (valgrind errors, test failures)

  Upstream 5.5.1 fixes valgrind errors and adds new test files. Our CI is red because of
  this. Please upload 5.5.1 to unstable as soon as possible.

---- Message #10 ----
From: Oskar Brenn <oskar.brenn@freemail.example>
Date: Tue, 10 Nov 2026 07:20:11 +0000

  Same here, valgrind noise everywhere. +1 for 5.5.1.

---- Message #15 ----
From: Mika Stahl <mstahl@corvid.example>
Date: Tue, 10 Nov 2026 16:05:00 +0000

  Uploaded 5.5.1-1 to unstable. Closing.
  (Note to self: I could not reproduce the valgrind errors on 5.5.0 myself.)

---- Message #22 ----
From: Mika Stahl <mstahl@corvid.example>
Date: Thu, 19 Nov 2026 10:40:55 +0000

  Reopening. 5.5.1 is suspected to be compromised. Rolled back via 5.5.1+really5.5.0-1.
  Neither reporter has replied to e-mail since. Both accounts were created in 2025.
"""


def readme(files: list[tuple[str, str]]) -> str:
    listing = "\n".join(f"  {p:<38} {d}" for p, d in files)
    return f"""IncidentLab case: THE INSIDER COMMIT
=====================================

Halyard Cloud SecOps, Friday 2026-11-20, 08:30 CET.

What we know
------------
On Tuesday Elif (performance engineering) noticed that SSH logins to one of our
benchmark boxes had become about half a second slower. Not the network: the TCP
connect time is flat. Same client, same key, same switch. A second box that got
the same routine updates is fine.

She profiled sshd, found something odd inside a compression library that sshd
loads through Corvid Linux's libsdnotify patch, and escalated to us. Since then we
have pulled the upstream release tarballs, the upstream git history, the upstream
mailing list, Corvid's package build logs and the fleet's dpkg logs.

Corvid has already shipped a rollback package. Several hosts got it. That does not
tell us which hosts were exposed in the first place.

Your job: the RCA. Which release, how it got in, where the payload hid, what it
does to sshd, which commit planted it, and how many of our hosts ever ran it.

Everything here is a fictional reconstruction for training. The payload is not
real code: the "test files" are random bytes and the build script is defanged.

Files
-----
{listing}

Time zones and formats (read this)
----------------------------------
  * fleet/dpkg-all-hosts.log    host LOCAL time, CET = UTC+01:00, no DST in this window.
                                Format: "<host> <YYYY-MM-DD HH:MM:SS> <dpkg.log message>".
                                Lines from all hosts interleaved, sorted by time.
  * perf/sshd-auth-timing.csv   ts_epoch = Unix seconds (UTC). One probe login per host
                                every 10 minutes. auth_ms = time from key offer to
                                auth success, measured on the client.
  * chat/incident-channel.json  ts = Unix seconds as a string (Slack style).
  * perf/*.txt, binary/*.txt    headers state UTC.
  * distro/*                    RFC 2822 dates, +0000. Build logs in UTC.
  * mail/zfold-devel.mbox       each Date: header carries its own offset. The sender's
                                offset is part of the evidence.
  * repo/git-log.txt            git --date=iso: each commit in its author's own offset.

Git
---
repo/git-log.txt is `git log -p --decorate --all --date=iso` of upstream zfold, so you
don't need git. If you have git: `git clone repo/zfold.bundle zfold`.
Binary test files show up in the log as "Binary files ... differ".

Glossary
--------
  tarball      the .tar.gz a maintainer uploads for a release. It is NOT produced by git:
               it also contains files generated by autotools (configure, Makefile.in, ...).
  m4           the macro language autoconf uses to generate the configure script.
  ifunc        a GNU "indirect function": the dynamic linker (ld.so) calls a resolver
               function while loading a library, to choose an implementation.
  GOT          Global Offset Table: the table of function addresses a program jumps
               through to call functions that live in shared libraries.
"""
