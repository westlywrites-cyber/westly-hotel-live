#!/bin/bash
# Moves Phase 1 files from the repo root into artifacts/Westly-Hotel/,
# backing up anything that would be overwritten first.
#
# Run this from the repo root in Replit's shell:
#   bash deploy_phase1_files.sh

set -euo pipefail

APP_ROOT="artifacts/Westly-Hotel"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="_backup_${TIMESTAMP}"

# source_filename_at_root => destination_path_under_APP_ROOT
declare -A FILES=(
  ["DEPLOYMENT.md"]="DEPLOYMENT.md"
  ["_headers"]="public/_headers"
  ["_redirects"]="public/_redirects"
  ["housekeepingSchedule.ts"]="src/lib/housekeepingSchedule.ts"
  ["housekeeping.ts"]="src/lib/housekeeping.ts"
  ["notifications.ts"]="src/lib/notifications.ts"
  ["auth.ts"]="src/lib/auth.ts"
  ["admin.ts"]="functions/_shared/admin.ts"
)

echo "== Step 1: verifying all source files exist at repo root =="
missing=0
for src in "${!FILES[@]}"; do
  if [ -f "$src" ]; then
    echo "  ✔ found: $src"
  else
    echo "  ❌ MISSING: $src"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "❌ Aborting — one or more files are missing at the repo root. Nothing was changed."
  exit 1
fi

echo ""
echo "== Step 2: backing up any files that will be overwritten =="
for src in "${!FILES[@]}"; do
  dest="${APP_ROOT}/${FILES[$src]}"
  if [ -f "$dest" ]; then
    backup_path="${BACKUP_DIR}/${FILES[$src]}"
    mkdir -p "$(dirname "$backup_path")"
    cp "$dest" "$backup_path"
    echo "  ✔ backed up: $dest -> $backup_path"
  else
    echo "  – no existing file at $dest, nothing to back up"
  fi
done

echo ""
echo "== Step 3: moving files into place =="
overall_ok=1
for src in "${!FILES[@]}"; do
  dest="${APP_ROOT}/${FILES[$src]}"
  mkdir -p "$(dirname "$dest")"
  if mv "$src" "$dest"; then
    echo "  ✔ moved: $src -> $dest"
  else
    echo "  ❌ FAILED to move: $src -> $dest"
    overall_ok=0
  fi
done

echo ""
if [ "$overall_ok" -eq 1 ]; then
  echo "✔ Done. All files moved. Backups (if any) are in: ${BACKUP_DIR}/"
else
  echo "❌ Some files failed to move — check the ❌ lines above. Backups (if any) are in: ${BACKUP_DIR}/"
fi
