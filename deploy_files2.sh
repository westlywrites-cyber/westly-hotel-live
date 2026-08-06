#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="artifacts/Westly-Hotel"

declare -A FILES=(
  ["diagnostics.ts"]="src/lib/diagnostics.ts"
  ["firebase.ts"]="src/lib/firebase.ts"
)

BACKUP_DIR="_backup_$(date +%Y%m%d_%H%M%S)"

echo "── Step 1: verifying all source files exist at repo root ──"
missing=0
for src in "${!FILES[@]}"; do
  if [[ -f "$src" ]]; then
    echo "  ✔ found: $src"
  else
    echo "  ❌ missing: $src"
    missing=1
  fi
done

if [[ "$missing" -eq 1 ]]; then
  echo ""
  echo "❌ Aborting — one or more files are missing. Nothing was changed."
  exit 1
fi

if [[ ! -d "$APP_ROOT" ]]; then
  echo ""
  echo "❌ Aborting — '$APP_ROOT' does not exist. Nothing was changed."
  exit 1
fi

echo ""
echo "── Step 2: backing up any files about to be overwritten ──"
for src in "${!FILES[@]}"; do
  dest="$APP_ROOT/${FILES[$src]}"
  if [[ -f "$dest" ]]; then
    backup_path="$BACKUP_DIR/${FILES[$src]}"
    mkdir -p "$(dirname "$backup_path")"
    cp "$dest" "$backup_path"
    echo "  ✔ backed up: $dest → $backup_path"
  else
    echo "  – no existing file at $dest (nothing to back up)"
  fi
done

echo ""
echo "── Step 3: moving files into place ──"
for src in "${!FILES[@]}"; do
  dest="$APP_ROOT/${FILES[$src]}"
  mkdir -p "$(dirname "$dest")"
  if mv "$src" "$dest"; then
    echo "  ✔ moved: $src → $dest"
  else
    echo "  ❌ FAILED to move: $src → $dest"
  fi
done

echo ""
echo "── Done. Backups (if any) are in: $BACKUP_DIR/ ──"
