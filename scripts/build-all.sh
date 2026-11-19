#!/usr/bin/env bash
# Full IncidentLab build: generators -> flags -> evidence zip -> site.
# Usage: ./scripts/build-all.sh [--no-site]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_SITE=1
for arg in "$@"; do
  case "$arg" in
    --no-site) BUILD_SITE=0 ;;
    -h|--help) echo "Usage: $0 [--no-site]"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; echo "Usage: $0 [--no-site]" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
STEP=0
banner() {
  STEP=$((STEP + 1))
  echo
  echo "=================================================================="
  echo "  [$STEP] $*"
  echo "=================================================================="
}

banner "Build git repo + bundle      (generator/build_repo.py)"
"$PYTHON" generator/build_repo.py

banner "Generate nginx + app logs    (generator/gen_logs.py)"
"$PYTHON" generator/gen_logs.py

banner "Generate supporting evidence (generator/gen_support.py)"
"$PYTHON" generator/gen_support.py

banner "Hash flags                   (scripts/make_flags.py)"
"$PYTHON" scripts/make_flags.py

banner "Seal debrief                 (scripts/seal_debrief.mjs)"
node scripts/seal_debrief.mjs

banner "Package evidence zip         (scripts/package.sh)"
"$ROOT/scripts/package.sh"

if [[ "$BUILD_SITE" -eq 1 ]]; then
  banner "Build site                   (site: npm ci && npm run build)"
  (
    cd site
    npm ci || npm install
    npm run build
  )
  echo
  echo "Done. Deploy with: npx netlify-cli deploy --prod --dir=site/dist"
else
  echo
  echo "Done (site build skipped: --no-site)."
fi
