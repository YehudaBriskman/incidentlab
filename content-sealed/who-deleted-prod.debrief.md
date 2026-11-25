## What actually happened

Nobody at Fernhill deleted prod. An outsider did, wearing our own role, and the only thing they ever "hacked" was a URL parameter.

The edge WAF, `edge-waf-01`, had a convenience route for the help-center editor: `/proxy/fetch?u=<url>` fetches any URL and returns it, implemented as `proxy_pass $arg_u`. That is a **server-side request forgery (SSRF)** waiting to happen: whatever the client asks for, the WAF fetches from *inside* our network. Someone had noticed, and rule `100231` blocked the string `169.254.169.254` in `u`. The attacker wrote the same address as a single decimal number, `http://2852039166/`, and the rule never saw it.

`169.254.169.254` is the **EC2 instance metadata service (IMDS)**. The WAF instance allowed **IMDSv1** (`HttpTokens: optional`), which answers plain GET requests, so `.../iam/security-credentials/fh-waf-edge-role` returned the role's temporary access key, secret and session token straight to the attacker's terminal.

From a different address (`203.0.113.140`), with `aws-cli`, the attacker used those keys. The role was meant to read WAF rules and ship logs, but its inline policy also had `s3:Get*`/`s3:List*` on `*` and a "temporary" `s3:Put*` on `*`. They listed every bucket, copied the WAF's own config, were stopped by KMS at the cardholder vault, and downloaded **286 customer export files (about 14.7 GB, ~100 million rows)**.

Then they tried to destroy the evidence and the data. `DeleteObject` and `DeleteBucket` hit an explicit deny. So they asked S3 to do it: a **lifecycle rule** expiring every object after one day. S3 obliged after midnight UTC, quietly, as `AmazonS3`.

## Timeline

| UTC | New York (EST) | Event |
|---|---|---|
| 17 Nov 22:27 to 22:38 | 17:27 to 17:38 | Yoni's approved staging cleanup (CHG-4471). Unrelated |
| 18 Nov 01:10 | 20:10 | Leaked, already deactivated dev key tried from the internet. Every call fails |
| 01:45 to 01:54 | 20:45 to 20:54 | Scanner sweep incl. metadata probes. All blocked |
| 03:19:52 | 22:19:52 | Attacker `203.0.113.77` arrives |
| 03:22:41 | 22:22:41 | Out-of-band test: the WAF fetches the attacker's own server on port 8000 |
| 03:24 | 22:24 | Literal `169.254.169.254` blocked twice (rule 100231) |
| 03:26:33 | 22:26:33 | `http://2852039166/latest/meta-data/` passes: first IMDS response |
| **03:27:19** | **22:27:19** | **Role credentials stolen** |
| 03:31:02 | 22:31:02 | Stolen key `ASIAEXAMPLEW7K2QZ4NB` first used from `203.0.113.140` |
| 03:38 to 04:53 | 22:38 to 23:53 | 286 export files downloaded (289 objects in total) |
| 04:01:30 | 23:01:30 | IMDS rotates the instance's key. The stolen one stays valid until it expires |
| 05:01 to 05:02 | 00:01 to 00:02 | DeleteObject, DeleteBucket on prod: AccessDenied (explicit deny) |
| **05:09:47** | **00:09:47** | **`PutBucketLifecycle`: rule `tmp-cleanup`, expire everything after 1 day** |
| 19 Nov 00:09 to 01:52 | 18 Nov 19:09 to 20:52 | S3 expires 253 objects (12 to 17 Nov exports) |
| 19 Nov ~07:00 EST | | Statements portal failures reach support |

## Why the evidence looked the way it did

- **IMDS traffic never appears in VPC flow logs.** Link-local metadata traffic isn't logged. The only trace of the theft is the WAF's own `upstream=169.254.169.254:80`.
- **CloudTrail can't say who, only where and how.** Every attacker call is signed `assumed-role/fh-waf-edge-role/i-0f3a9c2e7b5d14a86`, identical to the instance. What differs is `sourceIPAddress` and `userAgent`. The very same access key was in use from two places at once.
- **`ec2RoleDelivery: 1.0`** in CloudTrail marks credentials delivered by IMDSv1. The statements-api instances show `2.0`.
- **Lifecycle deletes are not API deletes.** Expirations show up in the S3 server access log as `S3.EXPIRE.OBJECT` by `AmazonS3`, with no IP, and never in CloudTrail. Grep CloudTrail for `Delete` and you find the innocent person.
- **`PutBucketLifecycle` is authorized as `s3:PutLifecycleConfiguration`.** API names and IAM action names differ, which is exactly how a delete-only deny list misses it, and how `s3:Put*` quietly grants it.

## Why the red herrings were wrong

- **Yoni (the insider).** His deletes and his lifecycle rule were on staging buckets, from his home IP, through SSO, matching an approved change ticket minute by minute. The prod rule was created eight hours later by a different principal from a different network.
- **Dana's leaked key.** It was deactivated the day before. Every attempt failed with `InvalidClientTokenId`. The GuardDuty finding was real and harmless.
- **AWS.** Lifecycle expiration is S3 doing exactly what it was told.
- **The scanners.** They tried the same trick with the literal address and were blocked. Loud is not the same as dangerous; the attacker made about a dozen precise requests.

## Fixes

**Immediate**
- Remove `/proxy/fetch` or put it behind an allowlist of destination hosts; resolve the name and reject private, loopback and link-local IPs **after** DNS.
- Enforce **IMDSv2** (`HttpTokens: required`) on every instance, and set it as the account default.
- Replace the WAF role's policy with exactly `s3:GetObject` on `fh-waf-config/*` and `s3:PutObject` on `fh-waf-logs/*`.
- Delete the `tmp-cleanup` rule, rebuild exports from the warehouse, and treat this as a **data breach** (notification, regulators), not just data loss.
- Remove the `suppress-waf-logshipper` suppression rule and review its archived findings.

**Structural**
- **Data perimeter:** conditions such as `aws:SourceVpce` / `aws:SourceIp` (and an SCP enforcing them) so stolen credentials are useless outside your network. The statements-api role already does this.
- **Protect what matters:** versioning plus **Object Lock** or MFA delete on critical buckets; deny bucket-configuration changes (`s3:PutLifecycleConfiguration`, `s3:PutBucketPolicy`, ...) not only deletes.
- **Detect:** alert on instance credentials used outside their instance (GuardDuty `InstanceCredentialExfiltration`), on `ec2RoleDelivery: 1.0`, and on any bucket lifecycle or policy change in prod.
- **Suppress narrowly:** suppression rules should match a finding type *and* a resource, have an owner and an expiry date.
- Bring hand-built infrastructure under code review. "Temporary" wildcards need a ticket and a date.

## The real incident: Capital One, 2019

In March 2019 an attacker used a misconfigured web application firewall at Capital One to send requests to the EC2 metadata service and obtain temporary credentials for the WAF's IAM role. That role could list and read a large number of S3 buckets, and she copied data on about **106 million** credit card customers and applicants in the US and Canada. The breach was found in July 2019 after a tip about data posted publicly, and the attacker was later convicted. Capital One paid an **80 million US dollar** penalty to the OCC. In November 2019 AWS released **IMDSv2**, whose session tokens defeat this exact class of SSRF.

Our case adds one twist that the real breach did not have: a destructive last step that hides behind an S3 feature instead of a delete call.

## Real-world takeaways

1. **An SSRF in front of IMDSv1 is a credential vending machine.** Enforce IMDSv2 everywhere, and never let a proxy fetch arbitrary URLs.
2. **Block destinations, not strings.** An IP address has many spellings; check the resolved address.
3. **Same identity, different place = stolen.** Baseline machine roles by source IP and user agent; one key used from two networks is the signal.
4. **Deny lists miss things.** Name what a role may do, on which resources, from where. A "temporary" wildcard is permanent until someone deletes it.
5. **Know what your logs can't see.** IMDS isn't in flow logs; lifecycle expirations aren't in CloudTrail. Collect the S3 server access logs and the proxy's upstream field before you need them.
