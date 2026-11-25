#!/usr/bin/env bash
# Build everything and deploy IncidentLab to Netlify (static site + /api Function).
#
# Requires: NETLIFY_AUTH_TOKEN in the environment, or a token in ~/.netlify-token.
# The repo root must already be linked to the Netlify site (.netlify/state.json).
#
# On first deploy it creates the ADMIN_KEY env var on the site (production context) and stores a
# copy in ~/.incidentlab-admin-key (mode 600). The key is never printed.
#
# Usage: ./scripts/deploy.sh
set -euo pipefail

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

echo "[deploy] deploying site/dist + site/netlify/functions"
"${NETLIFY[@]}" deploy --prod --dir=site/dist --functions=site/netlify/functions
echo "[deploy] done. Admin dashboard: <site-url>/#/admin (key in $KEY_FILE)"
