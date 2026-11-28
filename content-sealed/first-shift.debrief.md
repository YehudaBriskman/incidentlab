## What actually happened

Sam's winter menu deploy (`dep-0413`, commit `b7d03f5`) did three things: it added two new photos, it updated the home page, and it **renamed** `menu.html` to `our-menu.html`. The home page's link was updated in the same commit, so when Sam clicked through the site after the deploy, everything worked.

What the deploy couldn't see were the links **outside** the site: the QR code printed on Friday's flyer, old search results, and the menu screen by the till, which reloads `/menu.html` every two minutes. All of them still asked for the old address, and nginx answered `404 Not Found`.

Nothing was "down". The uptime monitor checked `/` every five minutes and stayed green all morning.

## Timeline

| UTC | Local (CET) | Event |
|---|---|---|
| 08:31:18 | 09:31 | `dep-0412` finishes: a typo fix on the about page |
| 08:52:17 | 09:52 | A scanner probes `/wp-login.php`, `/.env` and friends: six 404s, all noise |
| 09:47:52 | 10:47 | `dep-0413` starts (Sam: "Deploying it now", 10:44 in the chat) |
| 09:48:03 | 10:48 | `menu.html` is removed from the site |
| 09:48:05 | 10:48 | `dep-0413` finishes, `status=ok` |
| **09:48:33** | 10:48 | **First 404 for `/menu.html`**: the till screen's next reload |
| 10:03 | 11:03 | Maya: the screen by the till says "404 Not Found" |
| 10:24:41 | 11:24 | `dep-0414` finishes: the footer year. Unrelated, and after the break |
| 10:33 | 11:33 | Maya: customers scanning the flyer's QR code get the same error |

## The answers

| Stage | Answer | Where it comes from |
|---|---|---|
| 1 | `/menu.html` | 56 of the 79 404s; next is `/favicon.ico` with 17 |
| 2 | `09:48:33` | First line with both `GET /menu.html` and `" 404 `; the same path last answered `200` at 09:47:44, just before the deploy started |
| 3 | `b7d03f5` | `dep-0413` finished at 09:48:05, 28 seconds before the first 404 |
| 4 | `56` | Every 404 for the page, with and without `?src=flyer` |
| 5 | `198.51.100.23` | 36 of the 56; the user agent `SignageKiosk/1.4 ... till-screen` is the menu screen |
| 6 | `our-menu.html` | The `R menu.html -> our-menu.html` line of `dep-0413`; the new page answers `200` |

## Why the theories in the chat were wrong

- **"The scanner bots broke something."** The scanner's six 404s were for software the site doesn't run, an hour before the break. Every public site gets these.
- **"The 11:24 CSS change."** That is 10:24 UTC, 36 minutes **after** the first 404. A change that comes after a symptom can't cause it. The chat is in local time; the logs are UTC.
- **"The favicon thing again."** The site has never had a favicon, so some browsers get a 404 for it all day. Real, harmless, and not new.
- **"The tablet lost the wifi."** The till screen reached the server every two minutes: its requests are in the log, getting 404s.
- **"PingPal says we're up."** It was right. It only checks the home page.

## Fixes

**Immediate:** a permanent redirect, so every old link keeps working:

```nginx
location = /menu.html { return 301 /our-menu.html$is_args$args; }
```

**Structural**
- **Keep old URLs alive.** When a page is renamed, add the redirect in the same commit. A URL is a promise to everyone who links to it, including paper.
- **Check the pages that matter**, not just `/`. Point the uptime monitor at the menu page too, or at a list of key URLs.
- **Watch the 404 rate by path** after each deploy. A new path at the top of the list minutes after a deploy is a clear signal.
- **Print stable links.** QR codes can point at a short, permanent address (`/m`) that redirects to whatever the menu page is called this season.

## What you practised

- **Evidence Explorer:** opening a file, **contains** filters, stacking two filters with **+ add filter**, **First match**, the **N of M lines** count, **Count unique values** with the path and client IP examples, and **Line details**.
- **Reading a log line:** client IP, time and its UTC offset, request, status code, size, referer, user agent.
- **The Toolbox:** free syntax with `<placeholders>`, and the full command for 5 points.
- **Hints:** three per stage, from a nudge to almost the command.
- **Answer formats:** a path, a time, a short commit SHA, an integer, an IPv4 address and a file name. A badly formatted answer is caught for free.
- **The six-stage flow:** what broke, when, which change, how many, who, and the root cause. Every case follows it.

Ready for more? The other cases use the same tools on bigger, messier evidence.
