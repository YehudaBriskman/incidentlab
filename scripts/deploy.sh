#!/usr/bin/env bash
# Build everything and deploy IncidentLab to Netlify (static site + /api Function).
#
# Requires: NETLIFY_AUTH_TOKEN in the environment, or a token in ~/.netlify-token.
# The repo root must already be linked to the Netlify site (.netlify/state.json).
#
# On first deploy it creates the ADMIN_KEY env var on the site (production context) and stores a
# copy in ~/.incidentlab-admin-key (mode 600). The key is never printed.
#
# Production data safety (docs/DATA.md):
#   1. refuses to deploy if a released case's answers/points changed since the last deploy
#      (players mid-case would be scored against a different key) unless --accept-answer-changes;
#   2. takes a full backup of the production store to ~/.incidentlab-backups/ BEFORE deploying,
#      and aborts if the backup fails;
#   3. after deploying, checks for pending data migrations and applies them only with --migrate
#      (the new code reads old and new shapes, so deploying first is safe).
#
# Usage: ./scripts/deploy.sh [--migrate] [--accept-answer-changes]
set -euo pipefail

RUN_MIGRATIONS=0
ACCEPT_ANSWER_CHANGES=0
for arg in "$@"; do
  case "$arg" in
    --migrate) RUN_MIGRATIONS=1 ;;
    --accept-answer-changes) ACCEPT_ANSWER_CHANGES=1 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETLIFY=(npx -y netlify-cli@17)
KEY_FILE="$HOME/.incidentlab-admin-key"
TOKEN_FILE="$HOME/.netlify-token"

if [[ -z "${NETLIFY_AUTH_TOKEN:-}" ]]; then
  if [[ -r "$TOKEN_FILE" ]]; then
    NETLIFY_AUTH_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  fi
fi
if [[ -z "${NETLIFY_AUTH_TOKEN:-}" ]]; then
  echo "[deploy] ERROR: set NETLIFY_AUTH_TOKEN or put a token in $TOKEN_FILE" >&2
  exit 1
fi
export NETLIFY_AUTH_TOKEN

if [[ ! -f "$ROOT/.netlify/state.json" ]]; then
  echo "[deploy] ERROR: repo is not linked to a Netlify site (.netlify/state.json missing). Run: ${NETLIFY[*]} link" >&2
  exit 1
fi

echo "[deploy] building (scripts/build-all.sh)"
"$ROOT/scripts/build-all.sh"

[[ -f "$ROOT/site/server/generated/secrets.json" ]] || { echo "[deploy] ERROR: site/server/generated/secrets.json missing" >&2; exit 1; }

# --- 1. answer-key drift ---
DEPLOYED_FP="$HOME/.incidentlab-deployed-fingerprints.json"
NEW_FP="$ROOT/build/truth/fingerprints.json"
if [[ -f "$DEPLOYED_FP" ]]; then
  changed="$(python3 -c '
import json,sys
old=json.load(open(sys.argv[1])); new=json.load(open(sys.argv[2]))
print(" ".join(sorted(c for c in old if c in new and old[c]!=new[c])))' "$DEPLOYED_FP" "$NEW_FP")"
  if [[ -n "$changed" && "$ACCEPT_ANSWER_CHANGES" -ne 1 ]]; then
    echo "[deploy] REFUSING: answers/points changed for released case(s): $changed" >&2
    echo "[deploy] Players mid-case would be scored against a different key. Reset those cases first, or re-run with --accept-answer-changes." >&2
    exit 1
  fi
  [[ -n "$changed" ]] && echo "[deploy] answer keys changed for: $changed (accepted)"
fi

# --- 2. backup production data before touching anything ---
echo "[deploy] backing up production data"
node --experimental-strip-types "$ROOT/scripts/data.ts" backup --reason pre-deploy || { echo "[deploy] ERROR: backup failed; not deploying" >&2; exit 1; }
[[ -d "$ROOT/site/netlify/functions" ]] || { echo "[deploy] ERROR: site/netlify/functions missing" >&2; exit 1; }

# --- ADMIN_KEY: ensure it exists on the site (never echo it) ---
echo "[deploy] checking ADMIN_KEY on the Netlify site"
existing="$("${NETLIFY[@]}" env:get ADMIN_KEY --context production 2>/dev/null || true)"
if [[ -z "$existing" || "$existing" == *"No value"* || "$existing" == *"not set"* || "$existing" == *"not found"* ]]; then
  echo "[deploy] ADMIN_KEY not set; generating a new one"
  new_key="$(openssl rand -hex 24)"
  "${NETLIFY[@]}" env:set ADMIN_KEY "$new_key" --context production >/dev/null
  umask 077
  printf '%s\n' "$new_key" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  unset new_key
  echo "[deploy] ADMIN_KEY set on the site (production). A copy is saved in $KEY_FILE (chmod 600)."
else
  if [[ -f "$KEY_FILE" ]]; then
    echo "[deploy] ADMIN_KEY already set on the site. Local copy: $KEY_FILE"
  else
    echo "[deploy] ADMIN_KEY already set on the site (no local copy at $KEY_FILE; read it with: netlify env:get ADMIN_KEY)"
  fi
fi
unset existing

BUILD_STAMP="$(sed -nE 's/.*<meta name="build" content="([^"]+)".*/\1/p' "$ROOT/site/dist/index.html" | head -n1)"
echo "[deploy] deploying site/dist + site/netlify/functions (build ${BUILD_STAMP:-unknown})"
"${NETLIFY[@]}" deploy --prod --dir=site/dist --functions=site/netlify/functions
echo "[deploy] live build: ${BUILD_STAMP:-unknown} (check: curl -s <site>/ | grep 'name=\"build\"')"
cp "$NEW_FP" "$DEPLOYED_FP"

# --- 3. data migrations ---
set +e
node --experimental-strip-types "$ROOT/scripts/data.ts" migrate --check
migrate_status=$?
set -e
if [[ "$migrate_status" -eq 3 ]]; then
  if [[ "$RUN_MIGRATIONS" -eq 1 ]]; then
    node --experimental-strip-types "$ROOT/scripts/data.ts" migrate --apply
  else
    echo "[deploy] NOTE: data migrations are pending. Review with: node --experimental-strip-types scripts/data.ts migrate"
    echo "[deploy]       then apply with: ./scripts/deploy.sh --migrate  (or: scripts/data.ts migrate --apply)"
  fi
elif [[ "$migrate_status" -ne 0 ]]; then
  echo "[deploy] WARNING: couldn't check data migrations (exit $migrate_status); the deploy itself succeeded" >&2
fi
echo "[deploy] done. Admin dashboard: <site-url>/#/admin (key in $KEY_FILE)"
