#!/usr/bin/env bash
# Zip the generated evidence pack into the site's public folder.
# Result: site/public/evidence/3am-outage-evidence.zip with a top-level `3am-outage/` folder.
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

mkdir -p "$OUT_DIR"
rm -f "$OUT"

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
