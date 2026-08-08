#!/usr/bin/env bash
# move_files.sh — safely move root-uploaded files into artifacts/Westly-Hotel/
#
# Usage: run this from the repo root (~/workspace), where the flat files
# were uploaded and where this script itself should also live.
#
#   bash move_files.sh
#
# Does NOT touch git, does NOT deploy, does NOT delete anything beyond the
# normal effect of `mv` (removing the file from its old flat location once
# it's safely copied to its new one). Nothing runs until every listed
# source file is confirmed present.

set -u  # treat unset vars as errors; deliberately NOT using -e so we can
        # report per-file ✔/❌ instead of dying on the first failure

APP_ROOT="artifacts/Westly-Hotel"
BACKUP_DIR="_backup_$(date +%Y%m%d_%H%M%S)"

# ── Edit this list for future runs ──────────────────────────────────────
# Format: "flat_root_filename|relative/path/under/artifacts/Westly-Hotel"
MAPPING=(
  "roomLogic.ts|src/lib/roomLogic.ts"
  "roomLogic.test.ts|src/lib/roomLogic.test.ts"
  "BookingPage.tsx|src/pages/public/BookingPage.tsx"
  "WalkInPage.tsx|src/pages/admin/WalkInPage.tsx"
  "supabaseAdmin.ts|functions/_shared/supabaseAdmin.ts"
  "messages-list.ts|functions/api/messages-list.ts"
  "messages-update.ts|functions/api/messages-update.ts"
  "media-upload.ts|functions/api/media-upload.ts"
  "media-delete.ts|functions/api/media-delete.ts"
  "adminApi.ts|src/lib/adminApi.ts"
  "messages.ts|src/lib/messages.ts"
  "storage.ts|src/lib/storage.ts"
  "schema.sql|supabase/schema.sql"
  "storage.sql|supabase/storage.sql"
  "DEPLOYMENT.md|DEPLOYMENT.md"
)
# ─────────────────────────────────────────────────────────────────────────

echo "── Step 1: verifying every source file exists at repo root ──"
missing=()
for entry in "${MAPPING[@]}"; do
  src="${entry%%|*}"
  if [ ! -f "$src" ]; then
    echo "  ❌ missing: $src"
    missing+=("$src")
  else
    echo "  ✔ found:   $src"
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo ""
  echo "❌ ABORTING — ${#missing[@]} file(s) missing from repo root. Nothing was changed."
  echo "Missing: ${missing[*]}"
  exit 1
fi

if [ ! -d "$APP_ROOT" ]; then
  echo ""
  echo "❌ ABORTING — app root '$APP_ROOT' does not exist. Nothing was changed."
  exit 1
fi

echo ""
echo "All source files present. Proceeding."
echo ""

echo "── Step 2 & 3: backing up (if needed) and moving each file ──"
fail_count=0
for entry in "${MAPPING[@]}"; do
  src="${entry%%|*}"
  rel="${entry#*|}"
  dest="$APP_ROOT/$rel"

  # Back up the existing destination file, if one exists, preserving its
  # subfolder path under the timestamped backup dir.
  if [ -f "$dest" ]; then
    backup_path="$BACKUP_DIR/$rel"
    if mkdir -p "$(dirname "$backup_path")" && cp "$dest" "$backup_path"; then
      echo "  ✔ backed up: $dest -> $backup_path"
    else
      echo "  ❌ FAILED to back up: $dest — skipping this file, NOT overwriting it"
      fail_count=$((fail_count + 1))
      continue
    fi
  fi

  # Move the new file into place.
  if mkdir -p "$(dirname "$dest")" && mv "$src" "$dest"; then
    echo "  ✔ moved: $src -> $dest"
  else
    echo "  ❌ FAILED to move: $src -> $dest"
    fail_count=$((fail_count + 1))
  fi
done

echo ""
echo "── Summary ──"
if [ "$fail_count" -eq 0 ]; then
  echo "✔ All ${#MAPPING[@]} files moved successfully."
  if [ -d "$BACKUP_DIR" ]; then
    echo "  Backups of anything overwritten are in: $BACKUP_DIR/"
  else
    echo "  No existing files were overwritten, so no backup folder was created."
  fi
else
  echo "❌ $fail_count file(s) failed — see ❌ lines above. Everything else succeeded normally."
fi