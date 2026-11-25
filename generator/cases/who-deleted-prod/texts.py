"""Static evidence text for case `who-deleted-prod`: configs, IAM, EC2, GuardDuty, Slack, ticket, README.

SPOILERS: docs/cases/who-deleted-prod.md. Nothing in README() may contain an answer (build.py checks).
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import ModuleType

UTC = timezone.utc

# ----------------------------------------------------------------------------------------------
WAF_CONF = """\
# edge-waf-01 : /etc/nginx/conf.d/edge-waf.conf   (exported 2026-11-19 by maya.k)
# nginx 1.26 + ModSecurity v3 connector. Terminates TLS for edge.fernhill.example and
# forwards to the app tier. Host clock: America/New_York (EST, UTC-05:00 in November).

log_format edge '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" host=$host upstream=$upstream_addr '
                'rt=$request_time waf=$modsec_action rule=$modsec_rule_id rid=$request_id';
# $time_local    = when the request FINISHED, in the host's local time (see -0500)
# $upstream_addr = the ip:port nginx actually connected to for this request ("-" = none)
# $modsec_action = pass | block      $modsec_rule_id = id of the rule that blocked, or "-"

access_log /var/log/nginx/edge-access.log edge;

modsecurity on;
modsecurity_rules '
    Include /etc/modsecurity/crs/crs-setup.conf
    Include /etc/modsecurity/crs/rules/*.conf

    # --- Fernhill custom rules -------------------------------------------------
    # 100230: requests addressed to the metadata service by Host header
    SecRule REQUEST_HEADERS:Host "@contains 169.254.169.254" \\
        "id:100230,phase:1,deny,status:403,log,msg:\\'metadata host\\'"
    # 100231: SSRF guard for the link-preview proxy (INFRA-2207, 2025-02)
    SecRule ARGS:u "@contains 169.254.169.254" \\
        "id:100231,phase:1,deny,status:403,log,msg:\\'metadata in preview url\\'"
';

server {
    listen 443 ssl http2;
    server_name edge.fernhill.example;

    location / {
        proxy_pass http://app_tier;
    }

    location /static/ {
        proxy_pass http://static_tier;
    }

    # Link previews for the help-center editor (paste a URL, get a thumbnail).
    # TODO(INFRA-2207): restrict to partner domains. Allowlist currently enforced in the editor UI.
    location /proxy/fetch {
        resolver 10.20.0.2 valid=30s;
        proxy_pass $arg_u;
        proxy_set_header Host $proxy_host;
        proxy_connect_timeout 3s;
        proxy_read_timeout 5s;
    }
}
"""


# ----------------------------------------------------------------------------------------------
def describe_instances(S: ModuleType) -> dict:
    def inst(iid: str, name: str, priv: str, pub: str | None, eni: str, profile: str, tokens: str,
             launched: str, subnet: str, sg: str) -> dict:
        d: dict = {
            "InstanceId": iid,
            "ImageId": "ami-0abcdef1234567890",
            "InstanceType": "c6i.large",
            "LaunchTime": launched,
            "Placement": {"AvailabilityZone": "us-east-1b", "Tenancy": "default"},
            "PrivateIpAddress": priv,
            "PrivateDnsName": f"ip-{priv.replace('.', '-')}.ec2.internal",
        }
        if pub:
            d["PublicIpAddress"] = pub
        d.update({
            "State": {"Code": 16, "Name": "running"},
            "SubnetId": subnet,
            "VpcId": "vpc-0e1d2c3b4a5f60718" if priv.startswith("10.20.") else "vpc-0a7b6c5d4e3f20189",
            "IamInstanceProfile": {"Arn": f"arn:aws:iam::{S.ACCOUNT}:instance-profile/{profile}",
                                   "Id": "AIPAEXAMPLE" + iid[-9:].upper()},
            "NetworkInterfaces": [{
                "NetworkInterfaceId": eni,
                "PrivateIpAddress": priv,
                **({"Association": {"PublicIp": pub, "IpOwnerId": S.ACCOUNT}} if pub else {}),
                "Groups": [{"GroupId": sg, "GroupName": name.rsplit("-", 1)[0] + "-sg"}],
            }],
            "MetadataOptions": {
                "State": "applied",
                "HttpTokens": tokens,
                "HttpPutResponseHopLimit": 1 if tokens == "optional" else 2,
                "HttpEndpoint": "enabled",
                "HttpProtocolIpv6": "disabled",
                "InstanceMetadataTags": "disabled",
            },
            "Tags": [{"Key": "Name", "Value": name}, {"Key": "team", "Value": "platform"},
                     {"Key": "managed-by", "Value": "terraform" if tokens == "required" else "manual"}],
        })
        return d

    return {"Reservations": [
        {"ReservationId": "r-0aa11bb22cc33dd44", "OwnerId": S.ACCOUNT, "Instances": [
            inst(S.INSTANCE_ID, "edge-waf-01", S.INSTANCE_PRIVATE_IP, S.INSTANCE_PUBLIC_IP, S.ENI,
                 "fh-waf-edge-profile", "optional", "2023-03-14T15:20:44+00:00", "subnet-0f1e2d3c4b5a69788",
                 "sg-0edge1234567890ab")]},
        {"ReservationId": "r-0ee55ff66aa77bb88", "OwnerId": S.ACCOUNT, "Instances": [
            inst(S.STMT_INSTANCES[0], "stmt-api-01", "10.30.4.11", None, "eni-0a1a2a3a4a5a6a7a8",
                 "fh-statements-api-profile", "required", "2026-10-02T08:11:09+00:00", "subnet-0c9d8e7f6a5b43210",
                 "sg-0stmt1234567890cd"),
            inst(S.STMT_INSTANCES[1], "stmt-api-02", "10.30.4.12", None, "eni-0b1b2b3b4b5b6b7b8",
                 "fh-statements-api-profile", "required", "2026-10-02T08:11:12+00:00", "subnet-0c9d8e7f6a5b43210",
                 "sg-0stmt1234567890cd")]},
    ]}


def _trust_ec2() -> dict:
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"},
                                                    "Action": "sts:AssumeRole"}]}


def waf_role(S: ModuleType) -> dict:
    return {
        "Role": {
            "Path": "/",
            "RoleName": S.ROLE,
            "RoleId": "AROAEXAMPLEWAFEDGE7Q1",
            "Arn": f"arn:aws:iam::{S.ACCOUNT}:role/{S.ROLE}",
            "CreateDate": "2023-03-14T15:02:11+00:00",
            "Description": "edge-waf-01 instance role: read WAF rules, ship WAF logs",
            "MaxSessionDuration": 3600,
            "AssumeRolePolicyDocument": _trust_ec2(),
            "Tags": [{"Key": "owner", "Value": "platform"}, {"Key": "managed-by", "Value": "manual"}],
            "RoleLastUsed": {"LastUsedDate": "2026-11-19T13:58:40+00:00", "Region": "us-east-1"},
        },
        "InstanceProfiles": [{"InstanceProfileName": "fh-waf-edge-profile",
                              "Arn": f"arn:aws:iam::{S.ACCOUNT}:instance-profile/fh-waf-edge-profile"}],
        "AttachedManagedPolicies": [{"PolicyName": "AmazonSSMManagedInstanceCore",
                                     "PolicyArn": "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
                                     "Note": "AWS managed: ssm, ssmmessages, ec2messages only. No S3 actions."}],
        "RolePolicies": [{
            "PolicyName": "fh-waf-edge-inline",
            "LastModified": "2024-06-11T19:44:02+00:00",
            "PolicyDocument": {
                "Version": "2012-10-17",
                "Statement": [
                    {"Sid": "ReadWafConfig", "Effect": "Allow",
                     "Action": ["s3:GetObject", "s3:ListBucket"],
                     "Resource": ["arn:aws:s3:::fh-waf-config", "arn:aws:s3:::fh-waf-config/*"]},
                    {"Sid": "ShipWafLogs", "Effect": "Allow",
                     "Action": ["s3:PutObject"],
                     "Resource": "arn:aws:s3:::fh-waf-logs/*"},
                    {"Sid": "ReportingReadOnly", "Effect": "Allow",
                     "Action": ["s3:Get*", "s3:List*"],
                     "Resource": "*"},
                    {"Sid": S.ROOT_CAUSE_SID, "Effect": "Allow",
                     "Action": ["s3:Put*"],
                     "Resource": "*"},
                    {"Sid": "DenyDeleteProd", "Effect": "Deny",
                     "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteBucket"],
                     "Resource": ["arn:aws:s3:::fh-prod-*", "arn:aws:s3:::fh-prod-*/*"]},
                ],
            },
        }],
    }


def stmt_role(S: ModuleType) -> dict:
    return {
        "Role": {
            "Path": "/",
            "RoleName": "fh-statements-api-role",
            "RoleId": "AROAEXAMPLESTMTAPI3K9",
            "Arn": f"arn:aws:iam::{S.ACCOUNT}:role/fh-statements-api-role",
            "CreateDate": "2026-10-01T12:30:00+00:00",
            "Description": "statements-api: read customer exports via VPC endpoint",
            "MaxSessionDuration": 3600,
            "AssumeRolePolicyDocument": _trust_ec2(),
            "Tags": [{"Key": "owner", "Value": "statements"}, {"Key": "managed-by", "Value": "terraform"}],
        },
        "InstanceProfiles": [{"InstanceProfileName": "fh-statements-api-profile",
                              "Arn": f"arn:aws:iam::{S.ACCOUNT}:instance-profile/fh-statements-api-profile"}],
        "AttachedManagedPolicies": [],
        "RolePolicies": [{
            "PolicyName": "fh-statements-api-inline",
            "LastModified": "2026-10-01T12:30:00+00:00",
            "PolicyDocument": {
                "Version": "2012-10-17",
                "Statement": [
                    {"Sid": "ReadExports", "Effect": "Allow", "Action": ["s3:GetObject"],
                     "Resource": f"arn:aws:s3:::{S.PROD_BUCKET}/exports/*",
                     "Condition": {"StringEquals": {"aws:SourceVpce": S.VPCE}}},
                ],
            },
        }],
    }


ACCESS_KEYS_CSV = """\
user,access_key_id,status,created_utc,status_changed_utc,last_used_utc,last_used_service,note
ci-deployer,AKIAEXAMPLECIDEPLOY1,Active,2025-01-20T10:02:11Z,2025-01-20T10:02:11Z,2026-11-17T20:41:09Z,ecr,GitHub Actions deploys (scoped to ECR and ECS)
terraform-runner,AKIAEXAMPLETFRUNNER2,Active,2025-08-04T07:15:40Z,2025-08-04T07:15:40Z,2026-11-16T09:12:55Z,s3,Atlantis plan/apply
legacy-sftp-sync,AKIAEXAMPLESFTPSYNC3,Inactive,2022-02-11T16:30:00Z,2024-06-12T08:00:00Z,2024-06-11T23:59:12Z,s3,replaced by log shipper (INFRA-1874)
dana.dev,{leaked},Inactive,2025-06-02T09:14:00Z,2026-11-16T14:22:31Z,2026-11-02T10:05:44Z,sts,deactivated after GitHub secret-scanning alert on 2026-11-16
# Only IAM users have long-lived access keys (AKIA...). Roles (instance profiles, SSO, Lambda) get
# temporary credentials (ASIA...) from STS, which rotate on their own and are not listed here.
"""


def guardduty(S: ModuleType) -> dict:
    def finding(fid: str, ftype: str, sev: float, title: str, desc: str, created: str, updated: str,
                resource: dict, action: dict) -> dict:
        return {
            "AccountId": S.ACCOUNT, "Arn": f"arn:aws:guardduty:{S.REGION}:{S.ACCOUNT}:detector/12abc34d567e8fa901bc2d34e56789f0/finding/{fid}",
            "CreatedAt": created, "Description": desc, "Id": fid, "Partition": "aws", "Region": S.REGION,
            "Resource": resource, "SchemaVersion": "2.0",
            "Service": {"Action": action, "Archived": False, "Count": 1, "DetectorId": "12abc34d567e8fa901bc2d34e56789f0",
                        "EventFirstSeen": created, "EventLastSeen": updated, "ServiceName": "guardduty"},
            "Severity": sev, "Title": title, "Type": ftype, "UpdatedAt": updated,
        }

    return {
        "_export": "aws guardduty get-findings, criteria service.archived = false, exported 2026-11-19T13:20:00Z",
        "Findings": [
            finding("a2c6f0e1b9d84c7e93f5a1b2c3d4e5f6", "Recon:IAMUser/MaliciousIPCaller.Custom", 5.0,
                    "API GetCallerIdentity was invoked from an IP address on a custom threat list.",
                    "An API was used to access a resource from an IP address on the custom threat list github-leak-iocs.",
                    "2026-11-18T01:16:02.114Z", "2026-11-18T01:19:47.580Z",
                    {"ResourceType": "AccessKey", "AccessKeyDetails": {
                        "AccessKeyId": S.LEAKED_KEY, "PrincipalId": "AIDAEXAMPLEDANADEV4Q",
                        "UserName": "dana.dev", "UserType": "IAMUser"}},
                    {"ActionType": "AWS_API_CALL", "AwsApiCallAction": {
                        "Api": "GetCallerIdentity", "CallerType": "Remote IP", "ServiceName": "sts.amazonaws.com",
                        "ErrorCode": "InvalidClientTokenId",
                        "RemoteIpDetails": {"IpAddressV4": S.LEAK_IP, "Organization": {"Asn": "64500", "AsnOrg": "EXAMPLE-HOSTING"},
                                            "Country": {"CountryName": "Netherlands"}},
                        "AffectedResources": {}}}),
            finding("b7d1e2f3a4c5b6d7e8f9a0b1c2d3e4f5", "Recon:EC2/PortProbeUnprotectedPort", 2.0,
                    "Unprotected port on EC2 instance i-0f3a9c2e7b5d14a86 is being probed.",
                    "EC2 instance has an unprotected port which is being probed by a known malicious host.",
                    "2026-11-18T01:51:33.902Z", "2026-11-18T02:20:11.004Z",
                    {"ResourceType": "Instance", "InstanceDetails": {
                        "InstanceId": S.INSTANCE_ID, "InstanceType": "c6i.large",
                        "Tags": [{"Key": "Name", "Value": "edge-waf-01"}],
                        "NetworkInterfaces": [{"NetworkInterfaceId": S.ENI, "PrivateIpAddress": S.INSTANCE_PRIVATE_IP,
                                               "PublicIp": S.INSTANCE_PUBLIC_IP}]}},
                    {"ActionType": "PORT_PROBE", "PortProbeAction": {"Blocked": False, "PortProbeDetails": [
                        {"LocalPortDetails": {"Port": 443, "PortName": "HTTPS"},
                         "RemoteIpDetails": {"IpAddressV4": S.SCANNER_IP, "Organization": {"Asn": "64501", "AsnOrg": "EXAMPLE-SCAN-NET"},
                                             "Country": {"CountryName": "United States"}}}]}}),
        ],
    }


def guardduty_filters(S: ModuleType) -> dict:
    return {
        "_export": "aws guardduty list-filters + get-filter, exported 2026-11-19T13:40:00Z",
        "Filters": [{
            "Name": "suppress-waf-logshipper",
            "Description": "log shipper rollout (INFRA-1874) triggers S3/credential anomaly findings. Benign. -- yoni.ops 2024-09-03",
            "Action": "ARCHIVE",
            "Rank": 1,
            "FindingCriteria": {"Criterion": {
                "resource.accessKeyDetails.userName": {"Eq": [S.ROLE]},
            }},
            "CreatedAt": "2024-09-03T16:12:40Z",
        }, {
            "Name": "suppress-lowsev-portprobe-dev",
            "Description": "port probes on dev bastions",
            "Action": "ARCHIVE",
            "Rank": 2,
            "FindingCriteria": {"Criterion": {
                "type": {"Eq": ["Recon:EC2/PortProbeUnprotectedPort"]},
                "resource.instanceDetails.tags.value": {"Eq": ["dev-bastion"]},
            }},
            "CreatedAt": "2025-04-22T09:00:12Z",
        }],
    }


# ----------------------------------------------------------------------------------------------
def slack(S: ModuleType) -> list[dict]:
    msgs = [
        ((12, 4, 11), "maya.k", "support escalation: customers get \"statement unavailable\" for anything before Nov 18. statements-api is logging NoSuchKey on fh-prod-customer-exports"),
        ((12, 6, 40), "maya.k", "listed the bucket. only exports/2026/11/18 and /19 are left. 12th through 17th are GONE"),
        ((12, 7, 2), "noam.r", "what?? who touched that bucket. did someone run a cleanup"),
        ((12, 9, 31), "noam.r", "@here this is now SEV1. nobody deletes anything else until we know what happened"),
        ((12, 11, 15), "maya.k", "CloudTrail has yoni doing lifecycle + DeleteObject + DeleteBucket on tuesday evening around 17:30 our time"),
        ((12, 13, 48), "yoni.ops", "that was the STAGING cleanup. CHG-4471, approved. fh-staging-exports-2023 and a 30 day rule on fh-staging-customer-exports. I never touched prod"),
        ((12, 14, 30), "noam.r", "staging and prod bucket names are one word apart. are we 100% sure"),
        ((12, 15, 5), "yoni.ops", "the console shows the bucket name in red when you delete. and prod has a deny on delete anyway"),
        ((12, 20, 22), "avi.sec", "other theory: GitHub secret scanning flagged dana's old access key on monday, and GuardDuty has a MaliciousIPCaller on that key tuesday night. leaked key is my top suspect"),
        ((12, 22, 9), "dana.dev", "I deactivated that key on monday 20 minutes after the alert. it was a dev user, no prod S3 at all"),
        ((12, 23, 40), "avi.sec", "deactivated keys still get logged when someone tries them. I'll check what it actually managed to do"),
        ((12, 31, 18), "maya.k", "versioning was never enabled on that bucket. no restoring from old versions"),
        ((12, 33, 55), "noam.r", "backups?"),
        ((12, 35, 12), "maya.k", "the exports ARE the backup of the warehouse snapshot. we can regenerate them but it takes days. ~100M customer rows across the week"),
        ((12, 40, 30), "noam.r", "could this be an AWS problem? S3 eating objects?"),
        ((12, 42, 1), "maya.k", "health dashboard is clean for us-east-1"),
        ((12, 55, 44), "avi.sec", "weird: the S3 server access log for the bucket has hundreds of S3.EXPIRE.OBJECT lines after midnight UTC. requester is AmazonS3, not a person"),
        ((13, 2, 17), "yoni.ops", "EXPIRE means lifecycle. my rule is 30 days and on a different bucket. what does prod's lifecycle config say?"),
        ((13, 5, 3), "maya.k", "prod bucket has a lifecycle rule now. id tmp-cleanup, expire everything after 1 day. not in terraform, nobody here recognizes it"),
        ((13, 6, 20), "noam.r", "so who put it there"),
        ((13, 18, 49), "avi.sec", "only a few principals can write to that bucket config. checking CloudTrail now, there's a lot of it"),
        ((13, 29, 36), "avi.sec", "seeing S3 calls on prod from our WAF instance role (fh-waf-edge-role) with an aws-cli user agent. the WAF doesn't use aws-cli, it's a Go log shipper. someone debugging on the box?"),
        ((13, 33, 2), "yoni.ops", "nobody has SSH on edge-waf-01. SSM only, and Session Manager history is empty for that instance this month"),
        ((13, 36, 41), "maya.k", "so either the box is owned or the role is being used from somewhere else. those are different problems"),
        ((13, 41, 10), "avi.sec", "also found why GuardDuty was so quiet about that role: suppress-waf-logshipper auto-archives anything for it since 2024. the export I pulled is active findings only. asked for the archived ones"),
        ((13, 44, 58), "noam.r", "if exports were downloaded this is a data breach, not just data loss. legal is joining at 14:00 our time"),
        ((13, 50, 25), "noam.r", "pulling everything into one pack for IR: WAF logs, flow logs, CloudTrail, S3 access logs, IAM, GuardDuty. please stop poking at prod"),
        ((13, 58, 40), "maya.k", "can't rotate instance creds by hand, they rotate themselves. want me to stop edge-waf-01? holding until IR says"),
        ((14, 2, 3), "avi.sec", "don't stop it yet, we'd lose memory. isolate the SG to office only and keep it running"),
    ]
    out = []
    for i, ((h, m, s), user, text) in enumerate(msgs):
        ts = int(datetime(2026, 11, 19, h, m, s, tzinfo=UTC).timestamp())
        out.append({"ts": f"{ts}.{(137 * i + 104729) % 1000000:06d}", "user": user, "text": text})
    return out


CHANGE_TICKET = """\
CHANGE REQUEST  CHG-4471                                   status: COMPLETED
=============================================================================
Title       : Retire 2023 staging export bucket, add retention to staging exports
Requester   : yoni.ops (Platform)
Approver    : noam.r (Eng Manager)            approved 2026-11-16 11:02 EST
Window      : 2026-11-17 17:00-18:00 EST (after business hours)
Risk        : low (staging only, no customer data since 2024 masking)
Systems     : AWS account 111122223333, S3

Plan
----
1. fh-staging-customer-exports: add lifecycle rule "expire-staging-30d"
   (prefix exports/, expire after 30 days).
2. fh-staging-exports-2023: empty the bucket (6 leftover objects), then delete it.
3. Verify with `aws s3 ls`; update the Terraform state note in INFRA-2290.

Rollback
--------
Step 1: remove the rule. Step 2: none needed (data is masked and duplicated in
the archive account).

Work log (EST)
--------------
17:27  logged in via SSO (PlatformAdmin), from home
17:31  rule added on fh-staging-customer-exports, verified in console
17:33  fh-staging-exports-2023 emptied (6 objects)
17:38  fh-staging-exports-2023 deleted
17:41  `aws s3 ls` checked, closed.   -- yoni.ops

Note: production buckets (fh-prod-*) were out of scope and not touched.
"""


# ----------------------------------------------------------------------------------------------
DESCRIPTIONS = {
    "README_FIRST.txt": "this file",
    "waf/access.log": "edge WAF / reverse proxy access log (nginx + ModSecurity)",
    "waf/edge-waf.conf": "the WAF's nginx config: log format, custom rules, routes",
    "cloudtrail/": "CloudTrail, one event per line (JSON lines), split by UTC day",
    "s3-access-logs/": "S3 server access logs of the prod exports bucket, by UTC day",
    "vpc-flow-logs/": "VPC flow logs of the WAF instance's network interface",
    "ec2/describe-instances.json": "aws ec2 describe-instances (WAF + statements-api instances)",
    "iam/roles/fh-waf-edge-role.json": "the WAF instance role: trust, attached and inline policies",
    "iam/roles/fh-statements-api-role.json": "the statements-api instance role, for comparison",
    "iam/access-keys.csv": "long-lived IAM user access keys and their status",
    "guardduty/findings.json": "GuardDuty findings export (active findings only)",
    "guardduty/suppression-rules.json": "GuardDuty suppression rules (filters with action ARCHIVE)",
    "slack/inc-prod-exports.json": "export of the #inc-prod-exports channel",
    "tickets/CHG-4471.txt": "the change ticket for Tuesday evening's staging cleanup",
}


def _describe(path: str) -> str:
    if path in DESCRIPTIONS:
        return DESCRIPTIONS[path]
    for prefix, d in DESCRIPTIONS.items():
        if prefix.endswith("/") and path.startswith(prefix):
            return d
    return ""


def readme(files: list[str]) -> str:
    listing = "\n".join(f"{f:<61} {_describe(f)}" for f in files)
    return f"""\
FERNHILL CREDIT // SECURITY INCIDENT IR-0917 // EVIDENCE PACK
==============================================================

Thursday 19 November 2026, around 07:00 in New York, the customer support queue
lit up: the statements portal said "statement unavailable" for every statement
older than the day before. The platform on-call (maya.k) found out why: most of
the S3 bucket that feeds the portal, fh-prod-customer-exports, was simply gone.
A week of full customer exports, roughly 100 million rows. No versioning.

By lunchtime the #inc-prod-exports channel had three theories:
  - an insider: yoni.ops ran deletes on S3 on Tuesday evening;
  - a leaked key: a developer's access key was flagged on GitHub on Monday;
  - an AWS problem.

Then security noticed something odd: our own WAF instance role had been calling
S3 with a user agent the WAF never uses. Every suspicious API call in this pack
is signed by one of OUR roles. The question is who was holding it.

You are the incident responder. Rebuild the attack from the evidence, not from
the channel. The six questions are on the IncidentLab site.


WHAT'S IN THE PACK
------------------
{listing}


TIME ZONES AND FORMATS (read this twice)
----------------------------------------
waf/access.log         nginx-style [dd/Mon/yyyy:HH:MM:SS -0500] = US Eastern
                       (EST, UTC-05:00). Late evening in New York is already
                       the next day in UTC. See waf/edge-waf.conf for the fields.
cloudtrail/*.jsonl     eventTime is UTC (ISO-8601, ...Z). Files are split by UTC
                       day. Each line is one CloudTrail record (our SIEM flattens
                       the usual {{"Records":[...]}} wrapper to JSON lines).
s3-access-logs/        [dd/Mon/yyyy:HH:MM:SS +0000] = UTC. Space-separated, with
                       quoted fields. Standard S3 server access log format.
vpc-flow-logs/         flow log format v2 (header on line 1). start/end are unix
                       epoch seconds (UTC). Filtered to traffic with the internet;
                       AWS service endpoints are left out.
guardduty/*.json       UTC (ISO-8601, ...Z).
slack/*.json           "ts" is unix epoch seconds as a string (Slack style).
tickets/CHG-4471.txt   US Eastern (EST), as people wrote it.

The CloudTrail export covers 17:00 EST Tue 17 Nov to 03:00 EST Wed 18 Nov
(22:00Z to 08:00Z), the same window as the WAF and flow logs. The S3 access logs
run from 18 Nov 00:00Z to 19 Nov 13:00Z.


GLOSSARY FOR THE AWS-CURIOUS
----------------------------
IMDS       the EC2 instance metadata service at 169.254.169.254, reachable only
           from inside the instance. It hands out the instance role's temporary
           credentials. IMDSv1 answers plain GET requests; IMDSv2 requires a
           session token obtained with a PUT first.
ASIA...    an access key id for TEMPORARY credentials (roles, SSO, STS).
AKIA...    an access key id for a long-lived IAM user key.
Session    for an EC2 instance role, the CloudTrail session name is the instance id.


TIPS
----
- grep, sed, awk, sort and uniq (or Windows PowerShell) take you all the way.
  Nothing to install, and no AWS account needed.
- In CloudTrail, the same role can show up from more than one place. Ask WHERE
  each call came from, and with which user agent, not just WHO signed it.
- People in the channel were stressed and guessing. Some of them were wrong.
- Every IP address, account id and key in this pack is fictional.

Good luck. Find out who deleted prod.
"""
