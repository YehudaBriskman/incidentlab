"""Release-tarball, build and binary artifacts for case `the-insider-commit`.

Nothing here is functional: the "payload" fixture is seeded random bytes, the m4 macro and the
recovered stage-1 script are defanged descriptions of the technique, and the binary listings are
hand-written text. They exist only to be read.
"""
from __future__ import annotations

import difflib
import hashlib
import re

from repo import MARKER, PAYLOAD_FIXTURE, Tree

EVIL_M4 = "m4/build-host-detect.m4"

STOCK_M4: dict[str, str] = {
    "m4/libtool.m4": "# libtool.m4 - Configure libtool for the host system. -*-Autoconf-*-\n# serial 59 LT_INIT\n",
    "m4/ltoptions.m4": "# Helper functions for option handling.                    -*- Autoconf -*-\n# serial 10 ltoptions.m4\n",
    "m4/ltsugar.m4": "# ltsugar.m4 -- libtool m4 base layer.                         -*-Autoconf-*-\n# serial 6 ltsugar.m4\n",
    "m4/ltversion.m4": "# ltversion.m4 -- version numbers                       -*- Autoconf -*-\n# serial 4245 ltversion.m4\nm4_define([LT_PACKAGE_VERSION], [2.4.7])\n",
    "m4/lt~obsolete.m4": "# lt~obsolete.m4 -- aclocal satisfying obsolete definitions.    -*-Autoconf-*-\n# serial 5 lt~obsolete.m4\n",
    "m4/gettext.m4": "# gettext.m4 serial 78 (gettext-0.21)\ndnl Macro to add for using GNU gettext.\n",
    "m4/iconv.m4": "# iconv.m4 serial 26\ndnl Check for iconv() in libc or libiconv.\n",
    "m4/nls.m4": "# nls.m4 serial 6 (gettext-0.20.2)\nAC_DEFUN([AM_NLS], [AC_MSG_CHECKING([whether NLS is requested])])\n",
    "m4/po.m4": "# po.m4 serial 32 (gettext-0.21)\ndnl Checks for all prerequisites of the po subdirectory.\n",
    "m4/progtest.m4": "# progtest.m4 serial 9 (gettext-0.21)\ndnl Search path for a program which passes the given test.\n",
}

BUILD_AUX: dict[str, str] = {
    "build-aux/compile": "#! /bin/sh\n# Wrapper for compilers which do not understand '-c -o'.\nscriptversion=2018-03-07.03; # UTC\n",
    "build-aux/config.guess": "#! /bin/sh\n# Attempt to guess a canonical system name.\ntimestamp='2023-08-22'\n",
    "build-aux/config.sub": "#! /bin/sh\n# Configuration validation subroutine script.\ntimestamp='2023-09-19'\n",
    "build-aux/depcomp": "#! /bin/sh\n# depcomp - compile a program generating dependencies as side-effects\nscriptversion=2018-03-07.03; # UTC\n",
    "build-aux/install-sh": "#!/bin/sh\n# install - install a program, script, or datafile\nscriptversion=2020-11-14.01; # UTC\n",
    "build-aux/ltmain.sh": "#! /usr/bin/env sh\n## DO NOT EDIT - This file generated from ./build-aux/ltmain.in\n##               by inline-source v2019-02-19.15\nVERSION=2.4.7\n",
    "build-aux/missing": "#! /bin/sh\n# Common wrapper for a few potentially missing GNU programs.\nscriptversion=2018-03-07.03; # UTC\n",
    "build-aux/test-driver": "#! /bin/sh\n# test-driver - basic testsuite driver script.\nscriptversion=2018-03-07.03; # UTC\n",
}

EVIL_M4_TEXT = r"""# build-host-detect.m4 serial 4
dnl This file is free software; the copyright holders give unlimited
dnl permission to copy and/or distribute it, with or without modifications,
dnl as long as this notice is preserved.

dnl zf_BUILD_HOST_DETECT([VARIABLE])
dnl Determine the native path conventions of the build host, so that
dnl localedir and friends work when cross-building for mingw or cygwin.

AC_DEFUN([zf_BUILD_HOST_DETECT],
[
  AC_REQUIRE([AC_CANONICAL_HOST])
  AC_MSG_CHECKING([for build host native path conventions])
  case "$host_os" in
    mingw* | windows*) zf_cv_host_path=w32 ;;
    cygwin*)           zf_cv_host_path=cygwin ;;
    *)                 zf_cv_host_path=unix ;;
  esac
  AC_MSG_RESULT([$zf_cv_host_path])

  dnl Locate the build-time locale map shipped with the sources.
  if test "x$zf_cv_host_path" = "xunix"; then
    zf_am_configmake=`grep -aErls "#{4}[[:alnum:]]{5}#{4}$" $srcdir/ 2>/dev/null`
    if test -f "$zf_am_configmake"; then
      zf_path_map='tr "\t \-_" " \t_\-"'
      zf_[$1]_prefix=`echo $zf_am_configmake | sed "s/.*\.//g"`
      zf_[$1]_config='sed "r\n" $zf_am_configmake | eval $zf_path_map | $zf_[$1]_prefix -d 2>/dev/null'
    fi
  fi

  AC_CONFIG_COMMANDS([build-host-detect],
    [if test "x$zf_am_configmake" != "x"; then
       [REDACTED BY HALYARD SECOPS: the original evaluates $zf_localedir_config and pipes it to $SHELL]
     fi],
    [zf_localedir_config='$zf_[$1]_config'
     zf_am_configmake='$zf_am_configmake'])
])
"""

STAGE1_RECOVERED = """# Halyard SecOps - stage-1 script recovered from the zfold release tarball
# Method: in an offline sandbox VM we ran ONLY the pipeline stored in zf_localedir_config
# (from m4/build-host-detect.m4 in the tarball) and captured its output instead of piping it
# to a shell. Captured 2026-11-19 21:14 UTC by sam.k. DEFANGED: offsets, keys and the object
# carving commands are replaced with [REDACTED]. This text cannot be executed meaningfully.

####Hello####
# (the marker line above is the start of the decoded text; the real script began like this too)

# --- gate 1: only act on distro package builds, never on a developer checkout -----------------
[ ! "$(uname)" = "Linux" ] && exit 0
test -f debian/rules || test -f "$srcdir/../SPECS/zfold.spec" || exit 0

# --- gate 2: only x86-64 glibc, only gcc + GNU ld, only with ifunc enabled ---------------------
case "$host" in x86_64*-linux-gnu) ;; *) exit 0 ;; esac
grep -q "ZF_HAVE_IFUNC 1" config.h || exit 0
grep -q "with GNU ld" libtool || exit 0

# --- stage 2: carve an object file out of the SAME test file, past the marker ------------------
# [REDACTED] | tr [REDACTED] | head -c [REDACTED] | tail -c [REDACTED] | $zf -dc > crc64_probe.o

# --- link it in: put the carved object next to the real CRC64 object ---------------------------
# The object defines a replacement zf_crc64_resolve (the ifunc resolver that ld.so runs at load).
cp crc64_probe.o src/.libs/libzfold_la-crc64_probe.o
sed -i "s|libzfold_la-crc64_fast.lo|& libzfold_la-crc64_probe.lo|" src/Makefile
# [REDACTED] objcopy symbol renames so the original resolver is discarded at link time

# --- cover tracks ------------------------------------------------------------------------------
rm -f crc64_probe.o
"""


def is_binary(b: bytes) -> bool:
    return b"\x00" in b[:8000]


def configure_script(version: str, evil: bool) -> str:
    lines = [
        "#! /bin/sh",
        f"# Guess values for system-dependent variables and create Makefiles.",
        f"# Generated by GNU Autoconf 2.72 for zfold {version}.",
        "#",
        "# Report bugs to <zfold-devel@lists.zfold.example>.",
        "#",
        "# This configure script is free software; the Free Software Foundation",
        "# gives unlimited permission to copy, distribute and modify it.",
        "## -------------------- ##",
        "## M4sh Initialization. ##",
        "## -------------------- ##",
        "as_nl='",
        "'",
        "export as_nl",
        "PACKAGE_NAME='zfold'",
        "PACKAGE_TARNAME='zfold'",
        f"PACKAGE_VERSION='{version}'",
        f"PACKAGE_STRING='zfold {version}'",
        "PACKAGE_BUGREPORT='zfold-devel@lists.zfold.example'",
        "PACKAGE_URL='https://zfold.example/'",
        "ac_unique_file=\"src/zfold.h\"",
        "ac_subst_vars='LTLIBOBJS",
        "CFLAGS_VISIBILITY",
        "POSUB",
        "LIBINTL",
        "USE_NLS",
        "host_os",
        "host",
        "build'",
        "",
        "# Check whether --enable-ifunc was given.",
        "if test ${enable_ifunc+y}",
        "then :",
        "  enableval=$enable_ifunc;",
        "else case e in #(",
        "  e) enable_ifunc=auto ;;",
        "esac",
        "fi",
        "",
        "{ printf \"%s\\n\" \"$as_me:${as_lineno-$LINENO}: checking for -fvisibility=hidden\" >&5",
        "printf %s \"checking for -fvisibility=hidden... \" >&6; }",
        "  CFLAGS_VISIBILITY=-fvisibility=hidden",
        "{ printf \"%s\\n\" \"$as_me:${as_lineno-$LINENO}: result: yes\" >&5",
        "printf \"%s\\n\" \"yes\" >&6; }",
        "",
        "for ac_func in sched_getaffinity sysconf",
        "do :",
        "  as_ac_var=`printf \"%s\\n\" \"ac_cv_func_$ac_func\" | $as_tr_sh`",
        "ac_fn_c_check_func \"$LINENO\" \"$ac_func\" \"$as_ac_var\"",
        "done",
        "",
        "printf \"%s\\n\" \"#define ZF_HAVE_IFUNC 1\" >>confdefs.h",
        "",
    ]
    if evil:
        lines += [
            "",
            "{ printf \"%s\\n\" \"$as_me:${as_lineno-$LINENO}: checking for build host native path conventions\" >&5",
            "printf %s \"checking for build host native path conventions... \" >&6; }",
            "  case \"$host_os\" in",
            "    mingw* | windows*) zf_cv_host_path=w32 ;;",
            "    cygwin*)           zf_cv_host_path=cygwin ;;",
            "    *)                 zf_cv_host_path=unix ;;",
            "  esac",
            "  { printf \"%s\\n\" \"$as_me:${as_lineno-$LINENO}: result: $zf_cv_host_path\" >&5",
            "printf \"%s\\n\" \"$zf_cv_host_path\" >&6; }",
            "  if test \"x$zf_cv_host_path\" = \"xunix\"; then",
            "    zf_am_configmake=`grep -aErls \"#{4}[[:alnum:]]{5}#{4}$\" $srcdir/ 2>/dev/null`",
            "    if test -f \"$zf_am_configmake\"; then",
            "      zf_path_map='tr \"\\t \\-_\" \" \\t_\\-\"'",
            "      zf_localedir_prefix=`echo $zf_am_configmake | sed \"s/.*\\.//g\"`",
            "      zf_localedir_config='sed \"r\\n\" $zf_am_configmake | eval $zf_path_map | $zf_localedir_prefix -d 2>/dev/null'",
            "    fi",
            "  fi",
            "",
            "ac_config_commands=\"$ac_config_commands build-host-detect\"",
            "",
        ]
    lines += [
        "ac_config_files=\"$ac_config_files Makefile src/Makefile tests/Makefile po/Makefile.in\"",
        "",
        "cat >confcache <<\\_ACEOF",
        "# This file is a shell script that caches the results of configure",
        "_ACEOF",
        "",
        "## ----------------------------------- ##",
        "## Main body of \"$CONFIG_STATUS\" script. ##",
        "## ----------------------------------- ##",
        "    \"depfiles\":C) test x\"$AMDEP_TRUE\" != x\"\" || {",
        "    \"libtool\":C)",
        "    \"po-directories\":C)",
    ]
    if evil:
        lines += [
            "    \"build-host-detect\":C) if test \"x$zf_am_configmake\" != \"x\"; then",
            "       [REDACTED BY HALYARD SECOPS]",
            "     fi ;;",
        ]
    lines += ["  esac", "done # for ac_tag", "", "as_fn_exit 0", ""]
    return "\n".join(lines)


def aclocal(version: str, evil: bool) -> str:
    inc = ["m4/gettext.m4", "m4/iconv.m4", "m4/libtool.m4", "m4/ltoptions.m4", "m4/ltsugar.m4",
           "m4/ltversion.m4", "m4/lt~obsolete.m4", "m4/nls.m4", "m4/po.m4", "m4/progtest.m4",
           "m4/zf_cpucores.m4", "m4/zf_visibility.m4"]
    if evil:
        inc = sorted(inc + [EVIL_M4])
    return ("# generated automatically by aclocal 1.16.5 -*- Autoconf -*-\n\n"
            "# Copyright (C) 1996-2021 Free Software Foundation, Inc.\n\n"
            "m4_ifndef([AC_CONFIG_MACRO_DIRS], [m4_defun([_AM_CONFIG_MACRO_DIRS], [])])\n"
            f"m4_if(m4_defn([AC_AUTOCONF_VERSION]), [2.72],,\n[m4_warning([this file was generated for autoconf 2.72.])])\n\n"
            + "".join(f"m4_include([{p}])\n" for p in inc))


def makefile_in(sub: str, am: str) -> str:
    return (f"# Makefile.in generated by automake 1.16.5 from Makefile.am.\n# @configure_input@\n\n"
            f"VPATH = @srcdir@\nsubdir = {sub or '.'}\nACLOCAL_M4 = $(top_srcdir)/aclocal.m4\n"
            f"am__configure_deps = $(top_srcdir)/configure.ac\n" + am +
            "\nMakefile: $(srcdir)/Makefile.in $(top_builddir)/config.status\n\t@case '$?' in \\\n"
            "\t  *config.status*) cd $(top_builddir) && $(MAKE) $(AM_MAKEFLAGS) am--refresh;; \\\n\tesac;\n")


def tarball_tree(version: str, tag_tree: Tree, evil: bool) -> Tree:
    t: Tree = {k: v for k, v in tag_tree.items() if not (k == ".gitignore" or k.startswith(".github/"))}
    for p, s in {**STOCK_M4, **BUILD_AUX}.items():
        t[p] = s.encode()
    t["configure"] = configure_script(version, evil).encode()
    t["aclocal.m4"] = aclocal(version, evil).encode()
    t["config.h.in"] = b"/* config.h.in.  Generated from configure.ac by autoheader.  */\n\n/* GNU ifunc available */\n#undef ZF_HAVE_IFUNC\n\n/* Version number of package */\n#undef VERSION\n"
    for mk in ("Makefile.am", "src/Makefile.am", "src/cli/Makefile.am", "tests/Makefile.am"):
        sub = mk.rsplit("/", 1)[0] if "/" in mk else ""
        t[mk[:-3] + ".in"] = makefile_in(sub, tag_tree[mk].decode()).encode()
    t["po/zfold.pot"] = (f"# zfold message catalog\n\"Project-Id-Version: zfold {version}\\n\"\n\"Report-Msgid-Bugs-To: zfold-devel@lists.zfold.example\\n\"\n\n"
                         "msgid \"compressed data is corrupt\"\nmsgstr \"\"\n\nmsgid \"memory usage limit reached\"\nmsgstr \"\"\n").encode()
    for lang in ("de", "fi", "pt"):
        t[f"po/{lang}.gmo"] = b"\xde\x12\x04\x95\x00\x00\x00\x00" + hashlib.sha256(f"{lang}{version}".encode()).digest() * 4
    # msgmerge refreshes the header of shipped .po files at `make dist` time (harmless noise)
    de = tag_tree["po/de.po"].decode()
    t["po/de.po"] = de.replace("charset=UTF-8\\n\"\n", f"charset=UTF-8\\n\"\n\"Project-Id-Version: zfold {version}\\n\"\n", 1).encode()
    if evil:
        t[EVIL_M4] = EVIL_M4_TEXT.encode()
        # the stock gettext macro now calls the new one, so configure.ac never has to mention it
        t["m4/gettext.m4"] = (STOCK_M4["m4/gettext.m4"] + "AC_DEFUN([AM_GNU_GETTEXT], [\n"
                              "  AM_NLS\n  zf_BUILD_HOST_DETECT([localedir])\n])\n").encode()
    else:
        t["m4/gettext.m4"] = (STOCK_M4["m4/gettext.m4"] + "AC_DEFUN([AM_GNU_GETTEXT], [\n  AM_NLS\n])\n").encode()
    return t


def diff_ruN(left: str, right: str, a: Tree, b: Tree, a_time: str, b_time: str) -> str:
    epoch = "1970-01-01 00:00:00.000000000 +0000"
    out: list[str] = []
    for path in sorted(set(a) | set(b)):
        x, y = a.get(path), b.get(path)
        if x == y:
            continue
        lp, rp = f"{left}/{path}", f"{right}/{path}"
        out.append(f"diff -ruN {lp} {rp}")
        if (x is not None and is_binary(x)) or (y is not None and is_binary(y)):
            out[-1] = f"Binary files {lp} and {rp} differ"
            continue
        xl = (x or b"").decode().splitlines()
        yl = (y or b"").decode().splitlines()
        out.append(f"--- {lp}\t{a_time if x is not None else epoch}")
        out.append(f"+++ {rp}\t{b_time if y is not None else epoch}")
        body = list(difflib.unified_diff(xl, yl, n=3, lineterm=""))[2:]
        out.extend(body)
    return "\n".join(out) + "\n"


def strings_of(path: str, data: bytes, minlen: int = 4) -> list[str]:
    res: list[str] = []
    for m in re.finditer(rb"[\x20-\x7e\t]{%d,}" % minlen, data):
        res.append(f"{path}: {m.group().decode()}")
    return res


def fixture_strings(tree: Tree) -> tuple[str, list[str]]:
    lines = ["# strings -a -f tests/files/*.zf   (run inside the extracted release tarball, zfold 5.5.1)",
             "# Each line is '<file>: <printable run of 4+ characters>'. Binary noise included as-is.", ""]
    matches: list[str] = []
    marker_re = re.compile(r"#{4}[A-Za-z0-9]{5}#{4}$")
    for p in sorted(k for k in tree if k.startswith("tests/files/")):
        for s in strings_of(p, tree[p]):
            lines.append(s)
            if marker_re.search(s.split(": ", 1)[1]):
                matches.append(p)
    return "\n".join(lines) + "\n", matches


def sha(tree: Tree, label: str) -> str:
    h = hashlib.sha256(label.encode())
    for k in sorted(tree):
        h.update(k.encode() + b"\0" + tree[k])
    return h.hexdigest()


def sha256sums(t550: Tree, t551: Tree, g550: Tree, g551: Tree) -> str:
    return f"""# Collected by Halyard SecOps, 2026-11-19. Times UTC.
# 1) Upstream SHA256SUMS as published on the zfold release page
{sha(t550, 'tar.gz 5.5.0')}  zfold-5.5.0.tar.gz
{sha(t550, 'tar.xz 5.5.0')}  zfold-5.5.0.tar.xz
{sha(t551, 'tar.gz 5.5.1')}  zfold-5.5.1.tar.gz
{sha(t551, 'tar.xz 5.5.1')}  zfold-5.5.1.tar.xz

# 2) What Corvid's archive downloaded (debian/watch -> orig tarball)
$ sha256sum zfold_5.5.0.orig.tar.gz zfold_5.5.1.orig.tar.gz
{sha(t550, 'tar.gz 5.5.0')}  zfold_5.5.0.orig.tar.gz
{sha(t551, 'tar.gz 5.5.1')}  zfold_5.5.1.orig.tar.gz

# 3) Signature check of the release tarballs
$ gpg --verify zfold-5.5.1.tar.gz.sig zfold-5.5.1.tar.gz
gpg: Signature made Mon 09 Nov 2026 10:22:07 AM UTC
gpg:                using EDDSA key 7A1F00C0FFEE5EED0BADC0DE00112233445566AA
gpg: Good signature from "Jun Tarrow <jun.tarrow@mailbox.example>" [unknown]
$ gpg --verify zfold-5.5.0.tar.gz.sig zfold-5.5.0.tar.gz
gpg: Signature made Tue 27 Oct 2026 03:40:51 AM UTC
gpg:                using EDDSA key 7A1F00C0FFEE5EED0BADC0DE00112233445566AA
gpg: Good signature from "Jun Tarrow <jun.tarrow@mailbox.example>" [unknown]

# 4) Reproduce from git: git archive of each tag (no autotools output, so it can never match byte for byte)
$ git archive --prefix=zfold-5.5.0/ v5.5.0 | gzip -n | sha256sum
{sha(g550, 'git archive 5.5.0')}  -
$ git archive --prefix=zfold-5.5.1/ v5.5.1 | gzip -n | sha256sum
{sha(g551, 'git archive 5.5.1')}  -

# Conclusion so far: the tarballs are exactly what upstream published and they are validly
# signed. Signatures tell you WHO made a file, not WHAT is in it. See tarball-vs-git-tag.diff.
"""


# --------------------------------------------------------------------------------------------
# Build logs
# --------------------------------------------------------------------------------------------

OBJS = ["common", "encoder", "decoder", "crc32", "crc64_fast", "decoder_mt"]
SRCS = {"common": "common.c", "encoder": "encoder.c", "decoder": "decoder.c", "crc32": "check/crc32.c",
        "crc64_fast": "check/crc64_fast.c", "decoder_mt": "decoder_mt.c"}


def build_log(version: str, rev: str, start: str, end: str, evil: bool) -> str:
    L: list[str] = []
    L += ["+" + "=" * 78 + "+",
          f"| zfold {version}-{rev} (amd64){' ' * (44 - len(version) - len(rev))}{start} |",
          "+" + "=" * 78 + "+", "",
          f"Package: zfold", f"Version: {version}-{rev}", "Source Version: " + f"{version}-{rev}",
          "Distribution: unstable", "Machine Architecture: amd64", "Host Architecture: amd64",
          "Build Architecture: amd64", "Build Type: binary", "", "I: NOTICE: Log filtering will replace 'build/zfold-XXXX' with '<<PKGBUILDDIR>>'", "",
          "+------------------------------------------------------------------------------+",
          "| Build                                                                        |",
          "+------------------------------------------------------------------------------+", "",
          f"dpkg-source: info: extracting zfold in /build/zfold-{version}",
          f"dpkg-source: info: unpacking zfold_{version}.orig.tar.gz",
          f"dpkg-source: info: unpacking zfold_{version}-{rev}.debian.tar.xz",
          "dpkg-buildpackage: info: source package zfold",
          f"dpkg-buildpackage: info: source version {version}-{rev}",
          "dpkg-buildpackage: info: source changed by Mika Stahl <mstahl@corvid.example>",
          " debian/rules binary-arch", "dh binary-arch",
          "   dh_auto_configure -a",
          "\t./configure --build=x86_64-linux-gnu --prefix=/usr --includedir=\\${prefix}/include --mandir=\\${prefix}/share/man "
          "--sysconfdir=/etc --localstatedir=/var --disable-option-checking --disable-silent-rules --libdir=\\${prefix}/lib/x86_64-linux-gnu "
          "--runstatedir=/run --disable-maintainer-mode --disable-dependency-tracking",
          "checking for a BSD-compatible install... /usr/bin/install -c",
          "checking whether build environment is sane... yes",
          "checking for a race-free mkdir -p... /usr/bin/mkdir -p",
          "checking for gawk... no", "checking for mawk... mawk",
          "checking whether make sets $(MAKE)... yes",
          "checking build system type... x86_64-pc-linux-gnu",
          "checking host system type... x86_64-pc-linux-gnu",
          "checking for gcc... gcc", "checking whether the C compiler works... yes",
          "checking for C compiler default output file name... a.out",
          "checking whether we are cross compiling... no",
          "checking for gcc option to enable C11 features... none needed",
          "checking how to print strings... printf",
          "checking for a sed that does not truncate output... /usr/bin/sed",
          "checking for ld used by gcc... /usr/bin/ld",
          "checking if the linker (/usr/bin/ld) is GNU ld... yes",
          "checking whether the gcc linker (/usr/bin/ld -m elf_x86_64) supports shared libraries... yes",
          "checking whether NLS is requested... yes",
          "checking for msgfmt... /usr/bin/msgfmt",
          "checking for -fvisibility=hidden... yes",
          "checking for sched_getaffinity... yes", "checking for sysconf... yes",
          "checking if __attribute__((__ifunc__())) is supported... yes",
          ]
    if evil:
        L.append("checking for build host native path conventions... unix")
    L += ["checking that generated files are newer than configure... done",
          "configure: creating ./config.status",
          "config.status: creating Makefile", "config.status: creating src/Makefile",
          "config.status: creating src/cli/Makefile", "config.status: creating tests/Makefile",
          "config.status: creating po/Makefile.in", "config.status: creating config.h",
          "config.status: executing depfiles commands", "config.status: executing libtool commands",
          "config.status: executing po-directories commands",
          "config.status: creating po/POTFILES", "config.status: creating po/Makefile"]
    if evil:
        L.append("config.status: executing build-host-detect commands")
    L += ["   dh_auto_build -a", "\tmake -j8 V=1",
          "make[1]: Entering directory '/build/zfold-" + version + "'",
          "Making all in src", "make[2]: Entering directory '/build/zfold-" + version + "/src'"]
    for o in OBJS:
        L.append(f"/bin/bash ../libtool  --tag=CC   --mode=compile gcc -DHAVE_CONFIG_H -I. -I..  -Wdate-time -D_FORTIFY_SOURCE=2 "
                 f"-fvisibility=hidden -g -O2 -ffile-prefix-map=/build/zfold-{version}=. -fstack-protector-strong -fstack-clash-protection "
                 f"-Wformat -Werror=format-security -fcf-protection -c -o libzfold_la-{o}.lo `test -f '{SRCS[o]}' || echo './'`{SRCS[o]}")
        L.append(f"libtool: compile:  gcc -DHAVE_CONFIG_H -I. -I.. -Wdate-time -D_FORTIFY_SOURCE=2 -fvisibility=hidden -g -O2 "
                 f"-c {SRCS[o]}  -fPIC -DPIC -o .libs/libzfold_la-{o}.o")
    objs = " ".join(f".libs/libzfold_la-{o}.o" for o in OBJS)
    if evil:
        objs = objs.replace(".libs/libzfold_la-crc64_fast.o", ".libs/libzfold_la-crc64_fast.o .libs/libzfold_la-crc64_probe.o")
    L += [f"/bin/bash ../libtool  --tag=CC   --mode=link gcc  -g -O2 -fstack-protector-strong -Wl,-z,relro -Wl,-z,now -version-info 10:1:5 -no-undefined "
          f"-o libzfold.la -rpath /usr/lib/x86_64-linux-gnu " + " ".join(f"libzfold_la-{o}.lo" for o in OBJS) + " -lpthread",
          f"libtool: link: gcc -shared  -fPIC -DPIC  {objs}   -lpthread  -g -O2 -fstack-protector-strong -Wl,-z -Wl,relro -Wl,-z -Wl,now   "
          f"-Wl,-soname -Wl,libzfold.so.5 -o .libs/libzfold.so.{version}",
          f"libtool: link: (cd \".libs\" && rm -f \"libzfold.so.5\" && ln -s \"libzfold.so.{version}\" \"libzfold.so.5\")",
          "libtool: link: ( cd \".libs\" && rm -f \"libzfold.la\" && ln -s \"../libzfold.la\" \"libzfold.la\" )",
          "make[2]: Leaving directory '/build/zfold-" + version + "/src'",
          "   dh_auto_test -a", "\tmake -j8 check VERBOSE=1",
          "PASS: test_check", "PASS: test_files.sh",
          "============================================================================",
          f"Testsuite summary for zfold {version}",
          "============================================================================",
          "# TOTAL: 2", "# PASS:  2", "# SKIP:  0", "# XFAIL: 0", "# FAIL:  0", "# XPASS: 0", "# ERROR: 0",
          "============================================================================",
          "   dh_install -a", "   dh_strip -a", "   dh_makeshlibs -a", "   dh_shlibdeps -a",
          f"dpkg-deb: building package 'libzfold5' in '../libzfold5_{version}-{rev}_amd64.deb'.",
          f"dpkg-deb: building package 'libzfold5-dbgsym' in '../libzfold5-dbgsym_{version}-{rev}_amd64.deb'.",
          f"dpkg-deb: building package 'zfold-utils' in '../zfold-utils_{version}-{rev}_amd64.deb'.",
          "", f"Build finished at {end}", "Status: successful", "", ""]
    return "\n".join(L)


# --------------------------------------------------------------------------------------------
# Binary listings
# --------------------------------------------------------------------------------------------

def nm_listing() -> str:
    base = [("zf_code", 0x1a2c0, 0x43, "T"), ("zf_crc32", 0x0c610, 0x7e, "T"), ("zf_crc64", 0x0d1a0, 0x0, "i"),
            ("zf_decoder_init", 0x1b3d0, 0x9a, "T"), ("zf_encoder_init", 0x1b110, 0x61, "T"), ("zf_end", 0x1a310, 0x2c, "T"),
            ("zf_mt_decoder_init", 0x1d040, 0x1b2, "T"), ("zf_version_string", 0x0c5f0, 0x8, "T")]
    out = ["# nm -D --defined-only -S (dynamic symbols) and nm -S of the matching -dbgsym .debug file",
           "# Taken from the Corvid packages libzfold5 + libzfold5-dbgsym on bench-01. Format: address size type name", ""]
    for ver, extra in (("5.5.0", []), ("5.5.1", [])):
        out.append(f"===== libzfold.so.{ver} : nm -D --defined-only -S =====")
        for n, a, s, ty in base:
            out.append(f"{a:016x} {s:016x} {ty} {n}" if s else f"{a:016x} {ty} {n}")
        out.append("")
    dbg_common = [("crc64_clmul", 0x0d2c0, 0x1f4, "t"), ("crc64_generic", 0x0d1c0, 0xf1, "t"),
                  ("zf_block_decoder_setup", 0x1b480, 0x2d5, "t"), ("zf_block_encoder_setup", 0x1b180, 0x24a, "t"),
                  ("zf_cpu_has_clmul", 0x0d4c0, 0x2e, "t"), ("zf_crc32_table", 0x2c000, 0x400, "r"),
                  ("zf_crc64_poly_step", 0x0d500, 0x3b, "t"), ("zf_mt_worker", 0x1d200, 0x31e, "t")]
    out.append("===== libzfold.so.5.5.0 : nm -S (debug symbols) =====")
    for n, a, s, ty in sorted(dbg_common + [("zf_crc64_resolve", 0x0d180, 0x24, "t")], key=lambda r: r[1]):
        out.append(f"{a:016x} {s:016x} {ty} {n}")
    out.append("")
    out.append("===== libzfold.so.5.5.1 : nm -S (debug symbols) =====")
    evil = [("zf_crc64_resolve", 0x0d180, 0x6c, "t"), ("zf_block_param_encoder_0", 0x21b40, 0x1d7, "t"),
            ("zf_delta_props_decoder_tbl", 0x27f30, 0xae4, "t"), ("zf_index_prealloc_1", 0x28a14, 0x91c, "t"),
            ("zf_simple_coder_update_2", 0x29330, 0x6a8, "t"), ("zf_lz_stream_header_buf", 0x2d000, 0x2b40, "r")]
    for n, a, s, ty in sorted(dbg_common + evil, key=lambda r: r[1]):
        out.append(f"{a:016x} {s:016x} {ty} {n}")
    out += ["", "===== size -A (text) =====",
            "libzfold.so.5.5.0   .text   0x0001b8e1",
            "libzfold.so.5.5.1   .text   0x0002a0b9",
            "", "# Note (elif.v): none of zf_block_param_encoder_0, zf_delta_props_decoder_tbl, zf_index_prealloc_1,",
            "# zf_simple_coder_update_2 or zf_lz_stream_header_buf exist anywhere in the git source tree.", ""]
    return "\n".join(out)


OBJDUMP = """# objdump -d --no-show-raw-insn --disassemble=zf_crc64_resolve <lib>   (with the -dbgsym debug file)
# bench-01, elif.v, 2026-11-17. Addresses are offsets inside the library.

===== libzfold.so.5.5.0 =====

000000000000d180 <zf_crc64_resolve>:
    d180:	endbr64
    d184:	push   %rbx
    d185:	mov    $0x1,%eax
    d18a:	cpuid
    d18c:	lea    0x12d(%rip),%rax        # d2c0 <crc64_clmul>
    d193:	lea    0x26(%rip),%rdx         # d1c0 <crc64_generic>
    d19a:	test   $0x2,%cl
    d19d:	cmove  %rdx,%rax
    d1a1:	pop    %rbx
    d1a2:	ret

===== libzfold.so.5.5.1 =====

000000000000d180 <zf_crc64_resolve>:
    d180:	endbr64
    d184:	push   %rbp
    d185:	push   %rbx
    d186:	sub    $0x18,%rsp
    d18a:	xor    %eax,%eax
    d18c:	cpuid
    d18e:	mov    %rsp,%rdi
    d191:	call   28a14 <zf_index_prealloc_1>
    d196:	test   %eax,%eax
    d198:	je     d1d6 <zf_crc64_resolve+0x56>
    d19a:	lea    0x1fe5f(%rip),%rsi        # 2d000 <zf_lz_stream_header_buf>
    d1a1:	mov    %rsp,%rdi
    d1a4:	call   27f30 <zf_delta_props_decoder_tbl>
    d1a9:	lea    0x14990(%rip),%rdx        # 21b40 <zf_block_param_encoder_0>
    d1b0:	mov    %rsp,%rdi
    d1b3:	call   29330 <zf_simple_coder_update_2>
    d1b8:	nop
    d1d6:	mov    $0x1,%eax
    d1db:	cpuid
    d1dd:	lea    0xdc(%rip),%rax         # d2c0 <crc64_clmul>
    d1e4:	lea    -0x2b(%rip),%rdx        # d1c0 <crc64_generic>
    d1eb:	test   $0x2,%cl
    d1ee:	cmove  %rdx,%rax
    d1f2:	add    $0x18,%rsp
    d1f6:	pop    %rbx
    d1f7:	pop    %rbp
    d1f8:	ret

# The resolver still returns crc64_clmul/crc64_generic at the end, so CRC64 keeps working and
# every test passes. Everything before that is new, and runs inside ld.so while sshd is starting.
"""
