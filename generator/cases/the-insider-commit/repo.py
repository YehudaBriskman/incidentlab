"""Build the fictional upstream `zfold` git repo for case `the-insider-commit`.

Every commit has a pinned author/committer identity and date, git runs isolated from the
user's config, and binary test fixtures come from a seeded RNG, so commit SHAs are identical
on every run. Returns tree snapshots at each tag so the release-artifact builder can diff a
tarball against its git tag.
"""
from __future__ import annotations

import os
import random
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

GIT_FLAGS: list[str] = [
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "init.defaultBranch=main",
    "-c", "user.useConfigOnly=false",
    "-c", "core.autocrlf=false",
    "-c", "core.fileMode=true",
    "-c", "pack.threads=1",
    "-c", "core.abbrev=7",
]

PEOPLE: dict[str, tuple[str, str]] = {
    "mlindqvist": ("Matti Lindqvist", "matti@zfold.example"),
    "jtarrow": ("Jun Tarrow", "jun.tarrow@mailbox.example"),
    "aribeiro": ("Ana Ribeiro", "ana.ribeiro@devmail.example"),
    "twolny": ("Tomasz Wolny", "tw@wolny.example"),
    "kosei": ("Kenji Osei", "kenji.osei@corvid.example"),
}

PAYLOAD_FIXTURE = "tests/files/bad-3-trailing-index.zf"
DECOY_FIXTURE = "tests/files/good-3-large-window.zf"
MARKER = b"####Probe####"


def base_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "TZ": "UTC", "LC_ALL": "C"})
    return env


def git(args: list[str], cwd: Path, env: dict[str, str] | None = None, binary: bool = False) -> str:
    res = subprocess.run(["git", *GIT_FLAGS, *args], cwd=cwd, env=env or base_env(),
                         check=True, capture_output=True)
    return "" if binary else res.stdout.decode().strip()


# --------------------------------------------------------------------------------------------
# Fixtures (binary, seeded)
# --------------------------------------------------------------------------------------------

def fixture(name: str, size: int, rev: int, extra: bytes = b"") -> bytes:
    rnd = random.Random(f"zfold-fixture-{name}-{rev}")
    head = b"\x89ZFLD\r\n\x1a\x05" + bytes([rev]) + b"\x00\x00\x00"
    body = bytearray(rnd.randbytes(size))
    # Keep printable noise rare so `strings` output stays readable: squash most ASCII runs.
    for i in range(len(body)):
        if 0x20 <= body[i] < 0x7F and rnd.random() < 0.55:
            body[i] = body[i] | 0x80
    mid = len(body) // 2
    return head + bytes(body[:mid]) + extra + bytes(body[mid:]) + b"ZFEND\x00"


def all_fixtures(rev_payload: int) -> dict[str, bytes]:
    return {
        "tests/files/good-1-empty.zf": fixture("good-1-empty", 24, 1, b"\n#zfold empty stream\n"),
        "tests/files/good-1-single-block.zf": fixture("g1sb", 900, 1, b"\nHello from zfold\n"),
        "tests/files/good-2-multi-block.zf": fixture("g2mb", 2400, 1, b"\n###Hi###\nblock 2 of 3\n"),
        "tests/files/bad-1-truncated-header.zf": fixture("b1th", 60, 1),
        "tests/files/bad-2-crc-mismatch.zf": fixture("b2cm", 700, 1, b"\nCRC64 deliberately wrong\n"),
        "tests/files/unsupported-1-filter.zf": fixture("u1f", 300, 1, b"\nfilter id 0x7f\n"),
    }


def new_fixtures(rev: int) -> dict[str, bytes]:
    return {
        PAYLOAD_FIXTURE: fixture("b3ti", 5200 + rev * 64, rev,
                                 b"\nindex record count does not match\n" + MARKER + b"\n"),
        DECOY_FIXTURE: fixture("g3lw", 3900 + rev * 32, rev,
                               b"\n####Probe###\nwindow 64 MiB\n####Zf-55####\n"),
    }


# --------------------------------------------------------------------------------------------
# Source text
# --------------------------------------------------------------------------------------------

def configure_ac(version: str, cmake_note: bool = False) -> str:
    return f"""AC_PREREQ([2.69])
AC_INIT([zfold], [{version}], [zfold-devel@lists.zfold.example], [zfold], [https://zfold.example/])
AC_CONFIG_SRCDIR([src/zfold.h])
AC_CONFIG_AUX_DIR([build-aux])
AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_HEADERS([config.h])
AM_INIT_AUTOMAKE([1.16 foreign tar-v7 filename-length-max=99 serial-tests])
AM_SILENT_RULES([yes])
AC_CANONICAL_HOST
AC_PROG_CC
LT_INIT([win32-dll])
AM_GNU_GETTEXT_VERSION([0.21])
AM_GNU_GETTEXT([external])
zf_VISIBILITY
zf_CPUCORES
AC_ARG_ENABLE([ifunc], [AS_HELP_STRING([--disable-ifunc], [do not use GNU indirect functions for CRC dispatch])],
  [], [enable_ifunc=auto])
AC_CONFIG_FILES([Makefile src/Makefile tests/Makefile po/Makefile.in])
AC_OUTPUT
"""


ZFOLD_H = """/* zfold.h - public API of the zfold compression library */
#ifndef ZFOLD_H
#define ZFOLD_H
#include <stddef.h>
#include <stdint.h>

#define ZF_VERSION_MAJOR 5
typedef enum { ZF_OK = 0, ZF_STREAM_END = 1, ZF_MEM_ERROR = 5, ZF_DATA_ERROR = 9 } zf_ret;

typedef struct zf_stream zf_stream;

extern zf_ret zf_encoder_init(zf_stream *strm, uint32_t preset);
extern zf_ret zf_decoder_init(zf_stream *strm, uint64_t memlimit);
extern zf_ret zf_code(zf_stream *strm, int action);
extern void zf_end(zf_stream *strm);
extern uint32_t zf_crc32(const uint8_t *buf, size_t size, uint32_t crc);
extern uint64_t zf_crc64(const uint8_t *buf, size_t size, uint64_t crc);
extern const char *zf_version_string(void);
#endif
"""

CRC64_V1 = """/* crc64_fast.c - CRC64 using a slice-by-4 table */
#include "check.h"

static uint64_t crc64_table[4][256];

static void crc64_init(void)
{
\tfor (size_t s = 0; s < 4; ++s)
\t\tfor (size_t b = 0; b < 256; ++b)
\t\t\tcrc64_table[s][b] = zf_crc64_poly_step(s, b);
}

extern uint64_t
zf_crc64(const uint8_t *buf, size_t size, uint64_t crc)
{
\tstatic int ready;
\tif (!ready) { crc64_init(); ready = 1; }
\tcrc = ~crc;
\twhile (size--)
\t\tcrc = crc64_table[0][*buf++ ^ (uint8_t)crc] ^ (crc >> 8);
\treturn ~crc;
}
"""

CRC64_IFUNC = """/* crc64_fast.c - CRC64 with runtime CPU dispatch */
#include "check.h"

static uint64_t crc64_generic(const uint8_t *buf, size_t size, uint64_t crc);
static uint64_t crc64_clmul(const uint8_t *buf, size_t size, uint64_t crc);

#if defined(ZF_HAVE_IFUNC)
/* GNU indirect function: the dynamic linker calls the resolver once, while it is
 * relocating the library, and binds zf_crc64 to whatever the resolver returns. */
typedef uint64_t (*crc64_func)(const uint8_t *, size_t, uint64_t);

static crc64_func
zf_crc64_resolve(void)
{
\treturn zf_cpu_has_clmul() ? crc64_clmul : crc64_generic;
}

extern uint64_t zf_crc64(const uint8_t *buf, size_t size, uint64_t crc)
\t__attribute__((__ifunc__("zf_crc64_resolve")));
#else
extern uint64_t
zf_crc64(const uint8_t *buf, size_t size, uint64_t crc)
{
\treturn zf_cpu_has_clmul() ? crc64_clmul(buf, size, crc) : crc64_generic(buf, size, crc);
}
#endif
"""

TEST_FILES_SH_V1 = """#!/bin/sh
# Decompress every test file and check the expected result.
set -e
ZF=../src/cli/zf
for f in "$srcdir"/files/good-*.zf; do
\t$ZF -dc "$f" > /dev/null || { echo "FAIL: $f"; exit 1; }
done
for f in "$srcdir"/files/bad-*.zf; do
\tif $ZF -dc "$f" > /dev/null 2>&1; then echo "FAIL (should fail): $f"; exit 1; fi
done
echo "all test files OK"
"""

CMAKE_SANDBOX_OK = """include(CheckCSourceCompiles)
check_c_source_compiles("
    #include <linux/landlock.h>
    #include <sys/syscall.h>
    int main(void) { (void)SYS_landlock_create_ruleset; return 0; }
" HAVE_LINUX_LANDLOCK)
"""

CMAKE_SANDBOX_BROKEN = """include(CheckCSourceCompiles)
check_c_source_compiles("
    #include <linux/landlock.h>
    #include <sys/syscall.h>
.
    int main(void) { (void)SYS_landlock_create_ruleset; return 0; }
" HAVE_LINUX_LANDLOCK)
"""


def news_entry(version: str, date: str, lines: list[str]) -> str:
    body = "\n".join(f"    * {ln}" for ln in lines)
    return f"{version} ({date})\n\n{body}\n\n"


# --------------------------------------------------------------------------------------------
# Repo state + commits
# --------------------------------------------------------------------------------------------

Tree = dict[str, bytes]


@dataclass(frozen=True)
class Commit:
    when: str            # "YYYY-MM-DD HH:MM:SS +ZZZZ"
    who: str
    msg: str
    change: Callable[[Tree], None]
    tag: str | None = None


def put(path: str, text: str | bytes) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        t[path] = text.encode() if isinstance(text, str) else text
    return f


def sub(path: str, old: str, new: str) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        cur = t[path].decode()
        if old not in cur:
            raise SystemExit(f"repo builder: '{old[:40]}' not in {path}")
        t[path] = cur.replace(old, new, 1).encode()
    return f


def app(path: str, text: str) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        t[path] = t.get(path, b"") + text.encode()
    return f


def prepend(path: str, text: str) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        cur = t[path].decode()
        head, rest = cur.split("\n\n", 1)
        t[path] = (head + "\n\n" + text + rest).encode()
    return f


def many(*fns: Callable[[Tree], None]) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        for fn in fns:
            fn(t)
    return f


def release(version: str, date: str, news: list[str]) -> Callable[[Tree], None]:
    def f(t: Tree) -> None:
        ac = t["configure.ac"].decode()
        t["configure.ac"] = re.sub(r"\[zfold\], \[[0-9.]+\]", f"[zfold], [{version}]", ac).encode()
        cm = t["CMakeLists.txt"].decode()
        t["CMakeLists.txt"] = re.sub(r"project\(zfold VERSION [0-9.]+\)", f"project(zfold VERSION {version})", cm, count=1).encode()
        prepend("NEWS", news_entry(version, date, news))(t)
    return f


def initial_tree() -> Tree:
    t: Tree = {}
    put("README", "zfold\n=====\n\nzfold is a small, fast general-purpose compression library (libzfold)\n"
        "and command line tool (zf). It is used by package managers, init systems and\n"
        "log rotation tools on many Linux distributions.\n\nBuild:\n\n    ./configure && make && make check\n\n"
        "Maintainer: Matti Lindqvist <matti@zfold.example>\n")(t)
    put("AUTHORS", "Authors of zfold\n\n    Matti Lindqvist - original author and maintainer\n")(t)
    put("COPYING", "zfold is released under the Zero-Clause BSD license (0BSD).\n\n"
        "Permission to use, copy, modify, and/or distribute this software for any purpose\n"
        "with or without fee is hereby granted.\n")(t)
    put("NEWS", "zfold release notes\n===================\n\n" + news_entry("5.0.0", "2022-03-14", ["First stable release of the 5.x API."]))(t)
    put("configure.ac", configure_ac("5.0.0"))(t)
    put("Makefile.am", "SUBDIRS = src tests po\nACLOCAL_AMFLAGS = -I m4\nEXTRA_DIST = autogen.sh CMakeLists.txt cmake\n")(t)
    put("src/Makefile.am", "lib_LTLIBRARIES = libzfold.la\nlibzfold_la_SOURCES = common.c encoder.c decoder.c check/crc32.c check/crc64_fast.c\n"
        "libzfold_la_LDFLAGS = -version-info 10:1:5 -no-undefined\ninclude_HEADERS = zfold.h\nSUBDIRS = . cli\n")(t)
    put("tests/Makefile.am", "check_PROGRAMS = test_check\nTESTS = test_check test_files.sh\nEXTRA_DIST = files test_files.sh\n")(t)
    put("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(zfold VERSION 5.0.0)\n"
        "add_library(zfold src/common.c src/encoder.c src/decoder.c src/check/crc32.c src/check/crc64_fast.c)\n")(t)
    put("autogen.sh", "#!/bin/sh\nset -e\nautoreconf -fi\n")(t)
    put("m4/zf_visibility.m4", "# zf_visibility.m4 serial 2\nAC_DEFUN([zf_VISIBILITY], [\n  AC_MSG_CHECKING([for -fvisibility=hidden])\n"
        "  CFLAGS_VISIBILITY=-fvisibility=hidden\n  AC_SUBST([CFLAGS_VISIBILITY])\n  AC_MSG_RESULT([yes])\n])\n")(t)
    put("m4/zf_cpucores.m4", "# zf_cpucores.m4 serial 1\nAC_DEFUN([zf_CPUCORES], [\n  AC_CHECK_FUNCS([sched_getaffinity sysconf])\n])\n")(t)
    put("src/zfold.h", ZFOLD_H)(t)
    put("src/common.c", "/* common.c - allocation helpers and version string */\n#include \"zfold.h\"\n#include <stdlib.h>\n\n"
        "extern const char *\nzf_version_string(void)\n{\n\treturn PACKAGE_VERSION;\n}\n")(t)
    put("src/encoder.c", "/* encoder.c - block encoder */\n#include \"zfold.h\"\n\nextern zf_ret\nzf_encoder_init(zf_stream *strm, uint32_t preset)\n{\n"
        "\tif (preset > 9)\n\t\treturn ZF_DATA_ERROR;\n\treturn zf_block_encoder_setup(strm, preset);\n}\n")(t)
    put("src/decoder.c", "/* decoder.c - block decoder */\n#include \"zfold.h\"\n\nextern zf_ret\nzf_decoder_init(zf_stream *strm, uint64_t memlimit)\n{\n"
        "\treturn zf_block_decoder_setup(strm, memlimit);\n}\n")(t)
    put("src/check/check.h", "/* check.h - integrity checks */\n#include \"zfold.h\"\nextern uint64_t zf_crc64_poly_step(size_t s, size_t b);\nextern int zf_cpu_has_clmul(void);\n")(t)
    put("src/check/crc32.c", "/* crc32.c - CRC32 (IEEE) */\n#include \"check.h\"\n\nextern uint32_t\nzf_crc32(const uint8_t *buf, size_t size, uint32_t crc)\n{\n"
        "\tcrc = ~crc;\n\twhile (size--)\n\t\tcrc = zf_crc32_table[(*buf++ ^ crc) & 0xFF] ^ (crc >> 8);\n\treturn ~crc;\n}\n")(t)
    put("src/check/crc64_fast.c", CRC64_V1)(t)
    put("src/cli/Makefile.am", "bin_PROGRAMS = zf\nzf_SOURCES = zf.c\nzf_LDADD = ../libzfold.la\n")(t)
    put("src/cli/zf.c", "/* zf.c - command line front end */\n#include <stdio.h>\n#include \"../zfold.h\"\n\nint\nmain(int argc, char **argv)\n{\n"
        "\tif (argc > 1 && argv[1][0] == '-' && argv[1][1] == 'V') {\n\t\tprintf(\"zf %s\\n\", zf_version_string());\n\t\treturn 0;\n\t}\n"
        "\treturn zf_cli_run(argc, argv);\n}\n")(t)
    put("tests/test_check.c", "/* test_check.c */\n#include <assert.h>\n#include \"../src/zfold.h\"\n\nint\nmain(void)\n{\n"
        "\tassert(zf_crc32((const uint8_t *)\"123456789\", 9, 0) == 0xCBF43926);\n\treturn 0;\n}\n")(t)
    put("tests/test_files.sh", TEST_FILES_SH_V1)(t)
    for p, b in all_fixtures(1).items():
        t[p] = b
    put("doc/zf.1", ".TH ZF 1 \"2022-03-14\" \"zfold\"\n.SH NAME\nzf \\- compress or decompress .zf files\n.SH SYNOPSIS\n.B zf\n[\\fIoption...\\fR] [\\fIfile...\\fR]\n")(t)
    put("po/LINGUAS", "de fi\n")(t)
    put("po/POTFILES.in", "src/cli/zf.c\n")(t)
    put("po/de.po", "msgid \"\"\nmsgstr \"Content-Type: text/plain; charset=UTF-8\\n\"\n\nmsgid \"compressed data is corrupt\"\nmsgstr \"Komprimierte Daten sind beschädigt\"\n")(t)
    put("po/fi.po", "msgid \"\"\nmsgstr \"Content-Type: text/plain; charset=UTF-8\\n\"\n\nmsgid \"compressed data is corrupt\"\nmsgstr \"Pakattu data on vioittunut\"\n")(t)
    put(".gitignore", "*.o\n*.lo\n*.la\n.libs/\nMakefile\nMakefile.in\nconfigure\naclocal.m4\nbuild-aux/\nconfig.*\n")(t)
    put("SECURITY.md", "# Reporting security issues\n\nPlease e-mail matti@zfold.example privately. Do not open a public issue.\n")(t)
    return t


def commits() -> list[Commit]:
    M, J, A, T, K = "mlindqvist", "jtarrow", "aribeiro", "twolny", "kosei"
    return [
        Commit("2022-03-14 10:02:11 +0200", M, "Initial import of zfold 5.0.0", lambda t: None, "v5.0.0"),
        Commit("2022-04-02 21:40:55 +0300", M, "crc32: document the polynomial",
               sub("src/check/crc32.c", "/* crc32.c - CRC32 (IEEE) */", "/* crc32.c - CRC32 (IEEE 802.3, reflected polynomial 0xEDB88320) */")),
        Commit("2022-05-19 08:13:40 +0300", A, "po: add Portuguese translation",
               many(put("po/pt.po", "msgid \"\"\nmsgstr \"Content-Type: text/plain; charset=UTF-8\\n\"\n\nmsgid \"compressed data is corrupt\"\nmsgstr \"Os dados comprimidos estão corrompidos\"\n"),
                    put("po/LINGUAS", "de fi pt\n"))),
        Commit("2022-07-08 22:31:09 +0300", M, "cli: add -V to print the version", app("doc/zf.1", ".TP\n.B \\-V\nPrint the version and exit.\n")),
        Commit("2022-09-30 19:05:44 +0300", M, "Bump version to 5.2.0",
               release("5.2.0", "2022-09-30", ["Add -V to zf.", "Portuguese translation."]), "v5.2.0"),
        Commit("2022-12-11 23:12:01 +0200", T, "decoder: reject zero-sized blocks early",
               sub("src/decoder.c", "\treturn zf_block_decoder_setup(strm, memlimit);", "\tif (memlimit == 0)\n\t\treturn ZF_MEM_ERROR;\n\treturn zf_block_decoder_setup(strm, memlimit);")),
        Commit("2023-02-26 20:48:30 +0200", M, "tests: add CRC64 known-answer test",
               sub("tests/test_check.c", "\treturn 0;", "\tassert(zf_crc64((const uint8_t *)\"123456789\", 9, 0) == 0x995DC9BBDF1939FAULL);\n\treturn 0;")),
        Commit("2023-05-14 09:27:18 +0300", M, "Bump version to 5.2.4",
               release("5.2.4", "2023-05-14", ["Decoder rejects zero memlimit.", "More tests."]), "v5.2.4"),
        Commit("2023-11-02 14:21:07 +0800", J, "doc: fix typo in zf.1 synopsis",
               sub("doc/zf.1", "compress or decompress .zf files", "compress or decompress .zf files (zfold format)")),
        Commit("2023-12-05 13:02:44 +0800", J, "tests: make test_files.sh work with out-of-tree builds",
               sub("tests/test_files.sh", "ZF=../src/cli/zf", "ZF=${ZF:-../src/cli/zf}")),
        Commit("2024-01-18 22:14:51 +0200", M, "encoder: clamp preset 9e memory usage",
               sub("src/encoder.c", "\tif (preset > 9)", "\tif ((preset & 0x1F) > 9)")),
        Commit("2024-02-27 10:45:30 +0800", J, "build: add CMake build alongside autotools",
               many(app("CMakeLists.txt", "add_executable(zf src/cli/zf.c)\ntarget_link_libraries(zf zfold)\n"),
                    put("cmake/sandbox.cmake", CMAKE_SANDBOX_OK),
                    app("CMakeLists.txt", "include(cmake/sandbox.cmake)\n"))),
        Commit("2024-04-09 12:33:02 +0800", J, "ci: add GitHub-style workflow for Linux and BSD",
               put(".github/workflows/ci.yml", "name: ci\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n"
                   "      - uses: actions/checkout@v4\n      - run: ./autogen.sh && ./configure && make -j4 && make check\n")),
        Commit("2024-06-21 23:58:12 +0300", M, "Bump version to 5.3.0",
               release("5.3.0", "2024-06-21", ["CMake build system (experimental).", "Out-of-tree test runs."]), "v5.3.0"),
        Commit("2024-08-14 11:20:40 +0800", J, "decoder: speed up index parsing by 12%",
               app("src/decoder.c", "\n/* Index records are parsed in one pass; see NEWS for 5.3.1. */\n")),
        Commit("2024-10-03 09:10:05 +0800", J, "po: update German translation",
               app("po/de.po", "\nmsgid \"memory usage limit reached\"\nmsgstr \"Speichernutzungsgrenze erreicht\"\n")),
        Commit("2024-11-22 22:40:31 +0200", M, "Bump version to 5.3.1",
               release("5.3.1", "2024-11-22", ["Faster index parsing.", "German translation update."]), "v5.3.1"),
        Commit("2025-01-30 15:02:19 +0800", J, "cli: improve error message for truncated input",
               sub("src/cli/zf.c", "\treturn zf_cli_run(argc, argv);", "\t/* Truncated input now reports 'unexpected end of input'. */\n\treturn zf_cli_run(argc, argv);")),
        Commit("2025-03-11 08:44:52 +0200", A, "po: update Portuguese translation",
               app("po/pt.po", "\nmsgid \"memory usage limit reached\"\nmsgstr \"Limite de utilização de memória atingido\"\n")),
        Commit("2025-05-02 13:12:40 +0800", J, "encoder: fix rare off-by-one in block size estimate",
               app("src/encoder.c", "\n/* Block size estimate includes the 12-byte footer. */\n")),
        Commit("2025-06-24 21:03:11 +0300", M, "Add Jun Tarrow as co-maintainer",
               many(sub("AUTHORS", "original author and maintainer\n", "original author and maintainer\n    Jun Tarrow - co-maintainer (2025-)\n"),
                    sub("README", "Maintainer: Matti Lindqvist <matti@zfold.example>", "Maintainers: Matti Lindqvist <matti@zfold.example>\n             Jun Tarrow <jun.tarrow@mailbox.example>"))),
        Commit("2025-07-15 10:30:00 +0800", J, "Bump version to 5.4.0",
               release("5.4.0", "2025-07-15", ["First release signed by Jun Tarrow.", "Encoder block size fix."]), "v5.4.0"),
        Commit("2025-09-04 16:22:41 +0800", J, "docs: update security contact",
               sub("SECURITY.md", "Please e-mail matti@zfold.example privately.", "Please e-mail jun.tarrow@mailbox.example privately.")),
        Commit("2025-10-20 22:19:33 +0300", K, "build: honour SOURCE_DATE_EPOCH in the man page date",
               sub("doc/zf.1", "\"2022-03-14\"", "\"@ZF_MAN_DATE@\"")),
        Commit("2025-12-09 11:48:05 +0800", J, "Bump version to 5.4.5",
               release("5.4.5", "2025-12-09", ["Reproducible man page date.", "Security contact updated."]), "v5.4.5"),
        Commit("2026-02-17 09:55:47 +0800", J, "crc64: use an ifunc to pick the CLMUL implementation at load time",
               many(put("src/check/crc64_fast.c", CRC64_IFUNC),
                    sub("configure.ac", "AC_ARG_ENABLE([ifunc]", "AC_DEFINE([ZF_HAVE_IFUNC], [1], [GNU ifunc available])\nAC_ARG_ENABLE([ifunc]"))),
        Commit("2026-03-03 20:11:26 +0200", M, "crc64: add a comment about the CLMUL fallback",
               sub("src/check/crc64_fast.c", "static uint64_t crc64_clmul", "/* crc64_clmul needs PCLMULQDQ; crc64_generic is the portable fallback. */\nstatic uint64_t crc64_clmul")),
        Commit("2026-04-14 10:05:12 +0800", J, "Bump version to 5.4.6",
               release("5.4.6", "2026-04-14", ["CRC64 picks the CLMUL implementation via ifunc.", "Small fixes."]), "v5.4.6"),
        Commit("2026-05-21 14:41:09 +0800", J, "cmake: tidy the Landlock sandbox feature check",
               put("cmake/sandbox.cmake", CMAKE_SANDBOX_BROKEN)),
        Commit("2026-07-08 19:37:58 +0300", T, "cli: accept --threads=0 as 'use all cores'",
               app("doc/zf.1", ".TP\n.B \\-\\-threads=\\fIN\\fR\nUse N threads (0 = all cores).\n")),
        Commit("2026-08-26 12:15:44 +0800", J, "decoder: add multithreaded block decoder",
               many(app("src/decoder.c", "\n/* Multithreaded decoder: one worker per block, results merged in order. */\n"),
                    sub("src/Makefile.am", "check/crc64_fast.c", "check/crc64_fast.c decoder_mt.c"),
                    put("src/decoder_mt.c", "/* decoder_mt.c - multithreaded block decoder */\n#include \"zfold.h\"\n#include <pthread.h>\n\n/* Workers pull block indexes from a shared queue. */\n"))),
        Commit("2026-09-15 21:30:17 +0300", M, "decoder_mt: cap worker count by memlimit",
               app("src/decoder_mt.c", "/* Worker count is capped so that workers * block_size <= memlimit. */\n")),
        Commit("2026-10-27 11:02:38 +0800", J, "Bump version to 5.5.0",
               release("5.5.0", "2026-10-27", ["Multithreaded decoder (zf -T).", "--threads=0 uses all cores.", "Faster CRC64 on x86-64."]), "v5.5.0"),
        Commit("2026-11-03 09:17:26 +0800", J, "tests: add trailing-index and large-window test files",
               many(*(put(p, b) for p, b in new_fixtures(1).items()),
                    sub("tests/test_files.sh", "echo \"all test files OK\"", "# bad-3: index record count does not match the number of blocks\n# good-3: 64 MiB dictionary window\necho \"all test files OK\""))),
        Commit("2026-11-04 22:02:51 +0200", M, "po: update Finnish translation",
               app("po/fi.po", "\nmsgid \"memory usage limit reached\"\nmsgstr \"Muistinkäytön raja saavutettu\"\n")),
        Commit("2026-11-06 10:44:09 +0800", J, "tests: regenerate test files with a reproducible seed",
               many(*(put(p, b) for p, b in new_fixtures(2).items()))),
        Commit("2026-11-07 08:30:51 +0800", J, "crc64: silence valgrind warning in the ifunc resolver",
               sub("src/check/crc64_fast.c", "static crc64_func\nzf_crc64_resolve(void)", "/* Resolver runs before relocations are complete: keep it minimal. */\nstatic crc64_func\nzf_crc64_resolve(void)")),
        Commit("2026-11-09 18:05:12 +0800", J, "Bump version to 5.5.1",
               release("5.5.1", "2026-11-09", ["Fix valgrind warnings in the CRC64 resolver.", "New test files for index and window edge cases."]), "v5.5.1"),
    ]


@dataclass(frozen=True)
class RepoResult:
    tag_trees: dict[str, Tree]
    tag_sha: dict[str, str]
    fixture_add_sha: str
    fixture_add_sha7: str
    head_tree: Tree


def write_tree(work: Path, tree: Tree) -> None:
    for p in list(work.iterdir()):
        if p.name == ".git":
            continue
        shutil.rmtree(p) if p.is_dir() else p.unlink()
    for rel, data in sorted(tree.items()):
        dst = work / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        if rel.endswith(".sh"):
            dst.chmod(0o755)
        else:
            dst.chmod(0o644)


def build_repo(work: Path) -> RepoResult:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    git(["init", "-q"], work)
    tree = initial_tree()
    tag_trees: dict[str, Tree] = {}
    tag_sha: dict[str, str] = {}
    add_sha = ""
    for c in commits():
        c.change(tree)
        write_tree(work, tree)
        name, email = PEOPLE[c.who]
        env = base_env()
        env.update({"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_AUTHOR_DATE": c.when,
                    "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email, "GIT_COMMITTER_DATE": c.when})
        git(["add", "-A"], work, env)
        git(["commit", "-q", "--allow-empty", "-m", c.msg], work, env)
        sha = git(["rev-parse", "HEAD"], work, env)
        if c.msg.startswith("tests: add trailing-index"):
            add_sha = sha
        if c.tag:
            git(["tag", c.tag], work, env)
            tag_trees[c.tag] = dict(tree)
            tag_sha[c.tag] = sha
    if not add_sha:
        raise SystemExit("repo builder: fixture commit not found")
    sha7 = git(["rev-parse", "--short=7", add_sha], work)
    return RepoResult(tag_trees, tag_sha, add_sha, sha7, dict(tree))


def export_log(work: Path, out: Path) -> None:
    env = base_env()
    res = subprocess.run(["git", *GIT_FLAGS, "log", "-p", "--decorate=short", "--all", "--date=iso"],
                         cwd=work, env=env, check=True, capture_output=True)
    out.write_bytes(res.stdout)


def make_bundle(work: Path, out: Path) -> None:
    git(["bundle", "create", "-q", str(out), "--all"], work, binary=True)
