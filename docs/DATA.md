# Production data: rules and runbook

IncidentLab's state lives in Netlify Blobs. Treat it as production data: no code change, deploy or admin
click may lose it. This document is the contract for anyone changing stored records.

## Where the data is

| Store | What | Notes |
|---|---|---|
| `incidentlab-v2` | Live data: `account:`, `username:`, `session:`, `progress:<case>:<account>`, `config:*` (schedule, settings, event, migrations ledger), `firstblood:`, `audit:`, `trash:`, `legacy:`, `ratelimit:` | Never rename. A new name means an empty store. That's how round-1 players were orphaned. |
| `incidentlab-backups` | `daily/<YYYY-MM-DD>.json` snapshots, 30 days | Written by the scheduled function `backup-daily` |
| `incidentlab-players` | Round-1 anonymous players (pre-accounts) | Read-only. Migration 002 copies it to `legacy:<id>` |
| `~/.incidentlab-backups/` (your machine) | Pre-deploy, pre-migrate, pre-restore and manual snapshots | Mode 600, never in the repo |

`session:` and `ratelimit:` keys are ephemeral and never backed up or restored.

**Planned in #64** (not written yet): DB-stored cases add the prefixes `case:` (case records, `CaseMetaSchema`,
plus public and sealed content), `evidence:` (evidence files in 4 MiB chunks, `EvidenceEntrySchema`) and
`upload:` (in-progress chunked uploads) to `incidentlab-v2`. The schemas live in `site/shared/case-records.ts`
and follow the rules below.

## Rules for changing stored records

1. **Additive only.** New fields get a zod `.default(...)`, so every record already stored still parses.
   Records carry `schemaVersion` (`site/server/domain/types.ts`).
2. **Expand, migrate, contract.**
   1. Ship code that reads the old and new shapes.
   2. Run a migration that rewrites records.
   3. Only in a later release, remove the old-shape code.
3. **Migrations** live in `site/server/migrations/index.ts`:
   - numbered (`NNN-name`) and idempotent;
   - conditional writes (`setIfMatch`) so live traffic wins races;
   - never delete or rename keys.
   - Never edit or remove one that ran in production: the `config:migrations` ledger has it.
   - Every migration gets a test with fixture records from older versions (`server/test/data-safety.test.ts`).
4. **Deletes are soft.** Deleting an account and resetting progress both write a `trash:` entry first. It can
   be restored from the admin panel for 7 days (Recently deleted). Restores never overwrite newer data.
5. **Answer keys are data too.** Changing a released case's answers, points or hint costs re-scores players
   mid-case. `deploy.sh` refuses such a deploy unless you reset the case or pass `--accept-answer-changes`.

## Runbook

All commands run from the repo root and need `~/.netlify-token` (or `NETLIFY_AUTH_TOKEN`) and the linked
site (`.netlify/state.json`). Everything is a dry run unless you pass `--apply`.

```bash
# Snapshot production to ~/.incidentlab-backups/ (read-only on production)
node --experimental-strip-types scripts/data.ts backup

# Daily snapshots kept in the backup store
node --experimental-strip-types scripts/data.ts list-backups

# What would a restore change? (dry run), then do it (takes a pre-restore backup first)
node --experimental-strip-types scripts/data.ts restore ~/.incidentlab-backups/<file>.json
node --experimental-strip-types scripts/data.ts restore daily/2026-11-25.json --apply
#   --prune also deletes keys created after the snapshot (exact rollback). Use with care.

# Pending migrations: dry run, then apply (takes a pre-migrate backup first)
node --experimental-strip-types scripts/data.ts migrate
node --experimental-strip-types scripts/data.ts migrate --apply
```

`./scripts/deploy.sh` does the safe sequence for you:
1. Build, including all tests and solvers.
2. Check for answer-key drift.
3. **Back up production, and abort if the backup fails.**
4. Deploy.
5. Check migrations; apply them only with `--migrate`.

## Recovering from a bad deploy

1. `scripts/data.ts list-backups` and the files in `~/.incidentlab-backups/`: pick the last good snapshot
   (the `pre-deploy` one from the bad deploy is ideal).
2. `scripts/data.ts restore <snapshot>` (dry run). Read the add/overwrite list.
3. Redeploy the previous good commit (`git checkout <sha> && ./scripts/deploy.sh`), then
   `scripts/data.ts restore <snapshot> --apply`.
4. Add `--prune` only if keys written by the bad version must go.

## Tests

`cd site && npm run test:server` covers:
- migrations: idempotency, dry runs, the legacy import;
- the backup → wipe → restore round trip (with and without prune);
- daily rotation;
- soft delete and restore, including conflict and expiry;
- the shared case schemas against the real case files and `secrets.json`, and answer normalization against
  the shared vectors.

CI runs them on every PR.
