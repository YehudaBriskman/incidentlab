## What actually happened

There were **two ghosts**, born a day apart, and they met on Wednesday morning.

**Ghost 1, the address that wouldn't die.** On Monday the DNS team lowered the ledger record's TTL to **60 seconds**, the textbook preparation for a migration. On Tuesday afternoon the platform team rolled a new node-local resolver role, **node-dns v2**, to rack B to cut upstream query load. v2 added `cache-min-ttl: 86400`: a **TTL floor**. unbound restarted, looked up the ledger, and cached the old dc1 address `10.20.4.15` for **a full day** instead of 60 seconds. At 20:00 the record moved to the cloud and the old VM was switched off. Rack A followed within a minute. Rack B kept dialling a dead address.

**Ghost 2, the black hole.** At 22:00 the dc1<->cloud link moved to a **WireGuard tunnel** over a PPPoE circuit: 1492 − 80 = **1412** bytes of MTU, while the app hosts still send 1500-byte packets. That works, *as long as Path MTU Discovery works*: the gateway answers an oversized DF packet with ICMP "fragmentation needed (mtu 1412)", the host shrinks its segments, and life goes on. The validation capture shows exactly that. At **09:12** on Wednesday a security baseline put "drop all ICMP except echo" at the **top** of every app host's INPUT chain, above the `RELATED,ESTABLISHED` accept. From then on the "too big" messages arrived on the wire, were visible in tcpdump, and were thrown away by netfilter before TCP could hear them. As each host's cached PMTU expired (up to 10 minutes later), its big uploads started vanishing.

## Timeline

| UTC | Local (+02:00) | Event |
|---|---|---|
| Mon 15:02 | 17:02 | Ledger TTL 3600 -> 60 s (`CHG-7305`) |
| Tue 14:20–14:31 | 16:20–16:31 | node-dns v2 with `cache-min-ttl: 86400` on app-05..08; caches refill with the old address (`CHG-7318`) |
| Tue 20:00:42 | 22:00:42 | Ledger A record -> `10.40.8.21`; old VM off at 20:31 (`CHG-7329`) |
| Tue 22:00 | Wed 00:00 | WireGuard tunnel, `wg0` MTU 1412 (`CHG-7330`); PMTUD validated at 22:41 |
| Wed 06:10:44 | 08:10:44 | app-07 rebooted for a kernel update: cache emptied, it resolves the new address (`CHG-7336`) |
| Wed 08:55 | 10:55 | Ledger v3.8.0 (`CHG-7339`), a few 503s during the rolling restart |
| Wed 09:12 | 11:12 | **Security baseline v4: ICMP dropped above RELATED** (`CHG-7342`) |
| Wed 09:14:46 | 11:14:46 | app-03's PMTU cache has expired; its next upload's 1448-byte segments vanish |
| Wed **09:15:16** | 11:15:16 | First "timeout awaiting response" logged |
| Wed 09:40 | 11:40 | Jumbo frames on eth1 (`CHG-7344`), unrelated |
| Wed 11:52 | 13:52 | unbound flush on rack B (`CHG-7347`): connects work, uploads now hang there too |
| Wed 12:18 | 14:18 | ICMP type 3 allowed again (`CHG-7348`): uploads recover |

## The answers

| Stage | Answer | Why |
|---|---|---|
| 1 | `09:15:16` | First `phase=response` failure in the client log (11:15:16 +02:00). It started 30 s earlier, at the first ICMP drop |
| 2 | `CHG-7342` | The ICMP DROP rule's comment is `baseline-v4`; only that change ships it, and it lands right before the first drop |
| 3 | `1372` | Path MTU 1412 (ICMP, firewall `MTU=`, `wg0`) minus 20 IPv4 minus 20 TCP |
| 4 | `10.20.4.15` | The only `peer` of connect-phase failures; the zone audit shows it deleted on Tuesday |
| 5 | `3` | app-05, app-06, app-08. app-07 has the same role but was rebooted Wednesday morning |
| 6 | `cache-min-ttl` | The only option that *raises* TTLs. Stale TTLs of ~10,000 s on a 60 s record prove a floor |

## How the ghosts tangled

- **The firewall change also changed the DNS ghost's symptom.** Before 09:12, rack B failed fast with `EHOSTUNREACH` (the gateway's ICMP host-unreachable for the dead VM). After 09:12 that ICMP was dropped too, and the same bug became slow 5-second connect timeouts. Two problems, one word in the channel: "timeouts".
- **The DNS fix revealed the MTU bug on rack B.** After the flush at 11:52, rack B reached the real ledger for the first time, and its uploads immediately hung like rack A's. That is the moment it became obvious there were two ghosts.
- **Separating them takes two fields**: failure `phase` and `peer`. Connect failures to a dc1 address are DNS. Response timeouts to the cloud address, only on big requests, are MTU.

## Why the red herrings were wrong

- **Ledger v3.8.0 (08:55):** big uploads kept succeeding under 3.8.0 for 18 more minutes; the ingress log shows no 413s; the hung uploads never reached the ingress at all. A server can't reject what it never receives.
- **Jumbo frames (09:40):** after the first hang, and on eth1 (storage). `ip route get` shows ledger traffic leaves via eth0.
- **The tunnel:** a precondition, not the trigger. It carried big uploads fine for eleven hours because ICMP got through.
- **"Ping works":** echo was explicitly allowed. PMTUD uses destination-unreachable, which wasn't.
- **"I can see the ICMP in tcpdump":** tcpdump taps packets at the driver, **before** netfilter. Seeing a packet in a capture says nothing about whether the firewall let it in. The kernel log said so plainly: `IN-DROP-ICMP ... TYPE=3 CODE=4 ... MTU=1412`.
- **The cloud LB's MSS 8961:** the sender uses the smaller of the two MSS values (1460). And the LB itself was fine: its segments to dc1 were already 1360 bytes, because PMTUD worked on the cloud side. That asymmetry is why downloads worked and uploads didn't.
- **"All of rack B, half the fleet":** four hosts had the role; three were stuck. Same config, different state.
- **Negative caching:** v2 did lower `cache-max-negative-ttl`, but these were positive answers.

## Fixes

**Immediate (done):** flush the stale caches; allow ICMP type 3 inbound.

**Structural**
- **Never filter ICMP "fragmentation needed"** (IPv4 type 3 code 4) or ICMPv6 "packet too big" (type 2). RFC 4890 lists what must pass. Put any ICMP policy **below** `RELATED,ESTABLISHED`.
- **Clamp MSS on the tunnel** so hosts never depend on PMTUD across it: `iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu` (or `--set-mss 1372`).
- Enable **Packetization Layer PMTUD** on hosts as a safety net: `net.ipv4.tcp_mtu_probing=1` (RFC 4821).
- **Remove the TTL floor**, or keep it to seconds. The unbound manual warns that values above an hour or so "can lead to trouble". If upstream load is the problem, use `prefetch` and more upstream capacity, not a floor.
- **Make cache flushes a migration step**, and keep the old address answering (or redirecting) for longer than the longest cache in your fleet.
- **Monitor resolver drift:** alert when a node-local answer differs from the authoritative one.
- **Change review:** "host firewall template" hid "drop ICMP" behind a vague summary. Diffs of rule sets belong in the change record.

## The real incidents

On 30 September 2021, **Slack** enabled DNSSEC on slack.com, hit a problem with how wildcard records were answered, and rolled back. But the DS record had already been cached by validating resolvers with a 24-hour TTL, so some users kept failing to resolve slack.com until caches expired or ISPs flushed them. The lesson is the same as Ghost 1: **a cache can outlive your rollback**, and its lifetime is set by someone else's TTL, or by someone's TTL floor.

The **PMTUD black hole** is older than most of us: RFC 2923 (2000) describes it, and it comes back every time someone adds a tunnel (VPN, GRE, IPsec, VXLAN, WireGuard) and someone else "hardens" ICMP. Small requests work, big ones hang forever, and ping says everything is fine.
