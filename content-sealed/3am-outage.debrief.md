## What actually happened

**Release v2.14.1** shipped a small, innocent-looking feature: gift messages are sanitized before being printed on the packing slip. The validator in `src/validators/giftMessage.ts` used:

```ts
const GIFT_MESSAGE_RE = /^(\w+\s?)*$/;
```

That's a **nested quantifier**: a group containing `\w+` that is itself repeated with `*`. For a message made of words that **ends with a character the pattern can't match** (like `!!!`), V8's backtracking engine tries every possible way to split the words into groups before giving up. That's exponential in the input length. A 99-character birthday message will never finish.

Node.js runs your JavaScript on a **single thread**. While `regex.test()` spins, the event loop is blocked: no other requests, no timers, no `/healthz`. The pod is alive but deaf.

## Timeline

| UTC | Local (UTC+2) | Event |
|---|---|---|
| 00:40:12 | 02:40:12 | Deploy checkout **v2.14.0** (logger upgrade, harmless) |
| 00:58:03 | 02:58:03 | Deploy checkout **v2.14.1** (gift-message sanitizer, the bug) |
| 01:05:00 | 03:05:00 | Nightly `pg_dump` backup starts, slow queries appear |
| 01:12:44 | 03:12:44 | `ORD-7Q4K9X` (cus_4417) submitted with a 99-char gift message ending in `!!!`. Pod freezes |
| 01:13:14 | 03:13:14 | nginx gives up after `proxy_read_timeout 30s`: **first 5xx (504)** |
| 01:13–01:38 | 03:13–03:38 | Frontend auto-retries + customer re-clicks: **9 submissions total**, each freezing a pod |
| 01:15:30 | 03:15:30 | Alert fires, incident channel opens |
| 01:20:31 | 03:20:31 | `payments` v5.2.0 deploy (unrelated) |
| 01:22:40 | 03:22:40 | `pg_dump` ends. Errors continue regardless |
| 01:38:10 | 03:38:10 | Last poison submission |
| 01:39:51 | 03:39:51 | **Rollback** to v2.14.0 by amir.t |
| ~01:40:25 | ~03:40:25 | Last 5xx. Full recovery |

## Why the unit test passed

The test in the commit checked a handful of **short** strings, valid and invalid. Catastrophic backtracking is invisible on short inputs: 10 characters take microseconds, 25 take a fraction of a second, and only around 30+ does it explode. The test covered *correctness* and never touched *performance on hostile or long input*. Green CI, red production.

## Why it kept going

One frozen pod should have been a blip. Instead:

- **Retries:** the frontend retried failed checkouts automatically, and the customer clicked "Pay" again. Same payload, every time.
- **Round-robin:** each retry landed on a *different* pod, so the poison spread across the fleet.
- **Liveness probes:** Kubernetes saw the frozen pod failing `/healthz` and restarted it. The fresh pod came back healthy… and caught the next retry.
- **Single-threaded event loop:** one stuck request took down *all* traffic on that pod, including carts and health checks, not just that one checkout.

With 3 pods and a steady trickle of retries, there was rarely a moment when the whole fleet was healthy, until the code itself was rolled back.

## Why the red herrings were wrong

- **v2.14.0 (the decoy):** It went out at 00:40, more than 30 minutes before the first error, and only touched logging. Pods ran it happily, and rolling back *to* it fixed everything.
- **The DB backup:** slow queries began at 01:05, **8 minutes before** any error. During the outage DB query volume actually **dropped**, because requests never got past the frozen Node process to reach Postgres. The backup has run every night for two years. DB CPU was low while app CPU was pinned.
- **The payments deploy (01:20:31)** landed 7 minutes *into* the incident, on a different service, and changed nothing about checkout's symptoms.

## Fixes

**Immediate**
- Replace the regex with a linear-time equivalent, e.g. `/^[\w\s]*$/` (one character class, one quantifier: no ambiguity, no backtracking explosion).
- Cap input length **before** validation (gift messages > 200 chars are rejected outright).

**Structural**
- Use a linear-time regex engine for user input: **RE2** (`re2` npm package), which guarantees no catastrophic backtracking. Note that JavaScript has no atomic groups or possessive quantifiers (`(?>...)`, `*+`), the usual fix in PCRE and Java.
- Lint for dangerous regexes in CI (e.g. `eslint-plugin-regexp`, `safe-regex`/`recheck`).
- Keep CPU-heavy or untrusted-input work **off the event loop**: worker threads with a hard timeout.
- Retries with **exponential backoff, jitter and a cap**, plus idempotency keys on checkout, so one bad request can't fan out.
- **Canary deploys** with automatic rollback on error-rate or event-loop-lag regression.
- **Alert on event-loop lag** and request duration p99, not just 5xx counts. Lag was screaming before customers noticed.

## The real incident: Cloudflare, July 2, 2019

On 2 July 2019, Cloudflare deployed a new WAF managed rule containing a regular expression that backtracked catastrophically (its core was `.*(?:.*=.*)`). It was rolled out to every edge server at once, pinning CPUs worldwide and causing 502 errors for Cloudflare-proxied sites for about **27 minutes**, until a global kill switch disabled the WAF. Their fixes included moving to a linear-time regex engine and restoring staged rollouts for WAF rules.

Read their excellent post-mortem: **"Details of the Cloudflare outage on July 2, 2019"**, https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/

## Real-world takeaways

1. **Normalize time before you correlate.** Know which zone each source uses, and whether a timestamp marks the start or the end of an event.
2. **Recency is a hint, not a verdict.** Match each change's go-live time against symptom onset, and confirm it by reading the diff.
3. **Regex on user input is code execution.** Nested quantifiers + backtracking engine + untrusted input = a denial-of-service waiting to happen. Use linear-time engines and length caps.
4. **Self-healing can self-reinfect.** Retries, load balancers and liveness restarts amplify a poison request across the fleet. Design for backoff, idempotency and quarantining bad inputs.
5. **Measure what blocks, not just what fails.** In single-threaded runtimes, event-loop lag is the earliest and clearest signal. Alert on it, and canary everything that touches input handling.