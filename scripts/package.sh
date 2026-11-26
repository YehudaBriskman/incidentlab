#!/usr/bin/env bash
# Build every case's evidence zip, the download that goes into its case package.
# For each case <id> with build/evidence/<id>/:
#   build/evidence-zips/<id>-evidence.zip    the download (one top-level folder `<id>/`)
# scripts/make_package.py puts it into build/packages/<id>-v<n>.case.zip. Since #68 nothing is written under
# site/: evidence is served from the DB (the case package upload), never from the static site.
# Case 3am-outage also gets repo/git-log.txt exported from its generated git repo first.
# Usage: scripts/package.sh [case-id ...]   (default: every case under build/evidence/)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_PARENT="$ROOT/build/evidence"
OUT_DIR="$ROOT/build/evidence-zips"

if ! command -v zip >/dev/null 2>&1; then
  echo "[package] ERROR: 'zip' is not installed." >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  CASES=("$@")
else
  mapfile -t CASES < <(find "$SRC_PARENT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)
fi
[[ ${#CASES[@]} -gt 0 ]] || { echo "[package] ERROR: no cases under $SRC_PARENT. Run the generators first." >&2; exit 1; }

mkdir -p "$OUT_DIR"
# The pre-#68 static copy: if a checkout still has it, Vite would publish it with the site. Remove it.
rm -rf "$ROOT/site/public/evidence"

for CASE_ID in "${CASES[@]}"; do
  EV_DIR="$SRC_PARENT/$CASE_ID"
  [[ -d "$EV_DIR" ]] || { echo "[package] ERROR: $EV_DIR not found." >&2; exit 1; }
  [[ -f "$EV_DIR/README_FIRST.txt" ]] || { echo "[package] ERROR: $CASE_ID has no README_FIRST.txt" >&2; exit 1; }

  if [[ "$CASE_ID" == "3am-outage" ]]; then
    REPO_DIR="$ROOT/build/repo/shipfast-checkout"
    [[ -d "$REPO_DIR/.git" ]] || { echo "[package] ERROR: $REPO_DIR is not a git repo. Run generator/build_repo.py first." >&2; exit 1; }
    mkdir -p "$EV_DIR/repo"
    git -C "$REPO_DIR" log -p --decorate --all --date=iso >"$EV_DIR/repo/git-log.txt"
  fi

  OUT="$OUT_DIR/${CASE_ID}-evidence.zip"
  rm -f "$OUT"
  # Deterministic-ish: sorted file list, no extra attributes (-X), fixed mtimes.
  (
    cd "$SRC_PARENT"
    find "$CASE_ID" -exec touch -h -d '2026-11-13 08:00:00 UTC' {} + 2>/dev/null || true
    find "$CASE_ID" -type f -print | LC_ALL=C sort | zip -q -X -9 "$OUT" -@
  )
  echo "[package] $CASE_ID: $(du -h "$OUT" | cut -f1) zip"
done
