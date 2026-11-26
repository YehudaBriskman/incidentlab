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
#      CASE_VERSION (default 1).
# Publishing (#151, run by the IncidentsLab/labs workflow, never by this repo's CI):
#      BASE_FROM_REGISTRY=1  pull BASE_TAG (already pushed for every platform) instead of building it, so the
#                            gated image and the pushed ones share the exact published base;
#      PUSH=1                after the checks, push CASE_TAG (and EXTRA_TAGS, space-separated) for PLATFORMS
#                            (default linux/amd64,linux/arm64) from the SAME vetted context, then pull every
#                            pushed platform back and run the leak gate on it again.
#      SOURCE_URL            the org.opencontainers.image.source label (links the package to its repo).
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

if [[ "${BASE_FROM_REGISTRY:-0}" == "1" ]]; then
  echo "[lab] 1/4 base image $BASE_TAG (from the registry)"
  docker pull --quiet --platform linux/amd64 "$BASE_TAG" >/dev/null
else
  echo "[lab] 1/4 base image $BASE_TAG"
  docker build --quiet --tag "$BASE_TAG" "$ROOT/lab/base" >/dev/null
fi

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

[[ "${PUSH:-0}" == "1" ]] || exit 0

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
echo "[lab] push $CASE_TAG ${EXTRA_TAGS:-} for $PLATFORMS"
tags=(--tag "$CASE_TAG")
for t in ${EXTRA_TAGS:-}; do tags+=(--tag "$t"); done
labels=()
[[ -n "${SOURCE_URL:-}" ]] && labels+=(--label "org.opencontainers.image.source=$SOURCE_URL")
docker buildx build --quiet --push --platform "$PLATFORMS" "${tags[@]}" "${labels[@]}" \
  --build-arg "BASE=$BASE_TAG" --build-arg "CASE_ID=$CASE_ID" --build-arg "CASE_VERSION=$CASE_VERSION" \
  "$CTX" >/dev/null
# What a player pulls is what was checked: every pushed platform goes through the gate again.
for platform in ${PLATFORMS//,/ }; do
  docker run --rm --pull always --platform "$platform" --entrypoint sh "$CASE_TAG" \
    -c 'cd /case && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum' > "$WORK/pushed.listing"
  python3 "$GATE" check "$ZIP" "$WORK/pushed.listing"
  echo "[lab] pushed $platform passes the gate"
done
echo "[lab] OK: pushed $CASE_TAG"
