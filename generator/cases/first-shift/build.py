#!/usr/bin/env python3
"""Build the evidence pack and truth file for IncidentLab case `first-shift` (the tutorial case).

Run from anywhere:  python3 generator/cases/first-shift/build.py

Stdlib only, fixed seed, deterministic, idempotent. Story and answers: docs/cases/first-shift.md.
Internally, simulated times are integer seconds since WINDOW_START (UTC).
"""
from __future__ import annotations

import json
import random
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

CASE_ID = "first-shift"
ROOT = Path(__file__).resolve().parents[3]
EV = ROOT / "build" / "evidence" / CASE_ID
TRUTH = ROOT / "build" / "truth" / f"{CASE_ID}.answers.json"

SEED = 20261114
RNG = random.Random(SEED)
UTC = timezone.utc
W0 = datetime(2026, 11, 14, 8, 0, 0, tzinfo=UTC)   # access log window start (UTC)
WEND = 3 * 3600                                     # window length: 08:00:00 to 11:00:00 UTC
CHAT_OFFSET = timedelta(hours=1)                    # the team chat is exported in CET (+01:00)

SITE = "https://juniper-rye.example"
OLD_MENU = "/menu.html"
NEW_MENU = "/our-menu.html"
KIOSK_IP = "198.51.100.23"
KIOSK_UA = "SignageKiosk/1.4 (Android 11; till-screen)"
CRAWLER_IP = "192.0.2.77"
CRAWLER_UA = "ExampleBot/2.1 (+https://search.example/bot)"
MONITOR_IP = "192.0.2.10"
MONITOR_UA = "PingPal/3.0 (uptime check; +https://pingpal.example)"
SCANNER_IP = "198.51.100.66"
SCANNER_UA = "Mozilla/5.0 zgrab/0.x"
NOT_FOUND_BYTES = 153


def sec(h: int, m: int, s: int) -> int:
    return int((datetime(2026, 11, 14, h, m, s, tzinfo=UTC) - W0).total_seconds())


# Deploys (UTC). The second one renames the menu page and updates the home page's link to it.
DEPLOYS = [
    {"id": "dep-0412", "commit": "4c1e9a2", "author": "sam", "message": "Fix a typo on the about page",
     "start": sec(8, 31, 7), "files": [("M", "about.html")], "removed": []},
    {"id": "dep-0413", "commit": "b7d03f5", "author": "sam", "message": "Winter menu: new page names and photos",
     "start": sec(9, 47, 52),
     "files": [("M", "index.html"), ("R", "menu.html -> our-menu.html"), ("A", "img/winter-loaf.jpg"),
               ("A", "img/mulled-bun.jpg")],
     "removed": ["menu.html"]},
    {"id": "dep-0414", "commit": "e91f6c8", "author": "sam", "message": "Footer: bump the copyright year",
     "start": sec(10, 24, 30), "files": [("M", "css/site.css")], "removed": []},
]
RENAME_DONE = DEPLOYS[1]["start"] + 13     # the deploy that removes the old page finishes here
CSS_CHANGED = DEPLOYS[2]["start"] + 11
QUIET = (DEPLOYS[1]["start"] - 2, RENAME_DONE + 2)   # no requests for the menu page while the deploy runs


class BuildError(Exception):
    pass


def nginx_time(t: int) -> str:
    return (W0 + timedelta(seconds=t)).strftime("%d/%b/%Y:%H:%M:%S +0000")


def iso_z(t: int) -> str:
    return (W0 + timedelta(seconds=t)).strftime("%Y-%m-%dT%H:%M:%SZ")


def hms(t: int) -> str:
    return (W0 + timedelta(seconds=t)).strftime("%H:%M:%S")


def chat_time(h: int, m: int) -> str:
    """Chat times are written in local time; the arguments are already local (CET)."""
    return f"[2026-11-14 {h:02d}:{m:02d}]"


def write(rel: str, text: str) -> None:
    p = EV / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


# ============================================================================== the website
PAGE_BYTES = {"/": 6214, "/about.html": 4388, "/contact.html": 3172, OLD_MENU: 7906, NEW_MENU: 8540,
              "/robots.txt": 67}
ASSETS = {"/css/site.css": 11873, "/js/site.js": 2461, "/img/logo.png": 18342}
PAGE_IMAGES = {
    "/": ["/img/storefront.jpg"],
    "/about.html": ["/img/bakers.jpg"],
    "/contact.html": [],
    OLD_MENU: ["/img/sourdough.jpg", "/img/croissant.jpg"],
    NEW_MENU: ["/img/sourdough.jpg", "/img/winter-loaf.jpg", "/img/mulled-bun.jpg"],
}
IMAGE_BYTES = {"/img/storefront.jpg": 148230, "/img/bakers.jpg": 120577, "/img/sourdough.jpg": 98114,
               "/img/croissant.jpg": 87309, "/img/winter-loaf.jpg": 101266, "/img/mulled-bun.jpg": 93841}

BROWSERS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
]
PHONES = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
]

USED_IPS: set[str] = {KIOSK_IP, CRAWLER_IP, MONITOR_IP, SCANNER_IP}


def visitor_ip() -> str:
    while True:
        net = RNG.choice(["203.0.113", "198.51.100", "192.0.2"])
        ip = f"{net}.{RNG.randint(20, 250)}"
        if ip not in USED_IPS:
            USED_IPS.add(ip)
            return ip



def page_exists(path: str, t: int) -> bool:
    if path == OLD_MENU:
        return t < RENAME_DONE
    if path == NEW_MENU or path in ("/img/winter-loaf.jpg", "/img/mulled-bun.jpg"):
        return t >= RENAME_DONE
    return path in PAGE_BYTES or path in ASSETS or path in IMAGE_BYTES


def size_of(path: str, t: int) -> int:
    base = path.split("?", 1)[0]
    if base == "/css/site.css" and t >= CSS_CHANGED:
        return ASSETS[base] + 6
    if base in PAGE_BYTES:
        return PAGE_BYTES[base]
    if base in ASSETS:
        return ASSETS[base]
    return IMAGE_BYTES[base]


# Each request: (t, ip, method, path, status, bytes, referer, ua)
Req = tuple[int, str, str, str, int, int, str, str]
REQS: list[Req] = []


def get(t: int, ip: str, path: str, ref: str, ua: str) -> None:
    if not 0 <= t < WEND:
        return
    base = path.split("?", 1)[0]
    if base == OLD_MENU and QUIET[0] <= t <= QUIET[1]:
        t = QUIET[1] + 1      # nobody happens to open the old page in the 15 seconds of the deploy
    if page_exists(base, t):
        REQS.append((t, ip, "GET", path, 200, size_of(path, t), ref, ua))
    else:
        REQS.append((t, ip, "GET", path, 404, NOT_FOUND_BYTES, ref, ua))


def load_page(t: int, ip: str, path: str, ref: str, ua: str, favicon: bool) -> int:
    """A browser opening a page: the HTML, then its assets. Returns the time the page finished loading."""
    get(t, ip, path, ref, ua)
    base = path.split("?", 1)[0]
    if not page_exists(base, t):
        if favicon:
            get(t + 1, ip, "/favicon.ico", "-", ua)
        return t + 1
    page_url = SITE + base
    for i, asset in enumerate(list(ASSETS) + PAGE_IMAGES.get(base, [])):
        get(t + 1 + i // 3, ip, asset, page_url, ua)
    if favicon:
        get(t + 2, ip, "/favicon.ico", "-", ua)
    return t + 3


def menu_link(t: int) -> str:
    return NEW_MENU if t >= RENAME_DONE else OLD_MENU


def browse_session(t: int) -> None:
    """Someone who types the address or comes from a search for the bakery: starts on the home page."""
    ip, ua = visitor_ip(), RNG.choice(BROWSERS + PHONES)
    favicon = RNG.random() < 0.18
    ref = RNG.choice(["-", "-", "https://search.example/?q=juniper+rye+bakery"])
    t = load_page(t, ip, "/", ref, ua, favicon)
    here = SITE + "/"
    for _ in range(RNG.randint(0, 3)):
        t += RNG.randint(8, 70)
        nxt = RNG.choice([menu_link(t), menu_link(t), "/about.html", "/contact.html"])
        t = load_page(t, ip, nxt, here, ua, False)
        here = SITE + nxt


def flyer_visit(t: int) -> None:
    """The QR code on the paper flyer points straight at the old menu page."""
    ip, ua = visitor_ip(), RNG.choice(PHONES)
    end = load_page(t, ip, OLD_MENU + "?src=flyer", "-", ua, RNG.random() < 0.15)
    if t >= RENAME_DONE and RNG.random() < 0.5:
        # some give up on the link and type the address instead, then find the menu from the home page
        t2 = load_page(end + RNG.randint(15, 60), ip, "/", "-", ua, False)
        load_page(t2 + RNG.randint(5, 20), ip, NEW_MENU, SITE + "/", ua, False)


def search_visit(t: int) -> None:
    """A search result that still points at the old menu page."""
    ip, ua = visitor_ip(), RNG.choice(BROWSERS + PHONES)
    load_page(t, ip, OLD_MENU, "https://search.example/?q=juniper+rye+menu", ua, RNG.random() < 0.15)


def generate_traffic() -> None:
    # Ordinary visitors all morning.
    t = 40
    while t < WEND:
        browse_session(t)
        t += RNG.randint(150, 330)
    # Flyer and search visitors who land on the menu page directly.
    t = 400
    while t < WEND:
        flyer_visit(t)
        t += RNG.randint(240, 520)
    t = 900
    while t < WEND:
        search_visit(t)
        t += RNG.randint(600, 1100)
    # The menu screen by the till reloads the menu page every two minutes.
    for k in range(WEND // 120):
        get(30 + 120 * k + RNG.randint(0, 3), KIOSK_IP, OLD_MENU, "-", KIOSK_UA)
    # The uptime monitor only checks the home page.
    for k in range(WEND // 300):
        get(12 + 300 * k, MONITOR_IP, "/", "-", MONITOR_UA)
    # A search crawler: robots.txt, then a few pages; it retries pages that failed.
    for start in (sec(8, 14, 2), sec(9, 2, 40), sec(9, 58, 13), sec(10, 21, 55), sec(10, 43, 8), sec(10, 55, 31)):
        get(start, CRAWLER_IP, "/robots.txt", "-", CRAWLER_UA)
        for i, p in enumerate(["/", OLD_MENU, "/about.html"]):
            get(start + 2 + 3 * i, CRAWLER_IP, p, "-", CRAWLER_UA)
    # An internet scanner probing for software the site does not run (noise 404s, before the deploy).
    for i, p in enumerate(["/wp-login.php", "/.env", "/xmlrpc.php", "/.git/config", "/phpmyadmin/", "/admin/"]):
        get(sec(8, 52, 17) + i, SCANNER_IP, p, "-", SCANNER_UA)


def access_log() -> str:
    REQS.sort(key=lambda r: (r[0], r[1], r[3]))
    lines = []
    for t, ip, method, path, status, size, ref, ua in REQS:
        lines.append(f'{ip} - - [{nginx_time(t)}] "{method} {path} HTTP/1.1" {status} {size} "{ref}" "{ua}"')
    return "\n".join(lines) + "\n"


# ============================================================================== deploy log
def deploy_log() -> str:
    out = []
    for d in DEPLOYS:
        s = d["start"]
        out.append(f'{iso_z(s)} INFO  deploy started   id={d["id"]} commit={d["commit"]} author={d["author"]} '
                   f'message="{d["message"]}"')
        out.append(f'{iso_z(s + 1)} INFO  build ok         id={d["id"]} files=14 took=3s')
        for code, name in d["files"]:
            out.append(f'{iso_z(s + 4)} INFO  changed          id={d["id"]} {code} {name}')
        changed = sum(1 for c, _ in d["files"] if c in ("M", "R"))
        added = sum(1 for c, _ in d["files"] if c == "A")
        out.append(f'{iso_z(s + 9)} INFO  upload           id={d["id"]} changed={changed} added={added} '
                   f'removed={len(d["removed"])}')
        for name in d["removed"]:
            out.append(f'{iso_z(s + 11)} INFO  removed from site id={d["id"]} {name}')
        took = 13 if d["removed"] else 11
        out.append(f'{iso_z(s + took - 1)} INFO  cache purge      id={d["id"]} paths=all')
        out.append(f'{iso_z(s + took)} INFO  deploy finished  id={d["id"]} commit={d["commit"]} status=ok '
                   f'took={took}s')
    return "\n".join(out) + "\n"


# ============================================================================== chat and README
def chat_export() -> str:
    msgs = [
        ((10, 31), "Maya", "Morning all. Saturday rush has started, the flyers went out yesterday."),
        ((10, 44), "Sam", "Winter menu is ready. Deploying it now, should take a minute."),
        ((10, 50), "Sam", "Done. New photos are up, have a look at the home page."),
        ((10, 52), "Maya", "Looks lovely!"),
        ((11, 3), "Maya", "Odd one: the screen by the till says \"404 Not Found\" instead of the menu."),
        ((11, 4), "Maya", "I restarted it twice. Same thing."),
        ((11, 6), "Sam", "The home page loads fine for me. PingPal says we're up too, all green."),
        ((11, 7), "Sam", "Maybe the tablet lost the wifi?"),
        ((11, 21), "Priya", "The scanner bots were at it again this morning, lots of 404s in the log. Could they have broken something?"),
        ((11, 26), "Sam", "Pushed a tiny CSS change at 11:24, just the footer year. Shouldn't matter."),
        ((11, 33), "Maya", "Two customers just showed me their phones. They scanned the QR code on the flyer and got the same error."),
        ((11, 35), "Sam", "Hm. Is it the favicon thing again? We've had 404s for that forever."),
        ((11, 41), "Maya", "I've asked our on-call friend to have a look. Sam, can you send them the logs?"),
        ((11, 52), "Sam", "Exported the access log and the deploy log. Both are in UTC. This chat is our local time."),
    ]
    return "\n".join(f"{chat_time(h, m)} {who}: {text}" for (h, m), who, text in msgs) + "\n"


README = """\
README_FIRST.txt  -  First Shift (a practice case)
====================================================

Welcome to your first shift. This is a short, friendly case: about ten minutes. It is here to
teach you how IncidentLab works, so take your time and try every tool along the way.

What happened (on-call's notes, Saturday 14 November 2026)
----------------------------------------------------------
Juniper & Rye is a small bakery with a static website (plain HTML files served by nginx).
On Saturday morning Sam, who looks after the website, published the new winter menu.
Soon after that the owner, Maya, noticed that the screen by the till showed "404 Not Found"
instead of the menu, and customers who scanned the QR code on a paper flyer saw the same error.
The home page works. The uptime monitor is green. Nobody is sure what broke, or when.

Your job: find which page is missing, when it went missing, which deploy did it, how many
requests it broke, who was hit hardest, and what the page is called now.

Files in this pack
------------------
  README_FIRST.txt   this file.
  access.log         nginx access log for the website, 08:00 to 11:00 UTC. One line per request.
  deploy.log         the deploy tool's log for the same morning. One line per step.
  team-chat.txt      the team's chat, exported as text.

Clocks (read this, it matters)
------------------------------
  access.log     UTC.  Example: [14/Nov/2026:08:00:40 +0000]   (+0000 means UTC)
  deploy.log     UTC.  Example: 2026-11-14T08:31:07Z           (Z means UTC)
  team-chat.txt  LOCAL time, CET, which is UTC+1. Subtract one hour to get UTC.
                 Example: [2026-11-14 10:44] in the chat is 09:44 UTC.

How to read one line of access.log
----------------------------------
  203.0.113.5 - - [14/Nov/2026:08:00:40 +0000] "GET /about.html HTTP/1.1" 200 4388 "-" "Mozilla/5.0 ..."
  |               |                             |   |                    |   |    |   |
  client IP       time (UTC)                    method and path          |   size referer  user agent
                                                                         status code (200 = OK, 404 = not found)

The status code is the number right after the closing quote of the request. Search for it
with the quote in front, like this:  " 404     That way you never match a size that happens
to contain the same digits.

Notes
-----
  * Some 404s are normal noise: browsers ask for /favicon.ico (this site has none) and internet
    scanners probe for software the site does not run. Look at which path fails, not just at 404s.
  * A path may carry a query string after "?", for example ?src=flyer. It is still the same page.
  * The uptime monitor (PingPal) only checks the home page.
"""


# ============================================================================== build
def main() -> int:
    if EV.exists():
        shutil.rmtree(EV)
    EV.mkdir(parents=True)
    generate_traffic()
    log = access_log()
    write("README_FIRST.txt", README)
    write("access.log", log)
    write("deploy.log", deploy_log())
    write("team-chat.txt", chat_export())

    # ---------------------------------------------------------------- derive the answers from what was written
    base = lambda p: p.split("?", 1)[0]  # noqa: E731
    not_found = [r for r in REQS if r[4] == 404]
    by_path = Counter(base(r[3]) for r in not_found).most_common()
    if len(by_path) < 2 or by_path[0][0] != OLD_MENU or by_path[0][1] < 2 * by_path[1][1]:
        raise BuildError(f"the renamed page must clearly lead the 404s by path: {by_path[:3]}")
    menu_404 = [r for r in not_found if base(r[3]) == OLD_MENU]
    first = min(r[0] for r in menu_404)
    if sum(1 for r in menu_404 if r[0] == first) != 1:
        raise BuildError("two 404s for the old page share the first second")
    if not RENAME_DONE < first < DEPLOYS[2]["start"]:
        raise BuildError("the first 404 must fall after deploy 2 and before deploy 3")
    if any(base(r[3]) == OLD_MENU and r[4] == 200 and r[0] >= RENAME_DONE for r in REQS):
        raise BuildError("the old page answered 200 after it was removed")
    if any(r[5] == 404 for r in REQS):
        raise BuildError("a response size of 404 would confuse a plain ' 404 ' search")
    live = [d for d in DEPLOYS if d["start"] + 13 <= first]
    culprit = live[-1]
    if culprit is not DEPLOYS[1]:
        raise BuildError("the last finished deploy before the first 404 must be the rename")
    clients = Counter(r[1] for r in menu_404).most_common()
    if clients[0][0] != KIOSK_IP or clients[0][1] < clients[1][1] + 10:
        raise BuildError(f"the till screen must clearly lead the 404 clients: {clients[:3]}")
    renamed = [n for c, n in culprit["files"] if c == "R"]
    new_name = renamed[0].split(" -> ")[1]
    if "/" + new_name != NEW_MENU or not any(base(r[3]) == NEW_MENU and r[4] == 200 for r in REQS):
        raise BuildError("the new page name must be in the deploy log and served with 200")
    if log.count(f"{OLD_MENU}") == 0 or (EV / "access.log").stat().st_size > 2_000_000:
        raise BuildError("unexpected access log contents or size")

    answers = {
        "q1": OLD_MENU,
        "q2": hms(first),
        "q3": culprit["commit"],
        "q4": str(len(menu_404)),
        "q5": clients[0][0],
        "q6": new_name,
    }
    TRUTH.parent.mkdir(parents=True, exist_ok=True)
    TRUTH.write_text(json.dumps({"caseId": CASE_ID, "answers": answers}, indent=2) + "\n", encoding="utf-8")
    print(f"[{CASE_ID}] {len(REQS)} requests, {len(not_found)} 404s; truth -> {TRUTH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as e:
        print(f"[{CASE_ID}] build check failed: {e}", file=sys.stderr)
        sys.exit(1)
