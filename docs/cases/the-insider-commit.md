# CASE BIBLE: "The Insider Commit" (case id: `the-insider-commit`)

> SPOILERS. Instructor/builder reference only. Never ship this file to players.
> Contract for `generator/cases/the-insider-commit/`, `solutions/the-insider-commit/solve.sh`,
> `site/src/content/cases/the-insider-commit*.json` and `content-sealed/the-insider-commit.debrief*.md`.

Audience: working engineers. Target: 10 min orientation + 50-60 min solve. Difficulty: hard.
Inspired by the xz-utils / liblzma backdoor (CVE-2024-3094, 2024). Everything here is fictional:
the library (`zfold`), its people, the distro (Corvid Linux), the company (Halyard Cloud). The
"payload" is seeded random bytes, the m4 macro and stage-1 script are defanged, and the binary
listings are hand-written text. Nothing in the pack is runnable as an attack.

## 1. The true story

**zfold** is a small, old compression library (`libzfold5`, CLI `zf`), maintained for years by
one volunteer, **Matti Lindqvist** (`mlindqvist`). **Corvid Linux** patches OpenSSH so `sshd` links
`libsdnotify` (readiness notification), which links `libzfold`. So every `sshd` process loads
`libzfold`, even though sshd never compresses anything.

**Jun Tarrow** (`jtarrow`, always `+0800`) shows up in Nov 2023 with a typo fix, then two years of
genuinely useful work (CMake, CI, translations, perf). In 2025 two accounts that only ever post in
pressure threads, **Oskar Brenn** and **Priya Dhal**, flood the list with "is zfold dead?", "you
ignore the community", "hand it to someone with time, Jun knows the code". Matti, tired and dealing
with personal issues, makes Jun co-maintainer (2025-06-24). Jun signs every release from 5.4.0, moves
the security contact to his own address (2025-09-04), adds an ifunc-based CRC64 resolver (2026-02-17,
legitimate on its face: this is the hook point), and breaks the CMake Landlock sandbox check with a
stray `.` (2026-05-21, bonus find).

After 5.5.0 (clean, big release: multithreaded decoder) Jun commits two binary "test files"
(2026-11-03, **q5**), regenerates them (2026-11-06), and releases **5.5.1** (2026-11-09). The 5.5.1
**release tarball** contains `m4/build-host-detect.m4`, which is **not in git** (**q2**). Its stock
`m4/gettext.m4` copy calls it, so `configure.ac` never mentions it. The macro locates a file by
content, `grep -aErls "#{4}[[:alnum:]]{5}#{4}$"`, which matches only
`tests/files/bad-3-trailing-index.zf` (marker `####Probe####`, **q3**), un-swaps characters with
`tr`, decompresses it with `zf -d` (the extension `.zf` becomes the command), and pipes the result
to a shell. That stage-1 script only acts on distro package builds (`debian/rules` present,
x86-64 glibc, GNU ld, ifunc on). It carves an object out of the same file and links it in next to
`crc64_fast.o`, replacing the ifunc resolver `zf_crc64_resolve`.

At load time ld.so calls the resolver. The replacement resolver walks the dynamic symbol tables
(that is the **~500 ms**, burnt in `_dl_lookup_symbol_x` and three anonymous libzfold functions)
and rewrites sshd's GOT slot for **`RSA_public_decrypt`** (**q4**) to point at a libzfold function
(`zf_block_param_encoder_0`, offset `0x21b40`). It then returns the normal CRC64 implementation, so
every test passes. The hook passes normal keys through to libcrypto (designed behaviour of the real
backdoor: act only on an attacker-signed key; not modelled here).

A pair of the sockpuppets file Corvid bug #10442 and push for fast adoption. Corvid uploads
5.5.1-1 on 2026-11-10. Halyard's fleet (Corvid unstable on bench/web/ci/bastion) picks it up between
11-12 and 11-16. Elif (perf) notices bench-01 logins are half a second slower, profiles, escalates.
Corvid ships `5.5.1+really5.5.0-1` on 11-19; Halyard rolls part of the fleet back.

## 2. Timeline

| When | Zone in source | Event |
|---|---|---|
| 2023-11-02 14:21 +0800 | git | jtarrow's first commit (typo) |
| 2025-03 .. 05 | mbox | pressure campaign (obrenn, pdhal) |
| 2025-06-24 21:03 +0300 | git/mbox | jtarrow made co-maintainer |
| 2025-09-04 | git | SECURITY.md contact changed to jtarrow |
| 2026-02-17 | git | ifunc CRC64 resolver added |
| 2026-05-21 | git | Landlock check broken with a `.` |
| 2026-10-27 11:02 +0800 | git | tag v5.5.0 (clean) |
| 2026-11-02 ~06:xx CET | dpkg | fleet upgrades 5.4.6-1 -> 5.5.0-1 |
| 2026-11-03 09:17:26 +0800 | git | **fixtures added** (q5 commit) |
| 2026-11-06 10:44:09 +0800 | git | fixtures regenerated (modify, not add) |
| 2026-11-09 18:05:12 +0800 | git | tag v5.5.1 |
| 2026-11-10 16:02 UTC | changelog | Corvid uploads 5.5.1-1 |
| 2026-11-11 ~09:31-11:00 CET | dpkg | openssh 1:9.6p1-3 -> -4 everywhere except db (red herring) |
| 2026-11-12 10:12:05 CET | dpkg | bench-01 libssl3t64 3.0.15-2 (red herring) |
| **2026-11-12 14:03:41 CET = 13:03:41 UTC** | dpkg | **bench-01 installs libzfold5 5.5.1-1** |
| 2026-11-12 13:10:01 UTC | timing CSV | first slow probe on bench-01 (~570 ms) |
| 2026-11-13 09:22:10 CET | dpkg | bench-02 installs 5.5.1-1; bench-04 upgrade fails (unpack error, stays 5.5.0-1) |
| 2026-11-12 .. 16 | dpkg | ci-01..04, web-01..10,12, bastion-01 install 5.5.1-1; web-11 fails |
| 2026-11-17 | chat/perf | Elif profiles, GOT audit, valgrind |
| 2026-11-19 | dpkg | `5.5.1+really5.5.0-1` on bench-01, web-01..05, ci-01..08 (ci-05..08 straight from 5.5.0) |
| 2026-11-20 08:30 CET | README | RCA |

## 3. Questions and answers

Normalization: trim, lowercase, collapse whitespace.

| id | Question | Answer | Where it comes from |
|---|---|---|---|
| q1 | Upstream zfold version that brought the slowdown (`X.Y.Z`) | `5.5.1` | `perf/sshd-auth-timing.csv` (bench-01 jumps at epoch of 13:10:01Z) + `fleet/dpkg-all-hosts.log` (CET: 14:03:41 = 13:03:41Z `status installed libzfold5:amd64 5.5.1-1`). Corroborated by perf report headers, hyperfine, bench-03 control. |
| q2 | File in the bad release tarball that is not in git, not in the previous tarball and not stock autotools output | `m4/build-host-detect.m4` | `release/tarball-vs-git-tag.diff`: collect files diffed against `1970-01-01` in each section; set difference 5.5.1 minus 5.5.0. |
| q3 | Test file the macro decodes (file name) | `bad-3-trailing-index.zf` | grep regex in the m4 (`#{4}[[:alnum:]]{5}#{4}$`) applied to `release/fixture-strings.txt` |
| q4 | sshd import whose GOT slot points into libzfold | `RSA_public_decrypt` | `perf/gdb-got-audit.txt` (maps range of libzfold vs slot targets), corroborated by `perf-report-after.txt` (libzfold `0x21b40` between `ssh_rsa_verify` and libcrypto) and `binary/nm-libzfold.txt` / objdump (`0x21b40` = `zf_block_param_encoder_0`, referenced from the 5.5.1 resolver) |
| q5 | 7-char SHA of the commit that first added the q3 file | build-time value, `build/truth/the-insider-commit.answers.json` (currently `0dec4d2`) | `repo/git-log.txt`: `new file mode` under `diff --git a/tests/files/bad-3-...`; or `git log --diff-filter=A` on the bundle |
| q6 | Distinct hosts that ever had `libzfold5:amd64 5.5.1-1` in status `installed` | `18` | `fleet/dpkg-all-hosts.log` |

q6 traps: counting any line with `5.5.1` gives 24 (catches `5.5.1+really5.5.0-1` on ci-05..08 that
never ran the bad build, plus failed upgrades); counting any `5.5.1-1` line gives 20 (bench-04 and
web-11 have an `upgrade ... 5.5.1-1` line but the unpack failed and they stayed on 5.5.0-1). Counting
lines instead of hosts over-counts too. The 18: bench-01, bench-02, ci-01..04, web-01..10, web-12,
bastion-01.

## 4. Red herrings

1. **openssh-server 1:9.6p1-4** (2026-11-11): installed on bench-03 too, which stays fast. And bench-01
   was fine for a day after it.
2. **libssl3t64 3.0.15-2** on bench-01 the morning of 11-12: about four hours before the jump.
   **Time-zone trap:** a player who reads dpkg's CET times as UTC sees the libzfold5 install at
   "14:03", 53 minutes *after* the first slow probe (13:10Z), and wrongly concludes the previous
   zfold (5.5.0-1) or libssl was running when it broke. Convert CET to UTC first.
3. **UseDNS / reverse DNS**: connect_ms is flat; hyperfine shows the time is server-side CPU; `sshd -T`
   says UseDNS no.
4. **zfold 5.5.0** (the big release with the multithreaded decoder): bench-03 runs it at 61 ms.
5. **Single-probe spikes** in the CSV (network blips): not sustained.
6. **Near-miss markers** in fixtures: `####Probe###`, `####Zf-55####`, `###Hi###`.
7. **The later fixture commit** "regenerate test files" modifies the file, it did not add it.
8. **Signatures**: both tarballs have good signatures. From Jun's key, which is exactly the problem.

## 5. Evidence pack (`build/evidence/the-insider-commit/`)

| Path | Format / zone | Notes |
|---|---|---|
| `README_FIRST.txt` | text | briefing, file list, zones, glossary. No answers. |
| `perf/sshd-auth-timing.csv` | CSV, epoch UTC | 4 bench hosts, every 10 min, 2026-11-08 .. 11-20 06:00Z. `refused` rows during the openssh restart. bench-03 maintenance gap. |
| `perf/hyperfine-ssh-login.txt` | UTC | before/after/control |
| `perf/perf-report-before.txt`, `perf-report-after.txt` | UTC | perf report --children |
| `perf/gdb-got-audit.txt` | text | mappings + 44 GOT slots, exactly one into libzfold |
| `perf/valgrind-zf.txt` | UTC | errors only on the distro 5.5.1 build |
| `fleet/dpkg-all-hosts.log` | CET (+01:00) | `<host> <date> <time> <dpkg msg>`, 29 hosts, ~5.5k lines |
| `release/SHA256SUMS.txt` | UTC | hashes match, gpg good, git archive never matches |
| `release/tarball-vs-git-tag.diff` | `diff -ruN` | two sections, 5.5.0 and 5.5.1 |
| `release/fixture-strings.txt` | `strings -a -f` | 5.5.1 tarball fixtures |
| `release/stage1-recovered.txt` | text | defanged stage-1 (gates, relink idea) |
| `binary/nm-libzfold.txt` | text | 5.5.1 has five symbols that do not exist in git |
| `binary/objdump-zf_crc64_resolve.txt` | text | resolver before/after |
| `distro/changelog`, `buildd-logs.txt`, `bug-10442.txt` | RFC 2822 / UTC | build log 5.5.1 has `executing build-host-detect commands` and links `crc64_probe.o` that was never compiled |
| `mail/zfold-devel.mbox` | per-message offsets | pressure campaign |
| `chat/incident-channel.json` | epoch strings | theories, no answers |
| `repo/git-log.txt`, `repo/zfold.bundle` | git iso | 38 commits, tags v5.0.0..v5.5.1 |

## 6. Build

`python3 generator/cases/the-insider-commit/build.py` (stdlib only, seeded, git with pinned dates,
isolated config, `pack.threads=1`; output is byte-identical across runs). Cross-checks: exactly one
fixture matches the marker regex; the only new tarball-only file in 5.5.1 is the m4; exactly one
GOT slot lands in libzfold; the bench-01 slowdown follows the install within 10 min; the exposed
host set from the log equals the plan.

Solver: `bash solutions/the-insider-commit/solve.sh`.
