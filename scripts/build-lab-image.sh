#!/usr/bin/env bash
# Build one case's lab image from the PUBLIC evidence zip only, and prove it (#147, #148).
#
#   scripts/build-lab-image.sh <case-id>
#
# Needs `scripts/build-all.sh` first (it writes build/evidence-zips/<id>-evidence.zip) and a working docker.
# Steps:
#   1. build the base image from lab/base/ (its context is that folder alone);
#   2. assemble a clean temporary context holding only lab/case.Dockerfile and the extracted public zip;
#   3. leak-gate the context, build the case image, then leak-gate what is really inside it at /case:
#      the files must equal the zip one for one, with no secret-looking names (scripts/lab_gate.py);
#   4. run the case's solver INSIDE the image against /case, with the solver and the answer key mounted
#      read-only for this check only (they are never part of an image).
# Env: BASE_TAG (default incidentlab/lab-base:local), CASE_TAG (default incidentlab/lab-<id>:local),
#      CASE_VERSION (default 1). Nothing is pushed: publishing is a separate workflow (#151).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_ID="${1:?usage: scripts/build-lab-image.sh <case-id>}"
[[ "$CASE_ID" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || { echo "[lab] invalid case id: $CASE_ID" >&2; exit 2; }
ZIP="$ROOT/build/evidence-zips/$CASE_ID-evidence.zip"
BASE_TAG="${BASE_TAG:-incidentlab/lab-base:local}"
CASE_TAG="${CASE_TAG:-incidentlab/lab-$CASE_ID:local}"
CASE_VERSION="${CASE_VERSION:-1}"
GATE="$ROOT/scripts/lab_gate.py"

[[ -f "$ZIP" ]] || { echo "[lab] $ZIP is missing: run scripts/build-all.sh first" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CTX="$WORK/context"   # the ONLY directory docker sees for the case image
mkdir -p "$CTX"

echo "[lab] 1/4 base image $BASE_TAG"
docker build --quiet --tag "$BASE_TAG" "$ROOT/lab/base" >/dev/null

echo "[lab] 2/4 clean context from $(basename "$ZIP")"
(cd "$WORK" && unzip -q "$ZIP")
mv "$WORK/$CASE_ID" "$CTX/case"
cp "$ROOT/lab/case.Dockerfile" "$CTX/Dockerfile"
python3 "$GATE" manifest "$CTX/case" > "$WORK/context.listing"
python3 "$GATE" check "$ZIP" "$WORK/context.listing"

echo "[lab] 3/4 case image $CASE_TAG"
docker build --quiet --tag "$CASE_TAG" \
  --build-arg "BASE=$BASE_TAG" --build-arg "CASE_ID=$CASE_ID" --build-arg "CASE_VERSION=$CASE_VERSION" \
  "$CTX" >/dev/null
docker run --rm --entrypoint sh "$CASE_TAG" -c 'cd /case && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum' > "$WORK/image.listing"
python3 "$GATE" check "$ZIP" "$WORK/image.listing"
# Nothing of the project may exist anywhere else in the image either.
if docker run --rm --entrypoint sh "$CASE_TAG" -c 'ls -d /solutions /build /truth /content-sealed /site 2>/dev/null' | grep -q .; then
  echo "[lab] FAIL: project folders found in the image" >&2
  exit 1
fi

echo "[lab] 4/4 solver inside the image"
if [[ "$CASE_ID" == "3am-outage" ]]; then SOLVER="solutions/solve.sh"; TRUTH="answers.json"; else SOLVER="solutions/$CASE_ID/solve.sh"; TRUTH="$CASE_ID.answers.json"; fi
docker run --rm --network none \
  -v "$ROOT/solutions:/check/solutions:ro" -v "$ROOT/build/truth:/check/build/truth:ro" \
  -e "TRUTH=/check/build/truth/$TRUTH" \
  "$CASE_TAG" bash "/check/$SOLVER" /case | tee "$WORK/solver.out" | grep -E " (PASS|FAIL)" || true
if grep -q " FAIL" "$WORK/solver.out" || ! grep -q " PASS" "$WORK/solver.out"; then
  echo "[lab] FAIL: the solver did not pass inside the image" >&2
  exit 1
fi
echo "[lab] OK: $CASE_TAG holds exactly the public evidence, and the solver passes inside it"
