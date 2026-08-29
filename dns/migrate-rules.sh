#!/bin/sh
set -eu

RULES_DIR="${RULES_DIR:-/rules}"
BLOCK_FILE="$RULES_DIR/block.txt"
MIGRATION_MARKER="$RULES_DIR/.legacy-seed-v3-removed"

mkdir -p "$RULES_DIR"

if [ ! -f "$BLOCK_FILE" ]; then
  : > "$BLOCK_FILE"
fi

if [ ! -f "$MIGRATION_MARKER" ]; then
  TMP="$BLOCK_FILE.migrate.$$"

  awk '{ original=$0; normalized=$0; sub(/\r$/, "", normalized); gsub(/^[ \t]+|[ \t]+$/, "", normalized); if (normalized != "doubleclick.net" && normalized != "googleadservices.com" && normalized != "googlesyndication.com" && normalized != "app-measurement.com") print original }' "$BLOCK_FILE" > "$TMP"

  mv "$TMP" "$BLOCK_FILE"
  touch "$MIGRATION_MARKER"
fi
