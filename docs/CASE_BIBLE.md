# CASE BIBLE — "The 3 AM Outage" (case id: `3am-outage`)

> ⚠️ SPOILERS. Instructor/builder reference only. Never ship this file to players.
> This file is the single contract between the generator, the site, the solver and the docs.

Audience: working engineers (colleagues). Language: English. Target time: 10 min orientation + 40 min solve. Questions must be solvable in that budget with the toolbox; hints are generous.

## 1. The true story

**Shipfast** (fictional e-commerce company) runs a Node.js `checkout` service: 3 pods on Kubernetes behind nginx.
Local office timezone: **Asia/Jerusalem = UTC+02:00** in November. Incident date: **Friday 2026-11-13**.

At 00:58:03 UTC, release **v2.14.1** shipped a new feature: gift messages are "sanitized" before they're
printed on the packing slip. `sanitizeGiftMessage()` in `src/validators/giftMessage.ts` validates input with

```ts
const GIFT_MESSAGE_RE = /^(\w+\s?)*$/;
```

Nested quantifiers mean **catastrophic backtracking**. Any long message that ends in a char that's neither a
word char nor whitespace (e.g. `!!!`) takes exponential time. Node is single-threaded, so the **event loop
blocks** and the pod stops answering everything, including its liveness probe.

At **01:12:44 UTC**, customer `cus_4417` submits order **`ORD-7Q4K9X`** with the gift message:
`Happy 30th birthday Noa Love you to the moon and back you are the best sister in the whole world!!!`

The pod blocks. nginx `proxy_read_timeout 30s` means the poison request's 504 is logged at **01:13:14 UTC**.
That is the **first 5xx** of the incident. The frontend auto-retries failed checkouts, and the customer
also clicks "Pay" again, so the **same order is submitted 9 times in total** (1 + 8 retries) between
01:12:44 and 01:38:10. Each submission lands on a pod (round-robin) and freezes it. Liveness probes kill and
restart frozen pods, which come back and get poisoned again. During the incident, roughly 55–80% of
`POST /api/checkout` and `/api/cart*` requests fail with 502/504.

**Red herrings** (make them convincing):
1. **v2.14.0** was deployed at **00:40:12 UTC**: `chore: upgrade logger, add duration_ms field`. It's harmless.
   Recency bias says it's the cause. It isn't: errors start 32+ min later.
2. The nightly **DB backup (pg_dump)** runs **01:05:00 → 01:22:40 UTC**. The slow-query log shows slow queries
   starting at 01:05. Someone in Slack blames "the backup again". Clues that the DB is innocent:
   - slow queries start 7+ min BEFORE the errors;
   - DB query volume DROPS during the outage (traffic never reaches the DB);
   - backups ran every night that week without incidents (the slow log contains only this night, but Slack
     mentions "backup has run nightly for 2 years").
3. A `payments` service deploy at 01:20:31 UTC (unrelated, in deploys.log).

**Resolution:** on-call `amir.t` rolls back checkout to v2.14.0 at **01:39:51 UTC**. The last 5xx is at
about 01:40:2x UTC. After that, everything is healthy.

## 2. Timeline (UTC) — canonical constants live in `generator/timeline.py`

| UTC | Local (+02:00) | Event |
|---|---|---|
| 00:00:00 | 02:00:00 | log window starts |
| 00:40:12 | 02:40:12 | deploy checkout v2.14.0 (decoy) |
| 00:58:03 | 02:58:03 | deploy checkout v2.14.1 (THE BAD ONE), author dana.k |
| 01:05:00 | 03:05:00 | pg_dump nightly backup starts (red herring) |
| 01:12:44 | 03:12:44 | poison request ORD-7Q4K9X attempt #1 (cus_4417) |
| 01:13:14 | 03:13:14 | FIRST 5xx in nginx (504 for the poison request) |
| 01:15:30 | 03:15:30 | PagerDuty-style alert fires; Slack incident channel starts ~01:16 |
| 01:20:31 | 03:20:31 | deploy payments v5.2.0 (unrelated noise) |
| 01:22:40 | 03:22:40 | pg_dump ends |
| 01:38:10 | 03:38:10 | poison attempt #9 (last) |
| 01:39:51 | 03:39:51 | ROLLBACK checkout → v2.14.0 by amir.t |
| ~01:40:25 | ~03:40:25 | last 5xx |
| 02:30:00 | 04:30:00 | log window ends |

Poison attempt times (UTC) are fixed in `timeline.py` as `POISON_ATTEMPTS`.

## 3. Questions & answers (the flags)

Normalization before hashing: `trim`, `lowercase`, collapse internal whitespace to one space.
Flag check: `sha256_hex(salt + normalized_answer) == hash`.

| id | Question (player-facing gist) | Answer | Source of truth | Points |
|---|---|---|---|---|
| q1 | Timestamp (UTC, `HH:MM:SS`) of the first HTTP 5xx in the nginx access log | `01:13:14` | timeline | 100 |
| q2 | Short (7-char) git SHA of the commit that was deployed when it broke | from `build/truth/repo.json` → `bad_commit_sha7` | repo builder | 100 |
| q3 | The order ID whose request started but never finished: the "poison" order | `ORD-7Q4K9X` | timeline | 100 |
| q4 | Name of the function containing the dangerous code | `sanitizeGiftMessage` | repo | 100 |
| q5 | How many times in total was the poison order submitted? | `9` | timeline | 100 |
| q6 | How many unique real customers got ≥1 5xx on `POST /api/checkout`? (exclude `cus_synthetic` and `-`) | from `build/truth/logs.json` → `q6_unique_customers` | log generator | 150 |

Bonus discussion (no flag): why did the outage persist after the first request? (retries + liveness
restarts re-poisoning pods). How to fix? (linear regex / RE2 / input length cap / timeouts / worker threads).

## 4. Evidence pack (what players download) — `build/evidence/3am-outage/`

```
README_FIRST.txt                 briefing + file list + timezone warning (subtle, not a giveaway)
nginx/access.log                 UTC, custom format (below)
nginx/nginx.conf.snippet         the log_format + proxy timeouts (so players can read the format)
app/checkout-service.log         JSON lines, LOCAL time (+02:00)
metrics/checkout_metrics.csv     unix epoch seconds, 15s resolution
db/postgresql-slow.log           UTC, postgres format
deploys/deploys.log              UTC ISO-8601 Z
slack/inc-checkout.json          Slack-like export, epoch-string ts
repo/shipfast-checkout.bundle    git bundle of the service repo (clone with: git clone shipfast-checkout.bundle)
```

### 4.1 nginx/access.log
Time is the request END time (true nginx behaviour), in UTC. Format:
```
$remote_addr - - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" rt=$request_time urt=$upstream_response_time rid=$request_id cid=$http_x_customer_id
```
Example:
```
203.0.113.57 - - [13/Nov/2026:01:13:14 +0000] "POST /api/checkout HTTP/1.1" 504 167 "https://shipfast.example/cart" "Mozilla/5.0 (...)" rt=30.001 urt=30.000 rid=7f3c9a1e2b4d4c0f9e8a6b5c4d3e2f1a cid=cus_4417
```
- Window 00:00:00–02:30:00 UTC, ~10–14 req/s average with a gentle diurnal curve: about 100k–130k lines.
- Endpoints: `GET /`, `GET /products/<slug>`, `GET /static/...`, `GET /api/cart`, `POST /api/cart/items`,
  `POST /api/checkout`, `GET /healthz` (kube-probe UA, from 10.42.x.x, cid=-), and a synthetic monitor
  `POST /api/checkout` every 30s with `cid=cus_synthetic`, UA `Shipfast-Synthetic/1.0`.
- `cid=-` for anonymous requests.
- Only checkout-service routes (`/api/cart*`, `/api/checkout`) fail during the incident (502 or 504; 504s have
  rt≈30.0). Static/products are fine. Sprinkle normal background noise: a few 404s all night, a rare 500 on
  `/products/...` before the incident (noise; q1 asks for the first 5xx, so the generator must make sure NO
  5xx of any kind appears before 01:13:14).
- `rid` (32 hex) is shared with the app log for checkout-service requests → correlation.
- Customer ids `cus_1000`–`cus_9999`; retries of the same customer show up as repeated cid.

### 4.2 app/checkout-service.log (JSON lines, local time!)
```json
{"ts":"2026-11-13T03:12:44.118+02:00","level":"info","svc":"checkout","pod":"checkout-6b7f9c-x2kq4","version":"v2.14.1","rid":"<32hex>","msg":"checkout.start","order":"ORD-7Q4K9X","customer":"cus_4417","items":3,"gift_message_len":99}
{"ts":"...","level":"info",...,"msg":"checkout.done","order":"ORD-...","duration_ms":212,"status":"paid"}
```
- Messages: `server.start` (with version), `checkout.start`, `checkout.done`, `cart.get`, `cart.add`,
  `eventloop.lag` (warn, `lag_ms`), `healthz.slow` (warn), `server.shutdown` (`signal":"SIGTERM"`), etc.
- `version` field changes v2.13.4 → v2.14.0 at 00:40:12Z → v2.14.1 at 00:58:03Z → v2.14.0 at 01:39:51Z (pods
  roll over a few seconds).
- Poison: each attempt logs `checkout.start` (order ORD-7Q4K9X, `gift_message_len` 99) and NEVER logs
  `checkout.done`. Then `eventloop.lag` warnings follow (lag grows), then `server.shutdown`/`server.start`
  on that pod ~20–40s later. During a freeze, that pod logs nothing else.
- Other orders that have gift messages do finish fine (short or no trailing punctuation): `gift_message_len`
  is present on some normal orders too, so length alone isn't the giveaway.
- Each attempt of the poison order uses a new rid. Exactly 9 `checkout.start` lines with ORD-7Q4K9X.

### 4.3 metrics/checkout_metrics.csv
`ts_epoch,pods_ready,cpu_pct_max,eventloop_lag_p99_ms,http_p99_ms,rps,error_rate,restarts_total`
15s rows over the window. Flat and healthy until 01:12:44, then CPU 100 on a pod, lag in the thousands, p99 →
30000, error_rate 0.5–0.85, pods_ready dipping to 0–2, restarts climbing. Back to normal after 01:40.

### 4.4 db/postgresql-slow.log
`2026-11-13 01:05:22.123 UTC [4412] LOG:  duration: 2311.882 ms  statement: SELECT ...`
Also `connection authorized: user=backup database=shipfast application_name=pg_dump` at 01:05:00, and
`COPY public.orders ... TO stdout` lines. Normal slow queries (>500ms) are sparse before; a cluster during the
backup; NO checkout-related queries during 01:13–01:40 (a gap). Include a few `checkpoint` lines.

### 4.5 deploys/deploys.log
```
2026-11-13T00:40:12Z DEPLOY   service=checkout version=v2.14.0 commit=<sha7> author=dana.k   status=success
2026-11-13T00:58:03Z DEPLOY   service=checkout version=v2.14.1 commit=<sha7> author=dana.k   status=success
2026-11-13T01:20:31Z DEPLOY   service=payments version=v5.2.0  commit=9e1c0d2 author=lior.m  status=success
2026-11-13T01:39:51Z ROLLBACK service=checkout version=v2.14.0 commit=<sha7> author=amir.t   status=success reason="checkout 5xx, INC-2291"
```
Plus earlier days' deploys (2026-11-10..12) for checkout/search/payments/web as noise. The checkout SHAs come
from `build/truth/repo.json`.

### 4.6 slack/inc-checkout.json
An array of `{"ts":"1794540990.000100","user":"amir.t","text":"..."}` (ts = epoch seconds as a string, like
Slack). Channel starts ~01:16Z with the alert bot. People: `amir.t` (on-call SRE), `dana.k` (dev who shipped),
`lior.m` (payments), `noa.s` (eng manager), `pagerbot`. They contain: blaming the DB backup (red herring),
someone says "graphs show CPU pinned but DB CPU is low…", someone pastes a stack-less "eventloop.lag" line, and
the rollback decision. Nobody states the root cause explicitly. The last messages say "rolled back, recovered,
RCA due Monday". It's a hint source, not an answer key.

### 4.7 repo/shipfast-checkout (git)
TypeScript Node service. ~45–70 commits from 2026-08-01 to 2026-11-12 with fixed author/committer dates (so
SHAs are deterministic). Authors: dana.k, amir.t, yossi.b, maya.r (emails `@shipfast.example`). Tags
v2.12.0 … v2.13.4, v2.14.0, v2.14.1.
- v2.14.0 commit: `chore: upgrade logger, add duration_ms field` (harmless).
- v2.14.1 commit: `feat(checkout): sanitize gift messages before printing on packing slip` adds
  `src/validators/giftMessage.ts` with `sanitizeGiftMessage` + the regex, wired into `src/routes/checkout.ts`,
  plus a unit test that only tests short strings (and passes!).
- Some realistic noise commits, a README, package.json, tsconfig.

## 5. Build pipeline (deterministic, seed = 20261113)
```
python3 generator/build_repo.py      -> build/repo/shipfast-checkout (repo), build/evidence/3am-outage/repo/shipfast-checkout.bundle, build/truth/repo.json
python3 generator/gen_logs.py        -> nginx/access.log, nginx/nginx.conf.snippet, app/checkout-service.log, build/truth/logs.json
python3 generator/gen_support.py     -> metrics, db, deploys (reads build/truth/repo.json), slack, README_FIRST.txt
python3 scripts/make_flags.py        -> site/server/generated/secrets.json (server-only answer key + debrief), build/truth/answers.json
scripts/package.sh                   -> repo/git-log.txt, site/public/evidence/3am-outage-evidence.zip, site/public/evidence/files/ (Explorer)
cd site && npm run build             -> site/dist (Netlify publish dir)
```
All generators: Python 3 stdlib only, `random.Random(SEED)`, import constants from `generator/timeline.py`,
output root `build/evidence/3am-outage/`, and run from the repo root.

## 6. Site contract
- `site/src/content/cases/3am-outage.json`: case content (schema in `site/src/content/schema.ts`). It contains NO answers.
- `site/src/content/teasers.json`: the 4 "coming soon" cases.
- `site/server/generated/secrets.json`: `{"caseId","answers":{qN: normalized},"debrief"}`, bundled into the Netlify Function only (gitignored).
- Evidence zip served from `/evidence/3am-outage-evidence.zip`.
