# CASE BIBLE: "Who Deleted Prod?" (case id: `who-deleted-prod`)

> SPOILERS. Instructor/builder reference only. Never ship this file to players.
> This file is the contract between the generator, the site JSON, the solver and the debrief.

Audience: working engineers. Target time: 10 min orientation + about 60 min solve. Difficulty: hard.
Inspired by the Capital One breach (2019): SSRF through a misconfigured WAF to the EC2 instance metadata
service (IMDSv1), stolen instance-role credentials, S3 exfiltration. The destructive last step is our addition.

## 1. The true story

**Fernhill Credit** (fictional consumer-credit company, AWS account `111122223333`, `us-east-1`, offices in
New York) runs an edge WAF, `edge-waf-01` (`i-0f3a9c2e7b5d14a86`, private `10.20.1.15`, EIP `198.51.100.20`):
nginx + ModSecurity, hand-built in 2023 and never brought under Terraform. Its instance profile carries
the role **`fh-waf-edge-role`**. Three things are wrong with it:

1. **SSRF.** The WAF exposes `/proxy/fetch?u=<url>` for link previews in the help-center editor, implemented as
   `proxy_pass $arg_u`. Any URL a stranger hands it gets fetched from inside the instance. A ModSecurity
   rule (`100231`) blocks the literal string `169.254.169.254` in `u`, and `100230` blocks it in the Host header.
2. **IMDSv1.** `MetadataOptions.HttpTokens = optional`. A plain GET to the metadata service returns the role's
   temporary credentials.
3. **Over-broad role.** The inline policy `fh-waf-edge-inline` has `s3:Get*`/`s3:List*` on `*`
   (`ReportingReadOnly`) and a "temporary" `s3:Put*` on `*` (**`TempLogMigration`**, from a 2024 log migration).
   A `DenyDeleteProd` statement denies `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:DeleteBucket` on `fh-prod-*`.

Detection was blind: a GuardDuty suppression rule `suppress-waf-logshipper` (2024) auto-archives every finding
whose `resource.accessKeyDetails.userName` is the WAF role, and the exported findings are active-only.

**The attack** (Tuesday night 17 Nov EST = early Wednesday 18 Nov UTC):

- From **`203.0.113.77`** the attacker browses the site, tests the proxy with `http://www.example.com/` and an
  out-of-band callback to `http://203.0.113.77:8000/c` (the flow log shows the WAF connecting **out** to it).
- `u=http://169.254.169.254/latest/meta-data/` and `u=http://[::ffff:169.254.169.254]/...` are blocked (403, rule 100231).
- `u=http://2852039166/latest/meta-data/` (the same address as one decimal number) passes: **first 200 from IMDS**,
  `upstream=169.254.169.254:80`.
- `.../iam/security-credentials/` returns the role name (16 bytes); **`.../security-credentials/fh-waf-edge-role`
  returns the credentials at 22:27:19 EST = 03:27:19 UTC**. Fetched again at 03:58:02 UTC (same key, not yet rotated).
- From **`203.0.113.140`** (a different IP) with `aws-cli/2.17.43`, using key **`ASIAEXAMPLEW7K2QZ4NB`** (the key
  IMDS served at 03:27:19; the instance keeps using the same key from its EIP until IMDS rotates at 04:01:30):
  `GetCallerIdentity`, `ListBuckets`, `GetBucketLocation` + `ListObjects` on all 8 buckets (terraform-state denied by
  bucket policy), copies 3 WAF config objects, tries 5 objects in `fh-prod-cardholder-vault` (KMS AccessDenied),
  then downloads **286 export objects** from `fh-prod-customer-exports` (9 downloaded twice, 3 NoSuchKey guesses),
  about 14.7 GB, 03:38 to 04:53 UTC.
- 05:01 to 05:02 UTC: `DeleteObject` ×2 and `DeleteBucket` on prod: **AccessDenied (explicit deny)**.
- 05:03 `GetBucketVersioning` (not enabled), 05:04 `GetBucketLifecycle` (none), then at **05:09:47 UTC
  `PutBucketLifecycle`** on `fh-prod-customer-exports`: rule `tmp-cleanup`, prefix `""`, `Expiration.Days = 1`.
  Allowed by `TempLogMigration` (`s3:Put*` covers `s3:PutLifecycleConfiguration`). Last call 05:13:55.
- 19 Nov 00:09 to 01:52 UTC: S3 expires **253** objects (export days 12 to 17 plus manifests). These appear only in
  the S3 server access log as `S3.EXPIRE.OBJECT`, requester `AmazonS3`, no IP. Nothing in CloudTrail.
  Day-18 objects survive (created 18 Nov 02:00, eligible only on 20 Nov 00:00). Day-19 batch writes normally.
- From 00:19 UTC statements-api reads return 404 NoSuchKey; support escalates at about 07:00 EST; the Slack
  channel runs 12:04 to 14:02 UTC on 19 Nov.

## 2. Timeline

| UTC | EST (-05:00) | Event | Source |
|---|---|---|---|
| 17 Nov 22:00 | 17:00 | evidence window starts | all |
| 22:05:41 | 17:05 | maya.k SSO console login (office) | CloudTrail |
| 22:27:09 to 22:38:12 | 17:27 to 17:38 | yoni.ops CHG-4471: lifecycle on staging, empties + deletes `fh-staging-exports-2023` | CloudTrail, ticket |
| 23:14:06 | 18:14 | scanner #2 `198.51.100.163`, 2 SSRF probes, blocked | WAF |
| 23:58:12 | 18:58 | IMDS rotates: key `...W7K2QZ4NB` issued | CloudTrail `creationDate` |
| 18 Nov 01:10:33 | 20:10 | leaked (inactive) key `AKIAEXAMPLEDANA0LD1Q` tried from `192.0.2.201`, `InvalidClientTokenId` | CloudTrail, GuardDuty |
| 01:45 to 01:54 | 20:45 to 20:54 | scanner #1 `192.0.2.44`: port probes + WAF sweep incl. IMDS probes, all blocked | flow, WAF, GuardDuty |
| 02:00 to 02:08 | 21:00 | nightly export batch writes day-18 exports | CloudTrail, S3 log |
| 03:19:52 | 22:19:52 | attacker `203.0.113.77` first request | WAF |
| 03:22:41 | 22:22:41 | out-of-band callback to `203.0.113.77:8000` | WAF, flow |
| 03:24:05, 03:24:48 | 22:24 | IMDS attempts blocked (rule 100231) | WAF |
| 03:26:33 | 22:26:33 | first IMDS 200 (decimal IP) | WAF |
| **03:27:19** | **22:27:19** | **credentials retrieved (q2)** | WAF |
| 03:31:02 | 22:31:02 | first API call from `203.0.113.140` with stolen key | CloudTrail |
| 03:35 to 03:37 | | WAF config copied; cardholder vault denied (KMS) | CloudTrail |
| 03:38 to 04:53 | | 286 export objects downloaded (289 objects total) | CloudTrail, S3 log |
| 03:58:02 | 22:58:02 | credentials fetched again | WAF |
| 04:01:30 | 23:01:30 | IMDS rotates: key `...M3R8T6C1J` (instance only) | CloudTrail |
| 05:01:12 to 05:02:40 | 00:01 to 00:02 | DeleteObject ×2, DeleteBucket: AccessDenied | CloudTrail, S3 log |
| **05:09:47** | 00:09:47 | **PutBucketLifecycle on prod (q5)** | CloudTrail, S3 log `REST.PUT.LIFECYCLE` |
| 05:13:55 | | last attacker call | CloudTrail |
| 08:00 | 03:00 | CloudTrail / WAF / flow window ends | |
| 19 Nov 00:09 to 01:52 | 18 Nov 19:09 to 20:52 | 253 `S3.EXPIRE.OBJECT` | S3 log |
| 19 Nov 12:04 to 14:02 | 07:04 to 09:02 | Slack #inc-prod-exports | Slack |

All times are constants in `generator/cases/who-deleted-prod/story.py`.

## 3. Questions and answers

Normalization: trim, lowercase, collapse whitespace. Answers live in `build/truth/who-deleted-prod.answers.json`.

| id | Question (gist) | Answer | Where it comes from | Pts |
|---|---|---|---|---|
| q1 | Client IP that got an HTTP 200 from IMDS through the WAF | `203.0.113.77` | `waf/access.log`: `upstream=169.254.169.254:80` + status 200. Grepping the URL for `169.254.169.254` only finds blocked probes (3 IPs); the successful requests use `http://2852039166/`. | 100 |
| q2 | UTC time of the first successful credential fetch | `03:27:19` | WAF line `[17/Nov/2026:22:27:19 -0500] ... security-credentials/fh-waf-edge-role` 200 1308. Traps: the listing call at 22:26:58 (16 bytes), the second fetch at 22:58:02, forgetting +5h / the date change. | 100 |
| q3 | Access key id used by someone other than the instance | `ASIAEXAMPLEW7K2QZ4NB` | CloudTrail: role `fh-waf-edge-role`, `sourceIPAddress` not in {`198.51.100.20`, `10.20.1.15`} (from `ec2/describe-instances.json` via the instance profile). The instance uses three rotated keys; only this one appears from `203.0.113.140` (`aws-cli`). | 100 |
| q4 | Distinct objects successfully downloaded with the stolen creds, all buckets | `289` (computed by build.py; 286 prod exports + 3 `fh-waf-config`) | CloudTrail `GetObject` without `errorCode` from `203.0.113.140`, deduped on bucket/key. Traps: counting calls (298), filtering on the key only (291, includes the instance's own config reads), counting only prod (286), counting errors. | 100 |
| q5 | CloudTrail eventName that actually destroyed prod's data | `PutBucketLifecycle` | S3 log 19 Nov: `S3.EXPIRE.OBJECT` by `AmazonS3`. CloudTrail: the attacker's Delete* failed (AccessDenied); the only successful non-read-only call on prod from `203.0.113.140` is `PutBucketLifecycle` (rule `tmp-cleanup`, 1 day). Yoni's `PutBucketLifecycle`/`DeleteBucket` were on staging buckets. | 100 |
| q6 | Sid of the statement that allowed the q5 call | `TempLogMigration` | `iam/roles/fh-waf-edge-role.json`. `PutBucketLifecycle` is authorized as `s3:PutLifecycleConfiguration`; only `s3:Put*` on `*` matches. `ShipWafLogs` is `s3:PutObject` only, `ReportingReadOnly` is Get/List, `DenyDeleteProd` doesn't list it. | 150 |

Hint costs 10/20/40 on every question.

## 4. Evidence pack (`build/evidence/who-deleted-prod/`)

| File | Format / clock | Notes |
|---|---|---|
| `README_FIRST.txt` | text | on-call POV, file list, clocks, glossary. No answers (build.py checks). |
| `waf/access.log` | nginx-style, **EST -0500**, ~21k lines | `$1` IP, `$4 $5` time, `$7` URI, `$9` status, then `"ref" "ua" host= upstream= rt= waf= rule= rid=` |
| `waf/edge-waf.conf` | nginx config | log_format, rules 100230/100231, `proxy_pass $arg_u` |
| `cloudtrail/111122223333_CloudTrail_us-east-1_2026111{7,8}.jsonl` | JSON lines, UTC | ~1.4k events: instance (3 keys), statements-api (IMDSv2, VPC endpoint), batch, SSO users, AWS Config, leaked key, attacker |
| `s3-access-logs/fh-prod-customer-exports/2026-11-1{8,9}.log` | S3 access log, UTC | consistent with CloudTrail for the overlap; expirations only here |
| `vpc-flow-logs/eni-0c7d1e2f3a4b5c6d7.log` | flow log v2, epoch, 10-min aggregation | inbound clients, REJECTed probes, outbound fetches incl. `203.0.113.77:8000`. No IMDS traffic (never logged). |
| `ec2/describe-instances.json` | JSON | WAF `HttpTokens: optional`; stmt-api `required` |
| `iam/roles/*.json` | JSON | WAF role (root cause) and stmt-api role (least privilege, `aws:SourceVpce` condition) |
| `iam/access-keys.csv` | CSV | dana.dev key Inactive since 16 Nov |
| `guardduty/findings.json` | JSON, UTC | active findings only: leaked-key MaliciousIPCaller, port probe |
| `guardduty/suppression-rules.json` | JSON | `suppress-waf-logshipper` |
| `slack/inc-prod-exports.json` | Slack export, epoch strings | theories |
| `tickets/CHG-4471.txt` | text, EST | Yoni's approved staging change |

## 5. Red herrings (and why they are wrong)

1. **The insider (yoni.ops).** CloudTrail on 17 Nov shows him running `PutBucketLifecycle`, `DeleteObject` ×6 and
   `DeleteBucket`. All on staging buckets (`fh-staging-customer-exports`, `fh-staging-exports-2023`), from his home
   IP via SSO, matching approved ticket CHG-4471 to the minute. His lifecycle rule is 30 days, prefix `exports/`.
2. **The leaked dev key.** `AKIAEXAMPLEDANA0LD1Q` was deactivated on 16 Nov (`iam/access-keys.csv`). Every use on the
   night fails with `InvalidClientTokenId`. GuardDuty's MaliciousIPCaller finding is real but harmless.
3. **AWS ate the data.** Expirations are lifecycle actions, triggered by a rule someone put there.
4. **Scanners.** `192.0.2.44` and `198.51.100.163` probed IMDS through the WAF too, but every attempt got 403.
   GuardDuty's port-probe finding is about them.
5. **"Someone debugging on the box."** No SSH, empty Session Manager history. The calls came from `203.0.113.140`,
   not the instance's EIP. The box wasn't owned; its credentials were lifted through its own proxy.

## 6. Build and verification

```
python3 generator/cases/who-deleted-prod/build.py      # wipes + writes build/evidence/who-deleted-prod, build/truth/who-deleted-prod.answers.json
bash solutions/who-deleted-prod/solve.sh                # derives all six from evidence, PASS/FAIL against truth
```
Stdlib only, `random.Random(20261118)`, byte-identical on rerun. build.py exits non-zero if: more than one IP got an
IMDS 200, the first credential fetch time moved, more than one key was used outside the instance (or it isn't the
key IMDS served at the theft), the instance didn't use all three keys, the CloudTrail and S3-log exfil sets disagree,
the attacker has any successful write on prod other than `PutBucketLifecycle`, the README leaks an answer, or a size
limit is exceeded.
