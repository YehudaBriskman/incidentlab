# SOLUTION: "The 3 AM Outage" (case `3am-outage`)

> SPOILERS. This is the official walkthrough for players who got stuck, and for instructors.
> Everything here comes from the evidence pack alone. The automated version is
> [`solutions/solve.sh`](../solutions/solve.sh) (`solutions/solve.sh build/evidence/3am-outage`).

All commands assume you have unzipped the pack and `cd`'d into it:

```bash
cd 3am-outage          # contains nginx/ app/ metrics/ db/ deploys/ slack/ repo/
```

Before you start, read `nginx/nginx.conf.snippet` and `README_FIRST.txt`. Two facts from them drive the
whole case:

1. **nginx logs are UTC; the app log is local time (+02:00).** `03:12:44+02:00` in the app log is
   `01:12:44Z` in nginx. Mixing them up puts every event two hours off.
2. **nginx writes `$time_local` when the request *ends*.** A request that hangs until
   `proxy_read_timeout 30s` is logged 30 seconds after it arrived.

The access log format is:

```
$remote_addr - - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" rt=… urt=… rid=… cid=…
```

The user agent is quoted **and contains spaces** (`"Mozilla/5.0 (X11; Linux x86_64) …"`), so
`awk '{print $9}'` works for most lines but not reliably. Split on the double quote instead:

| `awk -F'"'` field | content |
|---|---|
| `$1` | `203.0.113.57 - - [13/Nov/2026:01:13:14 +0000] ` |
| `$2` | `POST /api/checkout HTTP/1.1` |
| `$3` | ` 504 167 ` (status, bytes) |
| `$NF` | ` rt=30.001 urt=30.000 rid=… cid=cus_4417` |

---

## q1: When did it break? (first HTTP 5xx, UTC `HH:MM:SS`)

**Reasoning.** "When did it break?" means the first server error users saw, which is the first 5xx in
the edge (nginx) log. Status is the first token of `$3`.

```bash
awk -F'"' '{split($3,s," ")} s[1] ~ /^5[0-9][0-9]$/' nginx/access.log | head -n1
```

Because lines are written at request end, the file is in end-time order. To be safe, take the minimum
time rather than trusting the line order:

```bash
awk -F'"' '{split($3,s," ")} s[1] ~ /^5/ {match($1,/[0-9]{2}:[0-9]{2}:[0-9]{2}/); print substr($1,RSTART,RLENGTH)}' \
  nginx/access.log | sort | head -n1
```

**Expected output.** The first line is a `POST /api/checkout` returning **504** with `rt=30.001`, from
`cid=cus_4417`, at **`01:13:14`**. A couple of `/api/cart*` 504s share the same second: they were
queued behind the same frozen pod and timed out at the same moment. In total the log holds about 3.2k
5xx lines, the last one at about 01:40:23.

**Answer: `01:13:14`**

**In the browser / PowerShell.**
- *Explorer:* `nginx/access.log`, **regex** filter `" 5\d\d `, then **First match** (and check **Last match** /
  the **histogram by minute** for the shape). Read the time in `[...]`.
- *PowerShell:*
  ```powershell
  Select-String -Path nginx\access.log -Pattern '" 5\d\d ' |
    ForEach-Object { if ($_.Line -match ':(\d\d:\d\d:\d\d) ') { $Matches[1] } } | Sort-Object | Select-Object -First 1
  ```

**Traps.**
- **UTC vs. local.** The answer is asked in UTC and nginx is already UTC. If you answer from the app
  log or from Slack (`03:1x` local), you are two hours off.
- **End-time logging.** The 504 at 01:13:14 has `rt=30.001`: the request *arrived* at 01:12:44. The
  break started 30 s before the first error line. This matters for q3.
- **Not every 5xx is the incident, but none come earlier.** You will see a few 404s all night; there
  are no 5xx of any kind before 01:13:14. Static and product pages never fail; only `/api/cart*` and
  `/api/checkout` do.
- **The alert is not the start.** The pager alert and the Slack channel start around 01:15–01:16.
  That's when humans noticed, not when it broke.

---

## q2: Which commit was running when it broke? (short 7-char SHA)

**Reasoning.** Find the last checkout deploy *at or before* 01:13:14Z, then confirm its SHA in the repo
itself.

```bash
grep 'service=checkout' deploys/deploys.log
```

Expected shape (SHAs elided here):

```
2026-11-13T00:40:12Z DEPLOY   service=checkout version=v2.14.0 commit=<sha7> author=dana.k status=success
2026-11-13T00:58:03Z DEPLOY   service=checkout version=v2.14.1 commit=<sha7> author=dana.k status=success
2026-11-13T01:39:51Z ROLLBACK service=checkout version=v2.14.0 commit=<sha7> author=amir.t status=success reason="checkout 5xx, INC-2291"
```

The version running at 01:13:14Z is **v2.14.1**, deployed at **00:58:03Z** by `dana.k`. The app log
agrees: every `checkout.start` around the onset carries `"version":"v2.14.1"`.

Cross-check against the repository (never trust a single source):

```bash
git clone repo/shipfast-checkout.bundle shipfast-checkout   # or just read repo/git-log.txt
cd shipfast-checkout
git tag                                      # v2.12.0 … v2.14.0 v2.14.1
git rev-parse --short=7 'v2.14.1^{commit}'   # the answer
git log --oneline -1 v2.14.1                 # feat(checkout): sanitize gift messages …
```

**Expected output.** A 7-character hex SHA that matches the `commit=` field of the 00:58:03Z line.
The exact value comes from the generated repo; the current build gives
**`df874c4`** (and the decoy v2.14.0 is `2ff7f28`). Both `deploys.log` and `git rev-parse` agree.

**In the browser / PowerShell.**
- *Explorer:* `deploys/deploys.log`, filter **contains** `service=checkout`; the last DEPLOY before 01:13:14Z
  is v2.14.1. Then `repo/git-log.txt`, filter **contains** `tag: v2.14.1`, **First match** shows the commit.
- *PowerShell (no git):*
  ```powershell
  Select-String -Path deploys\deploys.log -Pattern 'service=checkout'
  Select-String -Path repo\git-log.txt -Pattern '^commit (\w{7}).*tag: v2\.14\.1\b' | ForEach-Object { $_.Matches[0].Groups[1].Value }
  ```

**Traps.**
- **The decoy v2.14.0.** It shipped at 00:40:12Z (`chore: upgrade logger, add duration_ms field`) and
  it *is* the most recent "interesting" deploy if you only skim. But v2.14.1 replaced it at 00:58:03Z,
  15 minutes before the first error. And v2.14.0 is what the rollback went *back to*, and that fixed it.
- **The payments deploy** at 01:20:31Z is a different service and comes *after* the break.
- **`^{commit}`.** The tags in this repo are lightweight, so plain `git rev-parse` works, but if tags
  were annotated, `git rev-parse v2.14.1` returns the *tag object* SHA, not the
  commit. Peel it with `^{commit}` (or use `git rev-list -n1 v2.14.1`).

---

## q3: Which order started but never finished? (the poison order)

**Reasoning.** q1 told you the first error was a 30 s timeout, so the request that caused it arrived
around **01:12:44Z**, which is **03:12:44** in the app log's local time. A request that blocks the event
loop logs `checkout.start` and never logs `checkout.done`. So: list orders with a start and no done,
then look at the ones that started at the onset.

```bash
# orders that started but never finished, with their (local) start time
jq -r 'select(.msg=="checkout.start") | [.ts, .order, .customer, .pod, (.gift_message_len // "-")] | @tsv' \
  app/checkout-service.log > starts.tsv
jq -r 'select(.msg=="checkout.done") | .order' app/checkout-service.log | sort -u > done.txt
awk -F'\t' 'NR==FNR{d[$1]=1; next} !($2 in d)' done.txt starts.tsv
```

Then narrow to the onset. 01:12:44Z is 03:12:44+02:00:

```bash
awk -F'\t' 'NR==FNR{d[$1]=1; next} !($2 in d)' done.txt starts.tsv | grep 'T03:1[23]:'
```

Converting in jq instead of in your head (what `solve.sh` does):

```bash
jq -r 'select(.msg=="checkout.start")
       | ((.ts[0:19] + "Z" | fromdateiso8601) - 7200 | todate) + "  " + .order' app/checkout-service.log
```

**Expected output.** The earliest unfinished order at the onset is **`ORD-7Q4K9X`** (customer
`cus_4417`, `gift_message_len` 99, pod on `v2.14.1`), starting at `03:12:44.118+02:00`. Right after it,
the same pod logs `eventloop.lag` warnings with growing `lag_ms` and nothing else, then
`server.shutdown` / `server.start` (liveness probe kill). The request `rid` matches the 504 line in
nginx, if you want to prove the link.

**Answer: `ORD-7Q4K9X`**

**In the browser / PowerShell.**
- *Explorer:* **time converter** 01:12:44Z -> 03:12:44+02:00. `app/checkout-service.log`, **JSON field filter**
  `msg = checkout.start`, look around `T03:12`; then filter **contains** the candidate order: no
  `checkout.done` appears.
- *PowerShell:*
  ```powershell
  $done = @{}
  Select-String -Path app\checkout-service.log -Pattern '"msg":"checkout.done"' |
    ForEach-Object { $done[($_.Line | ConvertFrom-Json).order] = 1 }
  Select-String -Path app\checkout-service.log -Pattern '"msg":"checkout.start"' |
    ForEach-Object { $_.Line | ConvertFrom-Json } | Where-Object { -not $done.ContainsKey($_.order) } |
    Select-Object -First 1 ts, order, customer, pod
  ```

**Traps.**
- **Timezone.** Searching the app log for `01:12` finds nothing useful (it's local time).
- **Gift messages alone are not the tell.** Some normal orders have `gift_message_len` too, and they
  finish fine. What's unique is *start without done*, at the onset, followed by a frozen pod.
- **Group by order, not by line.** In this build `ORD-7Q4K9X` is the only order in the whole log that
  never reaches `checkout.done`, but it has 9 unfinished starts. Still check the time: its first start
  (03:12:44.118 local = 01:12:44Z) is exactly 30 s before the first 504, which is what proves it caused
  the outage rather than just suffering from it.

---

## q4: What function contains the dangerous code?

**Reasoning.** The bad release is v2.14.1. Diff it against the previous tag to see exactly what
changed:

```bash
cd shipfast-checkout
git log --oneline v2.14.0..v2.14.1
git diff --stat v2.14.0 v2.14.1
git show v2.14.1 -- src/            # or: git diff v2.14.0 v2.14.1
```

**Expected output.** Two commits: a README docs commit, and
`feat(checkout): sanitize gift messages before printing on packing slip` (the tagged commit), adding
`src/validators/giftMessage.ts`, wiring it into `src/routes/checkout.ts`, and adding a unit test.
In the new file:

```ts
// only allow words and single spaces — keeps the label printer happy
const GIFT_MESSAGE_RE = /^(\w+\s?)*$/;
…
export function sanitizeGiftMessage(msg: string): string {
  …GIFT_MESSAGE_RE.test(…)…
```

`(\w+\s?)*` is a quantified group whose contents are themselves quantified: a **nested quantifier**.
On a long input that ultimately fails to match (the poison message ends in `!!!`), the backtracking
engine tries an exponential number of ways to split the words before giving up. Node runs it on the
single event-loop thread, so the whole pod stops responding.

To hunt for that shape mechanically:

```bash
git grep -nE '\([^()]*[+*][^()]*\)[*+]' v2.14.1 -- src/
# v2.14.1:src/validators/giftMessage.ts:4:const GIFT_MESSAGE_RE = /^(\w+\s?)*$/;
```

The regex is a module-level constant; the function that *uses* it (and that the checkout route calls)
is the one exported from the same file.

**Answer: `sanitizeGiftMessage`**

**In the browser / PowerShell.**
- *Explorer:* `repo/git-log.txt`, filter **contains** `tag: v2.14.1` and use **First match**, or filter **regex**
  `^\+.*(function|/\^)` to see only added functions and regexes; `giftMessage.ts` stands out.
- *PowerShell:*
  ```powershell
  Select-String -Path repo\git-log.txt -Pattern '^\+\+\+ b/|^\+.*(function |RegExp|= /\^)' |
    Select-Object -First 20 LineNumber, Line
  ```

**Traps.**
- **The test passes.** `test/giftMessage.test.ts` only checks short strings, which match in microseconds.
  A green test suite is not evidence the regex is safe.
- **Answer the function, not the constant or file.** The flag is the function name
  (`sanitizeGiftMessage`), not `GIFT_MESSAGE_RE` or `giftMessage.ts`.
- **Don't diff the decoy.** `git show v2.14.0` is a logger upgrade; nothing dangerous there.

---

## q5: How many times in total was the poison order submitted?

**Reasoning.** Each submission (the original click, the frontend's auto-retries, and the customer
clicking "Pay" again) logs a new `checkout.start` with a new `rid`.

```bash
grep -c '"order":"ORD-7Q4K9X"' app/checkout-service.log        # 9: only checkout.start lines carry it
jq -r 'select(.msg=="checkout.start" and .order=="ORD-7Q4K9X") | .ts + "  " + .pod' app/checkout-service.log
jq -r 'select(.msg=="checkout.start" and .order=="ORD-7Q4K9X")' -c app/checkout-service.log | wc -l
```

**Expected output.** Nine `checkout.start` lines, from `03:12:44` to `03:38:10` local
(01:12:44Z to 01:38:10Z), spread over the pods (round-robin), each followed by a freeze and a restart.

**Answer: `9`**

**In the browser / PowerShell.**
- *Explorer:* `app/checkout-service.log`, **JSON field filter** `order = ORD-7Q4K9X` plus `msg = checkout.start`;
  the match count is 9.
- *PowerShell:*
  ```powershell
  (Select-String -Path app\checkout-service.log -Pattern '"msg":"checkout.start".*"order":"ORD-7Q4K9X"').Count
  ```

**Traps.**
- **8 vs. 9.** Slack and the retry logic talk about "8 retries". The question asks for total
  *submissions*: 1 original + 8 retries = **9**.
- **Count starts, not lines.** If a `grep -c` on the order ID gives you more than 9, you're also
  counting other message types that mention the order. Count `checkout.start` only.
- **Don't count nginx lines.** Requests to nginx include the 504/502 for each attempt, but nginx has no
  order ID, and many other customers' requests fail at the same time.

---

## q6: How many unique real customers got at least one 5xx on `POST /api/checkout`?

**Reasoning.** "Customers", not "requests": count distinct `cid` values. Exclude anonymous (`cid=-`)
and the synthetic monitor (`cid=cus_synthetic`, UA `Shipfast-Synthetic/1.0`, every 30 s), which is
not a real customer.

```bash
awk -F'"' '{split($3,s," ")} $2 ~ /^POST \/api\/checkout / && s[1] ~ /^5/ {
             match($NF, /cid=[^ ]+/); print substr($NF, RSTART+4, RLENGTH-4) }' nginx/access.log \
  | grep -vxE -- '-|cus_synthetic' | sort -u | wc -l
```

**Expected output.** A single number.  Dropping `sort -u` gives you the number of failed *requests*, which is
much larger (retries and the poison customer's repeats count many times).

**In the browser / PowerShell.**
- *Explorer:* `nginx/access.log`, **regex** `"POST /api/checkout [^"]*" 5\d\d `, **NOT** `cid=-`, **NOT**
  `cid=cus_synthetic`, then **Count unique** with `cid=(\S+)`.
- *PowerShell:*
  ```powershell
  (Select-String -Path nginx\access.log -Pattern '"POST /api/checkout [^"]*" 5\d\d .*cid=(\S+)$' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } |
    Where-Object { $_ -ne '-' -and $_ -ne 'cus_synthetic' } | Sort-Object -Unique | Measure-Object).Count
  ```

**Traps.**
- **Requests vs. customers.** `wc -l` without `sort -u` counts failed requests.
- **Synthetic monitor.** `cus_synthetic` fails on every probe during the incident. It's a robot.
- **Anonymous `-`.** Not a customer id.
- **Only `POST /api/checkout`.** `/api/cart` and `/api/cart/items` also fail; they're out of scope.
  And don't match `/api/checkout` as a substring of something else.
- **The UA has spaces.** If you parse with `awk '{print $9}'` and a UA contains a stray quote or
  field shift, you'll miscount. Split on `"`.

---

## The red herrings, in one place

| Suspect | Why it looks guilty | Why it's innocent |
|---|---|---|
| **v2.14.0** (00:40:12Z) | Recent deploy by the same dev | Errors start 32+ min later; v2.14.1 replaced it at 00:58:03Z; rolling *back to* v2.14.0 fixed it |
| **DB backup** (pg_dump 01:05:00 → 01:22:40Z) | Slow queries, Slack blames "the backup again" | Slow queries start 8 min *before* the errors; the backup has run nightly for 2 years; during 01:13–01:40 DB query volume *drops* (traffic never reaches the DB); errors continue 17 min after the backup ends |
| **payments v5.2.0** (01:20:31Z) | A deploy during the incident | Different service; deployed 7 minutes *after* the first 5xx |
| **CPU at 100%** | "Must be load" | One pod pinned while rps is normal: a single request burning CPU, not traffic. Combined with `eventloop.lag` in the thousands of ms, that's a blocked event loop |

## Bonus: why did it keep going after the first request?

The poison request froze one pod. The frontend auto-retried the failed checkout and the customer
clicked "Pay" again, so the same message kept arriving (9 times). Round-robin spread it over all three
pods. Liveness probes killed frozen pods, which restarted healthy and got poisoned again on the next
attempt. Every other request routed to a frozen pod got a 502/504.

Fixes, in order of how much they help: never run a backtracking regex on user input (use a linear
pattern such as `/^[\w\s]*$/`, or RE2); cap input length; set server-side request timeouts; move CPU work
off the event loop (worker threads); make retries idempotent and back off; add a fuzz/long-input test.

## The story in one paragraph

At 00:58:03 UTC (02:58 local), Shipfast shipped checkout **v2.14.1**, which "sanitized" gift messages
with `sanitizeGiftMessage()` and the regex `/^(\w+\s?)*$/`, a textbook catastrophic-backtracking
pattern that passed its short-string unit test. At 01:12:44 UTC, customer `cus_4417` placed order
**ORD-7Q4K9X** with a 99-character birthday message ending in `!!!`. The regex spun, Node's single event
loop blocked, and 30 seconds later nginx gave up and logged the first **504 at 01:13:14 UTC**. The
frontend's retries and an impatient customer submitted that order **9 times**, and each submission froze
whichever pod it landed on; liveness restarts just put fresh pods in line for the next attempt. For 27
minutes, most checkout and cart requests failed while the team chased the nightly DB backup (innocent:
it started earlier, ran every night, and the DB was actually *less* busy) and the earlier v2.14.0 deploy
(also innocent). At 01:39:51 UTC, on-call `amir.t` rolled back to v2.14.0 and it all recovered by about
01:40:25. The real lesson: one string from one customer took down checkout because untrusted input met a
backtracking regex on a single-threaded runtime, and the retries made it worse.
