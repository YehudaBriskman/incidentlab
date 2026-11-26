#!/usr/bin/env bash
# Full IncidentLab build: generators (3am-outage + generator/cases/*) -> server answer keys -> evidence zips
# -> case packages (build/packages/, checked) -> solver test -> site -> server tests.
# Usage: ./scripts/build-all.sh [--no-site | --evidence-only | --e2e-prep]
#   --no-site        everything except the site build and its checks
#   --evidence-only  generators, answer keys and evidence zips only (what a lab image needs; CI lab jobs)
#   --e2e-prep       evidence, case packages and the site, without solvers, command checks or unit tests
#                    (what a local server for the e2e suite needs; CI e2e shards, which run beside the full build)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_SITE=1
MODE=full
USAGE="Usage: $0 [--no-site | --evidence-only | --e2e-prep]"
for arg in "$@"; do
  case "$arg" in
    --no-site) BUILD_SITE=0 ;;
    --evidence-only) MODE=evidence ;;
    --e2e-prep) MODE=e2e ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; echo "$USAGE" >&2; exit 2 ;;
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

shopt -s nullglob
CASE_BUILDERS=(generator/cases/*/build.py)
shopt -u nullglob
for builder in "${CASE_BUILDERS[@]}"; do
  banner "Generate case $(basename "$(dirname "$builder")")"
  "$PYTHON" "$builder"
done

banner "Answer keys -> server secrets (scripts/make_flags.py)"
"$PYTHON" scripts/make_flags.py

banner "Package evidence zips         (scripts/package.sh -> build/evidence-zips/)"
"$ROOT/scripts/package.sh"

if [[ "$MODE" == "evidence" ]]; then
  echo; echo "Done (--evidence-only): build/evidence, build/truth, build/evidence-zips"; exit 0
fi

banner "Package cases                (scripts/make_package.py -> build/packages/)"
"$PYTHON" scripts/make_package.py

banner "Check packages               (scripts/check-packages.mts)"
(cd site && { [[ -d node_modules ]] || npm ci || npm install; })
node --experimental-strip-types scripts/check-packages.mts

if [[ "$MODE" == "e2e" ]]; then
  banner "Build site                   (site: npm ci && npm run build)"
  (cd site && { npm ci || npm install; } && npm run build)
  echo; echo "Done (--e2e-prep): packages for the local server and site/dist"; exit 0
fi

banner "Test: official solver        (solutions/solve.sh)"
bash solutions/solve.sh
for builder in "${CASE_BUILDERS[@]}"; do
  case_id="$(basename "$(dirname "$builder")")"
  banner "Test: solver $case_id"
  bash "solutions/$case_id/solve.sh"
done

banner "Test: every command runs with stock tools only (scripts/check_commands.py)"
"$PYTHON" scripts/check_commands.py

if [[ "$BUILD_SITE" -eq 1 ]]; then
  banner "Build site                   (site: npm ci && npm run build)"
  (
    cd site
    npm ci || npm install
    npm run build
  )
  banner "Check: colour contrast, WCAG 2 + APCA (scripts/check-contrast.mts)"
  node --experimental-strip-types scripts/check-contrast.mts
  banner "Check: no case content, paid content or answers in the bundle (scripts/check-bundle.mjs)"
  node scripts/check-bundle.mjs
  if (cd site && node -e 'process.exit(require("./package.json").scripts?.["test:server"] ? 0 : 1)'); then
    banner "Test: server                 (site: npm run test:server)"
    (cd site && npm run test:server)
    banner "Test: client core            (site: npm run test:client)"
    (cd site && npm run test:client)
  else
    echo "[build-all] site has no test:server script; skipping server tests."
  fi
  echo
  echo "Done. Deploy with: ./scripts/deploy.sh"
else
  echo
  echo "Done (site build skipped: --no-site)."
fi
