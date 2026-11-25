# CASE BIBLE: "Ghost in the Network" (case id: `ghost-in-the-network`)

> SPOILERS. Instructor and builder reference only. Never ship this file to players.
> This file is the contract between `generator/cases/ghost-in-the-network/`, the case JSONs, the debriefs and
> `solutions/ghost-in-the-network/solve.sh`. Canonical constants live in `generator/cases/ghost-in-the-network/timeline.py`.

Audience: working engineers. Target time: 10 min orientation + 50 min solve. Difficulty: hard.

## 1. The true story

**Kestrel Freight** (fictional) runs `manifest-sync` workers on eight app hosts in its on-prem site **dc1**
(`app-01`..`app-08`, `10.20.12.11`..`.18`, VLAN gateway `gw-dc1` = `10.20.12.1`). They call the **ledger** API at
`ledger.int.kestrel.internal:443`. Every app host resolves through a **node-local unbound** on `127.0.0.1`,
which forwards to `ns1` (`10.20.0.53`, authoritative for `int.kestrel.internal`).

The ledger is being migrated from a VM in dc1 (`ledger-vm-01`, **`10.20.4.15`**) to a cloud load balancer
(**`10.40.8.21`**). Two independent problems hit in the same 24 hours, and they interact.

### Ghost 1: the stale DNS cache (started Tuesday evening)

1. **Mon 16 Nov 15:02 UTC** (`CHG-7305`): the DNS team does the right thing and lowers the ledger A record TTL
   from 3600 to **60 s** ahead of the migration.
2. **Tue 17 Nov 14:20 UTC** (`CHG-7318`): the platform team rolls ansible role **node-dns v2** to rack B
   (`app-05`..`app-08`) "to cut upstream query load". v2 adds **`cache-min-ttl: 86400`** (a TTL floor). unbound
   restarts on each host, and the first ledger lookup (14:21–14:28) caches the *old* address with an effective TTL
   of **one day**.
3. **Tue 20:00:42 UTC** (`CHG-7329`): ledger A record switched to `10.40.8.21`; at 20:31 the VM is powered off and
   its record deleted. Rack A (v1, honours TTL 60) follows within a minute.
4. Rack B keeps answering `10.20.4.15` until ~14:2x on Wednesday. **Except `app-07`**: it was rebooted for a kernel
   update at **Wed 06:10:44** (`CHG-7336`), which emptied its cache; it resolved the new address at 06:11:31 (and
   cached *that* for a day, which is harmless, but its dig shows a suspicious TTL of ~67k).
5. So **three hosts** (`app-05`, `app-06`, `app-08`) fail every request at connect:
   - before the firewall change: `connect EHOSTUNREACH` after ~3 s (gw-dc1 ARPs for the dead VM, then sends ICMP
     host-unreachable, which the host accepts);
   - after the firewall change: that ICMP is dropped too, so failures become 5 s `connect ETIMEDOUT`. One change
     altered the symptom of an unrelated bug.
6. **Wed 11:52 UTC** (`CHG-7347`): `unbound-control flush` on rack B. Connects work; their big uploads now hang
   like everyone else's (Ghost 2).

### Ghost 2: the PMTUD black hole (started Wednesday morning)

1. **Tue 22:00 UTC** (`CHG-7330`): the dc1<->cloud interconnect moves from a leased line to a **WireGuard** tunnel
   over the dc1 internet circuit. The circuit is PPPoE (**1492**); wg-quick sets `wg0` MTU to 1492 − 80 = **1412**.
   App hosts still have eth0 MTU 1500 and advertise MSS 1460; the cloud LB (MTU 9001) advertises MSS 8961.
2. Path MTU Discovery works overnight: big DF segments hit gw-dc1, it returns **ICMP type 3 code 4** "need to
   frag (mtu 1412)", hosts cache PMTU 1412 per destination for 10 min (`mtu_expires`) and resend smaller. The
   validation capture (`pcap/tunnel-validation_app-03.txt`, Tue 22:41) shows exactly that.
3. **Wed 09:12 UTC** (`CHG-7342`, summary only says "Security baseline v4 ... host firewall template baseline-v4"):
   ansible inserts at the **top** of INPUT: accept echo-request/echo-reply, LOG other ICMP (`IN-DROP-ICMP:`,
   5/min), DROP other ICMP. These sit **above** `RELATED,ESTABLISHED`, so ICMP errors for live connections are
   dropped. Ping still works.
4. Each host keeps working until its cached PMTU expires (app-03 09:14:36, app-07 09:16:12, app-01 09:18:21,
   app-04 09:19:55, app-02 09:21:47). After that, every request with more than 1360 bytes of payload sends
   1448-byte segments that the gateway refuses; the ICMP **is visible in tcpdump on the host** (AF_PACKET taps
   before netfilter) and is dropped by netfilter; the host retransmits the same segment with exponential backoff
   until the client's 30 s timeout. Server-to-client traffic is fine (the cloud side's PMTUD works: the ledger sends
   1360-byte segments), so big **downloads** work and big **uploads** hang.
5. First victim: app-03's upload starting at **09:14:46 UTC**; first `IN-DROP-ICMP ... TYPE=3 CODE=4` at
   09:14:46; client logs the failure at **09:15:16 UTC** (11:15:16.889+02:00).
6. **Wed 12:18 UTC** (`CHG-7348`): ICMP type 3 accepted at the top of INPUT. Uploads recover (first big upload per
   host takes ~200 ms extra while PMTU is relearned).

### Red herrings (all explained in the debrief)

- **Ledger v3.8.0** deploy 08:55:00–08:56:40 (`CHG-7339`): "new body validation". A handful of fast `503`s during
  the rolling restart; big uploads succeed under 3.8.0 from 08:56:40 until each host's PMTU expiry; ingress shows no
  413s; the hung uploads never reach the ingress at all.
- **Jumbo frames** on eth1 at 09:40 (`CHG-7344`): an "MTU change" in the middle of the incident, but after the first
  hang and on the storage interface (`ip route get` shows ledger traffic leaves via eth0).
- **The tunnel itself** (`CHG-7330`): necessary precondition, not the trigger. It worked for 11 hours.
- **"Ping works"** and **"I can see the ICMP in tcpdump"**: both true, both irrelevant.
- **Cloud LB MSS 8961 / MTU 9001**: big but harmless; the sender uses min(1460, 8961).
- **"Half the fleet / rack B / node-dns v2"**: four hosts have the role, only three are stale.
- **Negative caching**: v2 also lowered `cache-max-negative-ttl` 3600 → 300. Irrelevant: the answer was positive.
- `cache-max-ttl: 86400` is a cap, identical in v1 and v2.
- traceroute `* * *` at 10:05: time-exceeded (ICMP type 11) is dropped by the same baseline.

## 2. Timeline (UTC; office local = UTC+02:00)

| UTC | Event |
|---|---|
| Mon 16 15:02:11 | `CHG-7305` ledger TTL 3600 -> 60 |
| Tue 17 14:20–14:31 | `CHG-7318` node-dns v2 to app-05..08, unbound restarts, ledger cached with floor 86400 |
| Tue 17 20:00:42 | `CHG-7329` ledger A -> 10.40.8.21 (20:31 VM off, record deleted) |
| Tue 17 22:00 | `CHG-7330` WireGuard tunnel, wg0 MTU 1412 |
| Tue 17 22:41:05 | validation capture: PMTUD works |
| Wed 18 06:10:44 | `CHG-7336` app-07 reboot (cache emptied) |
| Wed 18 07:00:00 | evidence window starts |
| Wed 18 08:55:00–08:56:40 | `CHG-7339` ledger v3.8.0 (decoy) |
| Wed 18 09:12:05–09:12:34 | `CHG-7342` baseline v4 applied host by host (the trigger) |
| Wed 18 09:14:46 | first big upload hangs (app-03), first ICMP 3/4 drop |
| Wed 18 **09:15:16** | first `phase=response` failure logged (q1) |
| Wed 18 09:28:40 | alert, incident channel opens |
| Wed 18 09:40 | `CHG-7344` jumbo frames on eth1 (decoy) |
| Wed 18 10:30:58 / 10:31:07 | small / large captures on app-03 |
| Wed 18 10:44:12 | stale connect capture on app-05 |
| Wed 18 11:30–11:34 | dig outputs collected |
| Wed 18 11:52–11:53 | `CHG-7347` unbound flush on rack B |
| Wed 18 12:18:30–12:18:51 | `CHG-7348` ICMP type 3 allowed |
| Wed 18 12:45:00 | evidence window ends |

## 3. Questions and answers

Normalization: trim, lowercase, collapse whitespace.

| id | Question (gist) | Answer | Where it comes from | Points |
|---|---|---|---|---|
| q1 | Logged time (UTC) of the first request that connected and then hung | `09:15:16` (computed by the generator: earliest `phase=response` failure) | `app/manifest-sync.log` first `"phase":"response"` line, `ts` 11:15:16.889+02:00 minus 2h. Cross-check: firewall drop at 09:14:46 = start time | 100 |
| q2 | Change id that made large packets vanish silently | `CHG-7342` | First `TYPE=3 CODE=4` in `firewall/kern-app-hosts.log` (09:14:46, prefix `IN-DROP-ICMP:`); `iptables-save` diff shows the ICMP DROP rule with comment `baseline-v4`; `changes/change-log.csv` row containing `baseline-v4` | 100 |
| q3 | MSS that fits the tunnel (MTU − 20 − 20) | `1372` | `need to frag (mtu 1412)` in `pcap/app-03_large-request.txt`, `MTU=1412` in firewall lines, `wg0 mtu 1412` in `network/ip-link.txt`; 1412 − 40 | 100 |
| q4 | Address the connect failures go to | `10.20.4.15` | unique `peer` of `"phase":"connect"` lines; `dns/zone-audit.log` shows it deleted Tue 20:00/20:31; dig on app-05/08; `pcap/app-05_ledger-connect.txt` | 100 |
| q5 | Number of app hosts that sent requests to it | `3` | distinct `host` with that `peer` in the client log (app-05, app-06, app-08); app-07 explained by `network/inventory.csv` last boot + `CHG-7336` | 100 |
| q6 | unbound option that made those hosts ignore the 60 s TTL | `cache-min-ttl` | diff v1/v2 confs; dig TTLs 10206/10493 on stale hosts vs 60 from ns1 (`aa`); only TTL option that *raises* TTLs | 150 |

Solver: `solutions/ghost-in-the-network/solve.sh` derives all six from evidence only.

## 4. Evidence pack (`build/evidence/ghost-in-the-network/`)

| Path | Format / clock | Notes |
|---|---|---|
| `README_FIRST.txt` | text | on-call view, file list, clocks; no answers |
| `app/manifest-sync.log` | JSON lines, **local +02:00**, written at request end | ~41k lines; `req_id`, `method`, `path`, `req_bytes`, `peer`; ok lines: `status`, `resp_bytes`, `duration_ms`; failures: `phase` (`connect`/`response`), `error`, `duration_ms`; debug `ledger endpoint resolved` lines every 5 min per host with `addr`. Sizes: small ≤ 1080 bytes, big ≥ 2400 (no ambiguous sizes). Pinned: app-03 small 10:30:58, large 10:31:07; app-05 stale 10:44:12 |
| `ledger/ingress-access.log` | nginx-like, UTC, end time | only requests that arrived; `rid` = client `req_id`; `ver=3.7.4/3.8.0`; plus a cloud consumer `10.40.3.17` as noise |
| `pcap/*.txt` + `pcap/*.pcap` | `tcpdump -nn -tttt -v`, UTC | small (19 pkts), large (41 pkts: 10×1448 burst, 6 ICMP 3/4, RTO retransmits with ICMP for later ones, RST at +30 s), validation (33 pkts: ICMP accepted, resend as 1360, SACK), stale (5 pkts: 3 SYNs, 2 ICMP host-unreachable). Real libpcap files; outgoing TCP checksums are offload-style "incorrect" |
| `firewall/kern-app-hosts.log` | syslog UTC, no year, kernel uptime stamps | `IN-DROP-ICMP:` (only after 09:12, token bucket 5/min burst 5 per host): type 3 code 4 with `MTU=1412`, type 3 code 1 for stale hosts, type 11 traceroute at 10:05 on app-02; `IN-DROP:` noise (scanner 10.20.99.40, NetBIOS broadcasts) |
| `firewall/app-03_iptables-save_{before,after}.txt` | iptables-save | before: icmp ACCEPT after RELATED; after: baseline-v4 ICMP rules at the top |
| `network/inventory.csv` | CSV | role and `last_boot_utc` (app-07 = Wed 06:10:44) |
| `network/ip-link.txt` | shell | app-03/app-05 (eth0 1500, eth1 9000), gw-dc1 (ppp0 1492, wg0 1412), ledger LB (ens5 9001) |
| `changes/change-log.csv` | CSV UTC | 13 changes Mon–Thu |
| `dns/zone-audit.log` | key=value UTC | TTL lower, cutover, VM record delete, noise |
| `dns/dig/app-0{2,5,7,8}.txt` | dig, UTC | no file for app-06 (players must use the client log for q5) |
| `dns/unbound/node-dns-v{1,2}.conf` | unbound.conf | v2 adds `cache-min-ttl: 86400`, changes threads/caches and `cache-max-negative-ttl` |
| `chat/inc-3107.json` | Slack-like JSON, epoch-string ts | competing theories: ledger deploy, jumbo frames, cloud LB MSS, "ping works", "I can see the ICMP", negative caching, "all of rack B" |

## 5. Generator

`python3 generator/cases/ghost-in-the-network/build.py` (stdlib only, seed 20261118, byte-identical across runs).
Modules: `timeline.py` (constants), `packets.py` (packet model, tcpdump text, pcap writer), `build.py` (simulation,
documents, truth, cross-checks). It exits non-zero if: the first hang is not on app-03 between the baseline and the
jumbo change; the stale host set in the log differs from `STALE_HOSTS`; pinned requests are missing; any request
size falls in the ambiguous band; connect failures name more than one peer; MTU or need-to-frag evidence is missing;
an answer leaks into `README_FIRST.txt`; size limits are exceeded.
