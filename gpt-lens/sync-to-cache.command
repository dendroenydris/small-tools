#!/bin/zsh
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="/Users/celes/Documents/Personal/AppConfig/cache/gpt-lens"

if [[ "$SOURCE_DIR" == "$TARGET_DIR" ]]; then
  echo "GPT Lens is already in: $TARGET_DIR"
  exit 0
fi

mkdir -p "$TARGET_DIR"
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude 'sync-to-cache.command' \
  "$SOURCE_DIR/" "$TARGET_DIR/"

# Keep a copy of the helper in the cache folder for future manual use.
cp "$SOURCE_DIR/sync-to-cache.command" "$TARGET_DIR/sync-to-cache.command"
chmod +x "$TARGET_DIR/sync-to-cache.command"

echo "Synced GPT Lens to: $TARGET_DIR"
echo "Chrome → chrome://extensions → Developer mode → Load unpacked → $TARGET_DIR"
