#!/usr/bin/env bash
# deploy_analytics_files.sh
#
# Moves the User Activity & Usage Analytics files from the repo root into
# artifacts/Westly-Hotel/, backing up anything it's about to overwrite first.
#
# Does NOT touch git in any way (no add/commit/push) and does NOT delete
# anything permanently — overwritten files are preserved in a timestamped
# backup folder, never removed.
#
# Usage:
#   bash deploy_analytics_files.sh

set -uo pipefail  # NOTE: deliberately not using -e — we want to finish the
                   # existence-check loop and report every missing file
                   # before deciding whether to abort, not stop at the first one.

BASE_DIR="artifacts/Westly-Hotel"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="_backup_${TIMESTAMP}"

# ── file → destination path (relative to $BASE_DIR) ─────────────────────────
# Format: "source_filename_at_repo_root|destination_relative_path"
FILES=(
  "analytics.ts|src/lib/analytics.ts"
  "useAnalytics.ts|src/hooks/useAnalytics.ts"
  "AnalyticsPage.tsx|src/pages/admin/AnalyticsPage.tsx"
  "main.tsx|src/main.tsx"
  "AuthContext.tsx|src/contexts/AuthContext.tsx"
  "App.tsx|src/App.tsx"
  "AdminShell.tsx|src/components/admin/AdminShell.tsx"
  "firestore.rules|firestore.rules"
  "database.rules.json|database.rules.json"
)

echo "════════════════════════════════════════════════════════════════"
echo " STEP 1/3 — Verifying every source file exists at repo root"
echo "════════════════════════════════════════════════════════════════"

missing=0
for entry in "${FILES[@]}"; do
  src="${entry%%|*}"
  if [ -f "$src" ]; then
    echo "  ✔ found: $src"
  else
    echo "  ❌ MISSING: $src"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo
  echo "❌ ABORTED — one or more files are missing at the repo root."
  echo "   Nothing was backed up or moved. Upload the missing file(s) and re-run."
  exit 1
fi

if [ ! -d "$BASE_DIR" ]; then
  echo
  echo "❌ ABORTED — destination base directory '$BASE_DIR' does not exist."
  echo "   Nothing was backed up or moved."
  exit 1
fi

echo
echo "All source files present. Proceeding."
echo

echo "════════════════════════════════════════════════════════════════"
echo " STEP 2/3 — Backing up any files about to be overwritten"
echo "════════════════════════════════════════════════════════════════"

for entry in "${FILES[@]}"; do
  dest_rel="${entry#*|}"
  dest_path="${BASE_DIR}/${dest_rel}"
  if [ -f "$dest_path" ]; then
    backup_path="${BACKUP_DIR}/${dest_rel}"
    mkdir -p "$(dirname "$backup_path")"
    if cp -p "$dest_path" "$backup_path"; then
      echo "  ✔ backed up: $dest_path -> $backup_path"
    else
      echo "  ❌ FAILED to back up: $dest_path"
      echo
      echo "❌ ABORTED — backup failed, no files were moved."
      exit 1
    fi
  else
    echo "  · no existing file at $dest_path (nothing to back up)"
  fi
done

echo
echo "════════════════════════════════════════════════════════════════"
echo " STEP 3/3 — Moving files into place"
echo "════════════════════════════════════════════════════════════════"

fail=0
for entry in "${FILES[@]}"; do
  src="${entry%%|*}"
  dest_rel="${entry#*|}"
  dest_path="${BASE_DIR}/${dest_rel}"
  mkdir -p "$(dirname "$dest_path")"
  if mv "$src" "$dest_path"; then
    echo "  ✔ moved: $src -> $dest_path"
  else
    echo "  ❌ FAILED to move: $src -> $dest_path"
    fail=1
  fi
done

echo
if [ "$fail" -eq 1 ]; then
  echo "⚠️  Completed with errors — check the ❌ lines above."
  echo "   Backups (if any were made) are in: $BACKUP_DIR"
  exit 1
else
  echo "✅ All files moved successfully."
  echo "   Backups of anything overwritten are in: $BACKUP_DIR"
fi
