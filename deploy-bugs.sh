#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
APP_ROOT="artifacts/Westly-Hotel"
BACKUP_DIR="_backup_$(date +%Y%m%d_%H%M%S)"

# root filename -> destination path (relative to $APP_ROOT)
declare -A FILES=(
  ["bugTracker.ts"]="src/lib/bugTracker.ts"
  ["diagnostics.ts"]="src/lib/diagnostics.ts"
  ["BugManagementPage.tsx"]="src/pages/admin/BugManagementPage.tsx"
  ["useCriticalBugWatcher.ts"]="src/hooks/useCriticalBugWatcher.ts"
  ["notifications.ts"]="src/lib/notifications.ts"
  ["NotificationCenter.tsx"]="src/components/admin/NotificationCenter.tsx"
  ["AdminShell.tsx"]="src/components/admin/AdminShell.tsx"
  ["App.tsx"]="src/App.tsx"
  ["firestore.rules"]="firestore.rules"
  ["firestore.indexes.json"]="firestore.indexes.json"
)

sorted_keys() { printf '%s\n' "${!FILES[@]}" | sort; }

# ── Step 1: verify every listed file exists at root first ────────────────
echo "Step 1/4: checking that all listed files exist at repo root..."
missing=0
while IFS= read -r src; do
  if [[ -f "$src" ]]; then
    echo "  ✔ found: $src"
  else
    echo "  ❌ missing: $src"
    missing=1
  fi
done < <(sorted_keys)

if [[ "$missing" -eq 1 ]]; then
  echo ""
  echo "❌ Aborting — one or more files are missing. Nothing was changed."
  exit 1
fi
echo "✔ All files present."
echo ""

# ── Step 2: back up anything about to be overwritten ──────────────────────
echo "Step 2/4: backing up files that will be overwritten..."
any_backup=0
while IFS= read -r src; do
  dest="${APP_ROOT}/${FILES[$src]}"
  if [[ -f "$dest" ]]; then
    backup_path="${BACKUP_DIR}/${FILES[$src]}"
    mkdir -p "$(dirname "$backup_path")"
    cp -p "$dest" "$backup_path"
    echo "  ✔ backed up: $dest -> $backup_path"
    any_backup=1
  fi
done < <(sorted_keys)
[[ "$any_backup" -eq 0 ]] && echo "  (nothing to back up — no destination files existed yet)"
echo ""

# ── Step 3: move each file into place ─────────────────────────────────────
echo "Step 3/4: moving files into place..."
move_failed=0
while IFS= read -r src; do
  dest="${APP_ROOT}/${FILES[$src]}"
  mkdir -p "$(dirname "$dest")"
  if mv "$src" "$dest"; then
    echo "  ✔ $src -> $dest"
  else
    echo "  ❌ FAILED: $src -> $dest"
    move_failed=1
  fi
done < <(sorted_keys)
echo ""

# ── Step 4: summary ────────────────────────────────────────────────────────
echo "Step 4/4: summary"
if [[ "$move_failed" -eq 0 ]]; then
  echo "✔ All files moved successfully."
else
  echo "❌ Completed with at least one failure — check the ❌ lines above."
fi
if [[ "$any_backup" -eq 1 ]]; then
  echo "Backups saved under: $BACKUP_DIR/"
fi