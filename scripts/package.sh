#!/usr/bin/env bash
# Zip the generated evidence pack into the site's public folder.
# Result: site/public/evidence/3am-outage-evidence.zip with a top-level `3am-outage/` folder,
# plus every evidence file (except the git bundle) under site/public/evidence/files/ for the
# in-browser Evidence Explorer. Before zipping, the repo history is exported to repo/git-log.txt
# so players without git can still read it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_ID="3am-outage"
SRC_PARENT="$ROOT/build/evidence"
OUT_DIR="$ROOT/site/public/evidence"
OUT="$OUT_DIR/${CASE_ID}-evidence.zip"

if [[ ! -d "$SRC_PARENT/$CASE_ID" ]]; then
  echo "[package] ERROR: $SRC_PARENT/$CASE_ID not found. Run the generators first." >&2
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "[package] ERROR: 'zip' is not installed." >&2
  exit 1
fi

REPO_DIR="$ROOT/build/repo/shipfast-checkout"
EV_DIR="$SRC_PARENT/$CASE_ID"
FILES_DIR="$OUT_DIR/files"

# Plain-text git history (no git needed on the player's machine).
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "[package] ERROR: $REPO_DIR is not a git repo. Run generator/build_repo.py first." >&2
  exit 1
fi
mkdir -p "$EV_DIR/repo"
git -C "$REPO_DIR" log -p --decorate --all --date=iso >"$EV_DIR/repo/git-log.txt"
echo "[package] wrote ${EV_DIR#"$ROOT"/}/repo/git-log.txt ($(wc -l <"$EV_DIR/repo/git-log.txt" | tr -d ' ') lines)"

mkdir -p "$OUT_DIR"
rm -f "$OUT"

# Loose copies for the browser Explorer (same relative paths; the .bundle is binary, skip it).
rm -rf "$FILES_DIR"
(
  cd "$EV_DIR"
  find . -type f ! -name '*.bundle' -print | LC_ALL=C sort | while IFS= read -r f; do
    mkdir -p "$FILES_DIR/$(dirname "$f")"
    cp "$f" "$FILES_DIR/$f"
  done
)
echo "[package] copied $(find "$FILES_DIR" -type f | wc -l | tr -d ' ') files to ${FILES_DIR#"$ROOT"/}/"

# Deterministic-ish: sorted file list, no extra attributes (-X), fixed mtimes.
(
  cd "$SRC_PARENT"
  find "$CASE_ID" -exec touch -h -d '2026-11-13 08:00:00 UTC' {} + 2>/dev/null || true
  find "$CASE_ID" -type f -print | LC_ALL=C sort | zip -q -X -9 "$OUT" -@
)

SIZE_BYTES=$(wc -c <"$OUT" | tr -d ' ')
SIZE_HUMAN=$(du -h "$OUT" | cut -f1)
FILES=$(unzip -Z1 "$OUT" 2>/dev/null | wc -l | tr -d ' ' || echo "?")
echo "[package] wrote ${OUT#"$ROOT"/} (${SIZE_HUMAN}, ${SIZE_BYTES} bytes, ${FILES} files)"
