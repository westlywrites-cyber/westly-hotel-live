#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Moves files uploaded flat at the repo root into their correct paths under
# artifacts/Westly-Hotel/. Run this from the REPO ROOT (the folder that
# contains artifacts/Westly-Hotel/), not from inside artifacts/Westly-Hotel/
# itself.
#
# Safety behavior:
#   1. Verifies every listed source file exists at the root FIRST. If even
#      one is missing, it aborts before touching anything.
#   2. Any destination file that's about to be overwritten is backed up
#      first into a timestamped _backup_YYYYMMDD_HHMMSS/ folder, preserving
#      its original path under artifacts/Westly-Hotel/.
#   3. Only then does it move each file into place.
#   4. Prints a ✔ / ❌ line per file so you can see exactly what happened.
#
# This script does NOT run git, does NOT deploy, and does NOT delete
# anything outside the files it's explicitly told to move (old versions are
# preserved in the backup folder, never deleted).
# ══════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── file map: "source-file-at-root:destination-path" ────────────────────────
FILES=(
  "housekeepingBalance.ts:artifacts/Westly-Hotel/src/lib/housekeepingBalance.ts"
  "housekeepingBalance.test.ts:artifacts/Westly-Hotel/src/lib/housekeepingBalance.test.ts"
  "housekeeping.ts:artifacts/Westly-Hotel/src/lib/housekeeping.ts"
  "housekeepingQueue.ts:artifacts/Westly-Hotel/functions/_shared/housekeepingQueue.ts"
  "HousekeepingWorkloadCard.tsx:artifacts/Westly-Hotel/src/components/admin/HousekeepingWorkloadCard.tsx"
  "HousekeepingPage.tsx:artifacts/Westly-Hotel/src/pages/admin/HousekeepingPage.tsx"
  "firestore.indexes.json:artifacts/Westly-Hotel/firestore.indexes.json"
)

BACKUP_DIR="_backup_$(date +%Y%m%d_%H%M%S)"

echo "══════════════════════════════════════════════════════════════"
echo " Step 0: sanity check — are we in the repo root?"
echo "══════════════════════════════════════════════════════════════"
if [ ! -d "artifacts/Westly-Hotel" ]; then
  echo "❌ artifacts/Westly-Hotel/ not found under $(pwd)."
  echo "   Run this script from the repo root (cd there first), then re-run."
  exit 1
fi
echo "✔ artifacts/Westly-Hotel/ found."
echo ""

echo "══════════════════════════════════════════════════════════════"
echo " Step 1: verifying every source file exists at the repo root"
echo "══════════════════════════════════════════════════════════════"
missing=0
for pair in "${FILES[@]}"; do
  src="${pair%%:*}"
  if [ -f "$src" ]; then
    echo "✔ found:   $src"
  else
    echo "❌ missing: $src"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo " ❌ ABORTED — one or more files are missing at the root."
  echo "    Nothing was changed. Upload the missing file(s) and re-run."
  echo "══════════════════════════════════════════════════════════════"
  exit 1
fi

echo ""
echo "All source files present. Proceeding."
echo ""

echo "══════════════════════════════════════════════════════════════"
echo " Step 2: backing up existing files, then moving new ones into place"
echo "══════════════════════════════════════════════════════════════"
any_error=0
for pair in "${FILES[@]}"; do
  src="${pair%%:*}"
  dest="${pair#*:}"
  dest_dir=$(dirname "$dest")

  if [ -f "$dest" ]; then
    backup_path="$BACKUP_DIR/$dest"
    backup_dir=$(dirname "$backup_path")
    mkdir -p "$backup_dir"
    if cp -p "$dest" "$backup_path"; then
      echo "  📦 backed up: $dest -> $backup_path"
    else
      echo "❌ BACKUP FAILED for $dest — skipping this file to be safe (nothing moved for it)"
      any_error=1
      continue
    fi
  fi

  mkdir -p "$dest_dir"
  if mv "$src" "$dest"; then
    echo "✔ moved: $src -> $dest"
  else
    echo "❌ MOVE FAILED: $src -> $dest"
    any_error=1
  fi
done

echo ""
echo "══════════════════════════════════════════════════════════════"
if [ "$any_error" -eq 1 ]; then
  echo " ⚠ Finished WITH ERRORS — check the ❌ lines above."
  echo "   Any backups made are in: $BACKUP_DIR/"
  exit 1
else
  echo " ✅ All files moved successfully."
  if [ -d "$BACKUP_DIR" ]; then
    echo "   Previous versions backed up in: $BACKUP_DIR/"
  else
    echo "   (No pre-existing files were overwritten — nothing to back up.)"
  fi
fi
echo "══════════════════════════════════════════════════════════════"
