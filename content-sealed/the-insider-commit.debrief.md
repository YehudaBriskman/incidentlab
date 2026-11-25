## What actually happened

**zfold** is a small, old compression library with one tired volunteer maintainer, Matti. Corvid Linux patches OpenSSH so that `sshd` links `libsdnotify`, which links `libzfold`. So every sshd process on Corvid loads a compression library it never uses.

In 2023 a newcomer, **Jun Tarrow**, sent a typo fix. Then two years of genuinely good work: CMake support, CI, translations, a faster index parser. In 2025 two accounts that never wrote a line of code (**Oskar Brenn** and **Priya Dhal**) pressured Matti on the mailing list for months: *"is zfold dead?"*, *"you ignore the community"*, *"hand it to someone with time, Jun knows the code"*. Matti made Jun co-maintainer in June 2025.

From there Jun signed every release, moved the security contact to his own address, added an **ifunc** resolver for CRC64 (a legitimate feature, and the future hook point), and quietly broke the CMake Landlock sandbox check with a single stray `.`.

After the clean **5.5.0** release, Jun committed two binary "test files" and released **5.5.1**. The release **tarball** contained `m4/build-host-detect.m4`, a file **that is not in git**. The tarball's copy of the stock `gettext.m4` called it, so `configure.ac` never mentioned it.

## How the build-time injection worked

1. `configure` runs the macro. It never names its input: it finds it by content, `grep -aErls "#{4}[[:alnum:]]{5}#{4}$"`, which matches only `tests/files/bad-3-trailing-index.zf` (marker line `####Probe####`).
2. It swaps characters back with `tr`, decompresses the result with the project's own `zf -d` (the file extension `.zf` *becomes* the command name), and pipes it to a shell.
3. That stage-1 script only acts when it is a **distro package build** on x86-64 glibc with GNU ld and ifunc enabled. Upstream CI, a developer checkout and a build from git all look clean.
4. It carves an object out of the same test file and links it in next to `crc64_fast.o`, replacing the ifunc resolver `zf_crc64_resolve`.

The build log shows it if you know where to look: a new line `config.status: executing build-host-detect commands`, and a link line with `libzfold_la-crc64_probe.o`, an object that was never compiled.

## Where the half-second went

ld.so calls ifunc resolvers **while it relocates the library**, before `main()`, before any login. The replacement resolver walks the dynamic symbol tables of the process (that is the ~500 ms, spent in `_dl_lookup_symbol_x` and three anonymous functions inside libzfold) and rewrites one entry in sshd's **GOT**: `RSA_public_decrypt` now points at `zf_block_param_encoder_0` inside libzfold. Then it returns the normal CRC64 implementation, so CRC64 works and every test passes.

In the real attack the hook passed ordinary keys through to libcrypto and only acted on a key signed by the attacker. This case does not model that part.

## Timeline

| When | Source zone | Event |
|---|---|---|
| 2023-11-02 | git (+0800) | Jun's first commit, a typo fix |
| 2025-03 to 05 | mbox | Pressure campaign by two sockpuppet accounts |
| 2025-06-24 | git, mbox | Jun becomes co-maintainer |
| 2025-09-04 | git | Security contact moved to Jun |
| 2026-02-17 | git | ifunc CRC64 resolver added |
| 2026-05-21 | git | Landlock check broken by a stray `.` |
| 2026-10-27 | git | v5.5.0 (clean) |
| 2026-11-03 | git | **The two test files are added** |
| 2026-11-06 | git | Test files "regenerated" |
| 2026-11-09 | git | v5.5.1 released; tarball contains the extra m4 |
| 2026-11-10 | distro | Corvid uploads 5.5.1-1 after a sockpuppet bug report |
| 2026-11-12 13:03:41 UTC (14:03:41 CET) | dpkg | bench-01 installs 5.5.1-1 |
| 2026-11-12 13:10:01 UTC | probe CSV | First slow login on bench-01 |
| 2026-11-12 to 16 | dpkg | 18 hosts install it, including a bastion; 2 upgrades fail |
| 2026-11-17 | perf, chat | Elif profiles sshd, audits the GOT, runs valgrind |
| 2026-11-19 | dpkg | `5.5.1+really5.5.0-1` rollback on part of the fleet |

## Why the red herrings were wrong

- **openssh 9.6p1-4** went to every host, including bench-03, which stayed at 61 ms. bench-01 stayed fast for a day after it.
- **libssl 3.0.15-2** landed four hours before the slowdown. And the trap: read the CET dpkg times as UTC and the zfold install seems to land *53 minutes after* the first slow probe.
- **UseDNS / reverse DNS**: connect time is flat, `UseDNS` is already `no`, and the extra time is server CPU, not waiting.
- **The big 5.5.0 release** with the multithreaded decoder: bench-03 runs it and is fast.
- **Signatures and hashes**: both tarballs are exactly what upstream published, validly signed. By Jun. A signature tells you *who*, never *what*.

## Fixes

**Immediate**
- Roll back to a release built from a known-good tag. Treat every host that ever had `5.5.1-1` installed as potentially compromised: rotate SSH host keys and credentials, review auth logs for the exposure window, rebuild. Start with the bastion.
- Pin the library and block the bad version in your package mirror.

**Structural**
- **Build from git, not from uploaded tarballs**, or verify that `tarball == git archive + reproducible generation`. Diff them in CI.
- **Treat binary test files as code**: they must be generated by a script in the repo, and that script must reproduce them byte for byte.
- **Reproducible builds** for distro packages, compared across independent builders.
- **Minimise what privileged daemons load.** sshd did not need a compression library. Since this kind of incident, `libsystemd` loads its compression libraries lazily with `dlopen`.
- **Release hygiene**: two-person review for releases and for maintainer changes; watch for sudden pressure from accounts with no history.
- **Take performance regressions seriously.** A half-second nobody could explain was the only alarm that fired.

## The real incident: xz-utils / liblzma, March 2024 (CVE-2024-3094)

On 29 March 2024, Andres Freund, a PostgreSQL developer at Microsoft, reported a backdoor in **xz-utils 5.6.0 and 5.6.1**. He had noticed that SSH logins on Debian testing used much more CPU and took about **500 ms** longer, and valgrind was complaining. The co-maintainer "Jia Tan" had built trust over roughly two years, helped by sockpuppet accounts pressuring the original maintainer, Lasse Collin. The payload hid in binary test files (`bad-3-corrupt_lzma2.xz`, `good-large_compressed.lzma`), and a modified `build-to-host.m4` that existed **only in the release tarballs** extracted it at build time on Debian and RPM package builds. The resulting liblzma replaced an ifunc resolver, and through it sshd's `RSA_public_decrypt`, giving remote code execution to whoever held the attacker's key. It was caught in testing and rolling releases, before it reached most stable distributions.

Read: Andres Freund's original report on the oss-security mailing list (29 March 2024), and Lasse Collin's xz backdoor page at **https://tukaani.org/xz-backdoor/**.

## Real-world takeaways

1. **Git is not what you ship.** Diff release tarballs against their tags; anything that exists only in the tarball skipped review.
2. **Binary blobs in a repo are code.** Require a generator, and reproduce them.
3. **Signatures prove identity, not intent.** The attacker had the signing key, legitimately.
4. **Trust is a social attack surface.** Maintainer burnout plus pressure from accounts without history is a recognisable pattern.
5. **Profile the unexplained.** Tests passed. A curious engineer with `perf` and a control box found it.
6. **Blast radius is "ever ran", not "runs now".** A rollback does not un-expose a host.
