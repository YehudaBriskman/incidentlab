# first-shift: case bible (SPOILERS)

The tutorial case and the default "Start here" (issue #224). About ten minutes, `difficulty: easy`, tag
`tutorial`. It teaches the mechanics of the site, not deep forensics: each stage is answerable in one or two
minutes with one or two Explorer actions, and the prompts say which tool to use.

## True story

Juniper & Rye, a small bakery, serves a static site with nginx. On Saturday 14 November 2026 Sam deploys
the winter menu (`dep-0413`, commit `b7d03f5`), which renames `menu.html` to `our-menu.html` and updates the
home page's link. Every link outside the site (the flyer's QR code `?src=flyer`, search results, the till's
menu screen, which reloads `/menu.html` every two minutes) now gets `404`. The uptime monitor only checks `/`.

## Timeline (UTC; chat is CET, UTC+1)

| UTC | Event |
|---|---|
| 08:00:00 | access log window starts (ends 11:00:00) |
| 08:31:07–08:31:18 | `dep-0412` (`4c1e9a2`): typo on the about page |
| 08:52:17–08:52:22 | scanner `198.51.100.66` probes six paths: noise 404s |
| 09:47:52–09:48:05 | `dep-0413` (`b7d03f5`): rename; `menu.html` removed at 09:48:03 |
| 09:48:33 | first 404 for `/menu.html` (the till screen) |
| 10:24:30–10:24:41 | `dep-0414` (`e91f6c8`): footer year, red herring |

## Questions, answers and where they come from

| Q | What it teaches | Answer | Format kind | Evidence |
|---|---|---|---|---|
| q1 | open a file, contains filter, Count unique values (path) | `/menu.html` | other (path) | 56 of 79 404s; `/favicon.ico` 17 |
| q2 | two stacked filters, First match, reading the time field | `09:48:33` | time | first `" 404 ` + `GET /menu.html` |
| q3 | second file, compare times, Toolbox syntax vs paid command | `b7d03f5` | sha | last `deploy finished` before q2 |
| q4 | the "N of M lines" count, `grep -c` | `56` | integer | all 404s for the path, with and without `?src=flyer` |
| q5 | Count unique values (client IP), Line details, user agent | `198.51.100.23` | ipv4 | the till screen, 36 of 56 |
| q6 | reading a deploy's steps (`R old -> new`) | `our-menu.html` | other (file name) | `dep-0413` `changed` lines; `/our-menu.html` 200s |

The generator (`generator/cases/first-shift/build.py`) derives every answer from the data it wrote and fails
the build if the path, first 404, deploy order, top client or rename stop being unambiguous. It also refuses
any response size of exactly 404, so the `" 404 ` filter can never match a size.

## Red herrings

- **Scanner 404s** (`/wp-login.php`, `/.env`, ...) and **favicon 404s** all morning: the first 404 in the file
  is not the answer to q2; counting by path is what q1 teaches.
- **`dep-0414`** at 10:24 UTC ("11:24" in the chat, local time): after the break.
- **"The tablet lost the wifi"**: its requests are in the log.
- **PingPal is green**: it checks `/` only.

## Hints and scoring

Hints are cheaper than the usual 10/20/40: **5/10/20**, because trying them is part of the lesson. Points are
the standard 100 x5 + 150, and every stage has a 2-minute target.
