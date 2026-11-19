# Postmortem: <incident title>

> **Blameless.** We describe what the system and the process allowed to happen, not who to blame.
> Write "the deploy introduced…", not "X broke…". Assume everyone acted reasonably with what they knew
> at the time.

| | |
|---|---|
| Incident ID | INC-____ |
| Date | YYYY-MM-DD |
| Authors | |
| Status | Draft / In review / Final |
| Severity | SEV-1 / SEV-2 / SEV-3 |
| Services affected | |

## 1. Summary

_Two or three sentences a non-engineer can follow: what broke, for how long, who was affected, and how it
was fixed._

## 2. Impact

- **Duration (UTC):** from `HH:MM:SS` (first user-visible error) to `HH:MM:SS` (last error). Total: __ min.
- **User impact:** _What could users not do? How many unique customers were affected? How did you count
  them, and what did you exclude (synthetic monitors, anonymous requests)?_
- **Error rate:** _peak and average for the affected endpoints._
- **Business impact:** _failed orders, revenue, support tickets, SLA/SLO budget burned._
- **What was *not* affected:** _which services and endpoints stayed healthy?_

## 3. Timeline (all times UTC)

_Convert every source to UTC before writing it here. Note which source each line comes from._

| Time (UTC) | Event | Source |
|---|---|---|
| HH:MM:SS | _Last change before the incident (deploy, config, data)_ | deploys.log |
| HH:MM:SS | _Trigger event_ | |
| HH:MM:SS | _First user-visible error_ | nginx access log |
| HH:MM:SS | _Alert fired / humans engaged_ | |
| HH:MM:SS | _Hypotheses tried (including the wrong ones)_ | chat |
| HH:MM:SS | _Mitigation applied_ | |
| HH:MM:SS | _Recovery confirmed_ | metrics |

## 4. Root cause

_The underlying defect. What is the code or configuration, why does it behave badly, and for which inputs?
Link the commit and the file/function. Explain it so a new team member would understand it._

## 5. Trigger

_What specific event turned a latent defect into an outage at this moment? (A request, an input, a deploy,
a traffic pattern.) Why didn't it happen earlier?_

## 6. Contributing factors

_What made it worse, longer, or harder to diagnose? Consider: retries, health checks and restarts,
timeouts, missing limits, testing gaps, review gaps, observability gaps, time zones, misleading signals._

-
-
-

## 7. Detection

- _How did we find out? (alert, customer, synthetic monitor, a person noticing)_
- _Time from trigger to detection: __ min. Could we have detected it sooner? Which signal would have
  pointed straight at the cause?_

## 8. Resolution

- _What did we do to stop the bleeding? Who decided, based on what evidence?_
- _Time from detection to mitigation: __ min._
- _Is the underlying defect still in the codebase? What's needed before the change can ship again?_

## 9. What went well

-
-

## 10. What went poorly

_Include red herrings: which theories did we chase, why were they convincing, and what evidence ruled
them out?_

-
-

## 11. Where we got lucky

-

## 12. Action items

_Each item is specific, has one owner and a due date, and is tracked as a ticket. Mix prevention,
detection and mitigation._

| # | Action | Type (prevent / detect / mitigate / process) | Owner | Due | Ticket |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |

## 13. Lessons learned

_One or two lessons that apply beyond this service._

## Appendix: evidence

_Commands you ran, log excerpts, graphs, links. Enough for a reader to reproduce your conclusions._
