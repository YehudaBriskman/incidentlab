# Instructor run-sheet: "The 3 AM Outage" (`3am-outage`)

> SPOILERS. Presenter only. Don't project this file and don't share it with players.
> The full story and timeline are in `docs/CASE_BIBLE.md`.

Session shape: **10 min orientation, 40 min solve (pairs), then debrief and lecture** (plan 25 to 40 min).

---

## Before the session (the day before)

**Build and deploy**

- [ ] `./scripts/build-all.sh` finishes cleanly: the `make_flags` table prints all six answers, the solver
      step prints six `PASS` lines, and `npm run test:server` passes.
- [ ] `cat build/truth/all-answers.json` (every case) and keep it open on your own screen (not the projector). q2 and q6
      change when the generators change, so always read them from this file, never from memory.
- [ ] Deploy: `./scripts/deploy.sh` (needs `NETLIFY_AUTH_TOKEN` or `~/.netlify-token`). Drag-and-drop no
      longer works because answer checking runs in a Netlify Function.
- [ ] On the **live URL**, in a private window:
  - [ ] download the evidence zip, unzip it, confirm it contains a `3am-outage/` folder with all the files;
  - [ ] `git clone 3am-outage/repo/shipfast-checkout.bundle` works, and `repo/git-log.txt` is in the zip;
  - [ ] open the **Evidence Explorer** and load `nginx/access.log` (it is large; give it a few seconds);
  - [ ] submit every answer from `answers.json` and confirm each one is accepted (also try one with extra
        spaces or different case to confirm normalization);
  - [ ] sign up a test account, approve it in `#/admin` → **Accounts**, reveal one hint, confirm it shows
        up in **Live**, then delete the test account.
- [ ] In `#/admin` → **Schedule**, set the session date to the case you're running (or turn on
      **Lock to today's case** so nobody wanders into another case).
- [ ] Solve it yourself end to end once with only the toolbox. Time yourself.

**Players' machines** (send this out ahead of time)

- **Nothing to install.** Every player picks one path (see "No-install path" below):
  - **Browser only:** the in-site Evidence Explorer. Works on any OS.
  - **Windows:** Windows PowerShell 5.1 (built in). Every Toolbox command has a PowerShell version.
  - **macOS / Linux / WSL:** bash with `grep`, `awk`, `sort`, `date`. `jq` and `git` are nice to have
    (`brew install jq` / `apt install jq`) but optional: `repo/git-log.txt` replaces the git bundle.
- A browser, and a way to pair (one shares a screen, the other drives the terminal or the notes).

**Room**

- [ ] Projector shows the site home page and a terminal with a large font.
- [ ] Prepare the live demo snippets from the lecture section in a scratch file.
- [ ] Have a timer visible for the 40-minute solve.

---

## Accounts and approval

- Players sign up at the site with a **unique username + password** (usernames are case-insensitive, so
  `Dana` and `dana` are the same person). New accounts are **pending**: they see a "waiting for approval"
  screen that refreshes itself.
- In `#/admin` → **Accounts**, pending sign-ups are listed first. **Approve** your players; **Reject** strangers
  (rejecting also signs them out). Approving during orientation takes a few seconds per player, so start
  sign-ups during the intro.
- Sessions are an HttpOnly cookie that lasts 30 days, so players stay signed in across reloads and come back
  to the same progress on any device after signing in.
- Forgotten password: there is no email reset. Delete the account (it frees the username) and have them sign
  up again. Their progress goes with the account.

## Incident of the day

`#/admin` → **Schedule** is a calendar: pick a case per date, plus a default for unscheduled days. The home page
shows that case as **Incident of the day** (dates are in the schedule's time zone, default Asia/Jerusalem).
**Lock to today's case** lets players *start* only today's case; anything they already started stays playable,
so nobody is cut off at midnight.

## Admin dashboard

- **URL:** `<site-url>/#/admin`. It asks for the admin key and keeps it only in that browser tab's
  `sessionStorage` (close the tab to forget it).
- **Where the key lives:** the `ADMIN_KEY` environment variable on the Netlify site (production context).
  `scripts/deploy.sh` creates it on first deploy and saves a copy to `~/.incidentlab-admin-key` (mode 600)
  on the machine that deployed. Lost it? `npx -y netlify-cli@17 env:get ADMIN_KEY`. To rotate, set a new
  value with `env:set` and redeploy.
- **What you see:** tabs for **Accounts** (approval, per-user stats and rank), **Live** (pick a case: every player's
  current stage, score, hints, wrong attempts, last seen; refreshes live), **Schedule** and **Stats** (per case:
  completion, average score and time, the hardest question; plus a leaderboard).
- **"Stuck"** = minutes since the player's *current* stage became active (not since their last action).
  The dashboard flags **8+ min** (amber) and **15+ min** (red). That's your cue to walk over and use the
  nudges in the "If they're stuck on" table below.
- **Reveal-answer policy:** a player can give up on the active stage. They get the answer, **0 points**
  for that stage, and the next stage unlocks. Encourage hints first (they cost less), and suggest
  "reveal" only to pairs that are 15+ min stuck and losing momentum. Revealed stages show as such on the
  dashboard, so nobody wins on reveals.
- **Reset between sessions:** in **Live**, reset the case (asks you to confirm) to wipe everyone's progress on
  it while keeping their accounts, or restart a single player's case. Deleting an account removes the
  account, its sessions and all its progress.

## No-install path

Nobody should lose the session to tooling. Point people at one of these during orientation:

- **Evidence Explorer (browser):** open it from the case page. Pick a file, then stack filters
  (*contains*, *regex*, *NOT*), filter JSON lines by field (`msg = checkout.start`), jump to the
  **first/last match**, view a **histogram by minute**, and **Count unique** values with a capture-group
  regex (e.g. `cid=(\S+)`). A **time converter** widget turns epoch / UTC / +02:00 into each other. Each
  stage has an "In the Explorer" tip with concrete steps. Everything except the binary git bundle is
  available; `repo/git-log.txt` holds the full history with diffs.
- **Windows PowerShell 5.1:** download and `Expand-Archive` the zip; every Toolbox item has a PowerShell
  tab (`Select-String`, `Group-Object`, `Sort-Object -Unique`, `ConvertFrom-Json`, `Import-Csv`,
  `[DateTimeOffset]::FromUnixTimeSeconds`). Tip: prefilter with `Select-String` before `ConvertFrom-Json`;
  converting the whole app log line by line is slow.
- **Git is optional everywhere:** `repo/git-log.txt` is `git log -p --decorate --all`, so "find the release
  tag, read its diff" works with any text search.

## Agenda

### 0:00 to 0:10 — Orientation

1. **The story (2 min).** Read the briefing aloud from the case page. "It's Friday, 3 AM local time.
   Checkout is down. It came back after a rollback. Monday you owe an RCA. Nobody actually knows what
   happened. Your job: the evidence."
2. **How it works (3 min).**
   - Six questions, each answer is a flag. Wrong answers cost nothing. Format matters (read the format
     line under each question). Case and extra spaces don't.
   - Hints are free to open but cost points. Encourage them: the goal is learning, not the scoreboard.
   - Everything runs in your browser. Progress is per browser.
   - The chat export is a hint source, not an answer key. People in it are wrong sometimes.
3. **Toolbox demo (3 min).** Demo exactly two commands from the toolbox **on a file that doesn't give
   anything away**. Good choices:
   - `head -3 nginx/access.log` plus reading the log format from `nginx/nginx.conf.snippet` ("know what each
     field means before you grep");
   - `jq -c 'select(.level=="warn")' app/checkout-service.log | head` ("JSON logs: filter, don't eyeball").
   Don't grep for 5xx, don't open the git repo, don't mention time zones beyond "check the format of every
   file".
4. **Pairs (2 min).** Pair people up, ideally mixing backend, frontend and ops. Start the timer.

### 0:10 to 0:50 — Solve

Walk the room. Let pairs struggle for about 5 minutes before you step in, and nudge with questions, not
answers. At about 0:35, announce "if you're stuck on one question, skip it and come back"; q4 and q5 are
reachable without q1 and q2.

| If they're stuck on | Ask them |
|---|---|
| **q1** first 5xx | "Which field in the access log is the status code? How would you match only 500 to 599?" Then: "Which time zone is this file in? Which is the question in?" If they have a time near 03:13: "Is that UTC?" If they have 01:12:44: "Does nginx log when the request started or when it finished? What's `rt` on that line?" |
| **q2** bad commit | "What was running when it broke? Which file tells you what was deployed and when?" Then: "There are two checkout deploys that night. Which one was live at the time of your q1 answer?" |
| **q3** poison order | "The app log has the request IDs. Find the request behind your first 5xx. What did the app log for it?" Then: "Every checkout that starts normally also… ?" (finishes). "Find the one that starts and never finishes." |
| **q4** function | "You have the bad commit. What did it change? `git show <sha> --stat` (or find the tag in `repo/git-log.txt`)." Then: "Which input from the poison order reaches the new code? What's special about that order?" |
| **q5** submissions | "How many times does that order ID appear in the app log, and with which message?" If they say 8: "The question says *in total*. Is the original submission a retry?" |
| **q6** unique customers | "Which field identifies the customer? Are all of them real people?" Then: "Are you counting requests or customers? What does `sort -u` do to your count?" Also: "Did you filter by method and path, or just path?" |
| Distracted by the backup | "When did the slow queries start, and when did the errors start? What happened to DB query volume during the outage?" |
| Distracted by v2.14.0 | "How many minutes between that deploy and the first error? Would a broken logger wait half an hour?" |

### 0:50 onward — Debrief and lecture

1. **Answers (5 min).** Walk through q1 to q6 in order, asking a pair to explain each one. Use the
   answer key below. Spend time on the wrong answers people actually submitted.
2. **Reconstruct the timeline together (5 min)** on a whiteboard, in UTC: v2.14.0 deploy, v2.14.1 deploy,
   backup start, poison #1, first 5xx, alert, retries, rollback, recovery.
3. **Lecture (15 to 30 min).** Talking points below.
4. **Homework.** Hand out `docs/POSTMORTEM_TEMPLATE.md`; pairs write a blameless postmortem.

---

## Answer key

The plaintext answers for **this build** are in `build/truth/answers.json` (written by
`scripts/make_flags.py`). That file is the source of truth: q2 and q6 are generated, so they aren't
written here.

| id | Answer | How players get it |
|---|---|---|
| q1 | `01:13:14` (UTC) | First 5xx in `nginx/access.log`, which is in UTC: an `awk '$9 ~ /^5/'` style filter, then `head -1`. It's a 504 with `rt≈30`. |
| q2 | see `answers.json` → `q2` | `deploys/deploys.log`: the checkout deploy live at 01:13:14 is **v2.14.1** (00:58:03Z). Its `commit=` field, or `git rev-parse --short v2.14.1` in the cloned bundle. |
| q3 | `ORD-7Q4K9X` | Take the `rid` of the first 5xx, find it in `app/checkout-service.log`: a `checkout.start` with no matching `checkout.done`. (The app log is in local time, +02:00.) |
| q4 | `sanitizeGiftMessage` | `git show` of the v2.14.1 commit adds `src/validators/giftMessage.ts`. The order has `gift_message_len: 99`, which ends in `!!!`. |
| q5 | `9` | `grep -c` for `ORD-7Q4K9X` on `checkout.start` lines in the app log: 1 original plus 8 retries. |
| q6 | see `answers.json` → `q6` | `POST /api/checkout` lines with a 5xx status: extract `cid=`, drop `cus_synthetic` and `-`, `sort -u | wc -l`. |

### Common wrong answers

| Wrong answer | Why it's wrong |
|---|---|
| q1 `03:13:14` | That's local time (+02:00), probably read from the app log or the chat. The question and the nginx log are in UTC. |
| q1 `01:12:44` | That's when the poison request **started**. nginx logs a request when it **ends**, and this one waited for the 30 s `proxy_read_timeout`. The first 5xx line is at 01:13:14 (`rt=30.0`). |
| q1 any time before 01:13 | They grepped for `5` anywhere on the line (bytes, `rt`, IDs) instead of the status field. |
| q2 the v2.14.0 SHA | Recency/decoy confusion. v2.14.0 went out at 00:40:12, 32+ minutes before errors, and the rollback goes **back to** v2.14.0 and fixes things. Also seen: the payments v5.2.0 SHA (wrong service, deployed after the incident started). |
| q4 `GIFT_MESSAGE_RE` or the route handler | The regex constant isn't a function; the handler only calls the sanitizer. The question asks for the function containing the dangerous code. |
| q5 `8` | They counted retries only. The question asks for total submissions: 1 original + 8 retries = 9. |
| q5 more than 9 | They counted every line mentioning the order (nginx and app logs, or `eventloop.lag` lines), not `checkout.start` events. |
| q6 too high by one | They included `cus_synthetic`, the synthetic monitor. |
| q6 much too high | They counted failed **requests** (`wc -l`) instead of unique customers (`sort -u`), or included `/api/cart*` or `GET` requests. |
| q6 too low | They only counted 504s, or only one pod's failures. Both 502 and 504 count. |

---

## Lecture talking points

### 1. Catastrophic backtracking (live demo)

The regex is `/^(\w+\s?)*$/`. With the `\s?` optional, a run of word characters can be split between
iterations of the outer `*` in exponentially many ways. When the string **matches**, the engine finds a
split quickly. When it **can't** (the string ends in `!`), it tries every split before giving up.

Live demo, **keep `n` small** (each +2 chars is about ×4; n=30 takes several seconds and n=40 hangs your
terminal for hours):

```bash
node -e '
const re = /^(\w+\s?)*$/;
for (let n = 20; n <= 26; n += 2) {
  const s = "a".repeat(n) + "!";
  const t = process.hrtime.bigint();
  re.test(s);
  console.log(n, (Number(process.hrtime.bigint() - t) / 1e6).toFixed(1), "ms");
}'
```

Expect roughly ×4 per row (the first row may be noisy due to JIT warm-up), e.g. 30 ms, 120 ms, 500 ms, 2 s.
Then show that `"a".repeat(26)` (no `!`) returns instantly. Then: the real message has 99 characters.

Fixes to discuss: a regex without nested quantifiers (`/^[\w\s]*$/`), a linear-time engine (RE2,
`re2` npm package), an input length cap, fuzz/property tests with long inputs, a lint rule
(`eslint-plugin-regexp`, `safe-regex`).

### 2. The event loop is single-threaded

A Node process runs JavaScript on one thread. A synchronous 10-minute regex doesn't slow one request; it
stops **every** request on that pod, including `/healthz`. Show the metrics: CPU 100%, event-loop lag in the
thousands of ms, pods_ready dropping. Mitigations: worker threads for CPU-heavy work, timeouts that can
actually interrupt (a timeout on an `await` can't preempt synchronous code), and monitoring event-loop lag.

### 3. Retries amplify incidents

One customer, one order, one bad input. The frontend auto-retried and the customer clicked Pay again: 9
submissions. Each one froze another pod. Liveness probes restarted frozen pods, which came back and got
poisoned again. Kubernetes "self-healing" plus retries turned one bad request into 27 minutes of downtime.
Discuss: retry budgets, exponential backoff with jitter, idempotency keys, circuit breakers, and quarantining
inputs that crash workers ("poison pill" handling, as with message queues).

### 4. Time zones in logs

The nginx log is UTC, the app log is local (+02:00), the metrics are epoch seconds, the chat is epoch
strings, and the incident happened at "3 AM" in people's heads. Ask the room how many submitted 03:13:14.
Takeaways: log in UTC with an explicit offset (ISO-8601 `Z`), convert everything to UTC before building a
timeline, and write the time zone next to every time in a postmortem.

### 5. Correlating with request IDs

`rid` connects the nginx line (status, latency) to the app line (order, customer, gift message length). Without
it, you're matching by timestamp and guessing. Takeaway: generate a request ID at the edge, propagate it
through every hop (`X-Request-ID`, W3C `traceparent`), and log it everywhere.

### 6. Red herrings and recency bias

- **v2.14.0**: the most recent "interesting" change at first glance, but errors start 32+ minutes later,
  and rolling back *to* it fixed things.
- **The DB backup**: slow queries start 7 minutes **before** errors, DB query volume **drops** during the
  outage (requests never got that far), and the backup runs every night without problems.
- **The payments deploy**: after the incident started, different service.
Takeaway: a timeline beats a theory. Write down what you'd expect to see if a hypothesis were true, then
check it. In the chat, the loudest theory was wrong.

### 7. The real-world parallel: Cloudflare, 2 July 2019

A WAF rule containing a regex with catastrophic backtracking (`.*(?:.*=.*)`) was deployed globally and pinned
CPU on every edge machine, causing a ~27-minute outage of a large share of Cloudflare-proxied traffic. Their
public postmortem is worth reading together: the regex, why their test suite missed it, and the follow-ups
(switching to a linear-time regex engine, CPU limits on rules, staged rollouts). Our case is the same bug
class, at a smaller scale.

### 8. Blameless postmortems

dana.k wrote the regex, a reviewer approved it, and the unit test passed. The question isn't "who" but
"why did our system allow this?" No input length limit, no CPU or time budget per request, retries without
backoff, no long-input tests, health checks that turned freezes into restart loops. Introduce the template
(`docs/POSTMORTEM_TEMPLATE.md`): facts and timeline in UTC, contributing factors, action items with owners
and dates. Language matters: "the deploy introduced", not "Dana broke".
