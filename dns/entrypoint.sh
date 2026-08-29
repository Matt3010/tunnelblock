#!/bin/sh
set -eu

mkdir -p /rules

if [ ! -f /rules/block.txt ]; then
  cp /defaults/block.txt /rules/block.txt
fi

if [ ! -f /rules/allow.txt ]; then
  cp /defaults/allow.txt /rules/allow.txt
fi

# One-time v3 migration: remove the four legacy MVP seed rules from existing installs.
# BusyBox awk compatible. Preserve every other manual rule.
MIGRATION_MARKER="/rules/.legacy-seed-v3-removed"
if [ ! -f "$MIGRATION_MARKER" ]; then
  TMP="/rules/block.txt.migrate.$$"

  awk '{ original=$0; normalized=$0; sub(/\r$/, "", normalized); gsub(/^[ \t]+|[ \t]+$/, "", normalized); if (normalized != "doubleclick.net" && normalized != "googleadservices.com" && normalized != "googlesyndication.com" && normalized != "app-measurement.com") print original }' /rules/block.txt > "$TMP"

  mv "$TMP" /rules/block.txt
  touch "$MIGRATION_MARKER"
fi

exec npm start
