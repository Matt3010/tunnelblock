#!/bin/sh
set -eu

mkdir -p /rules

if [ ! -f /rules/block.txt ]; then
  cp /defaults/block.txt /rules/block.txt
fi

if [ ! -f /rules/allow.txt ]; then
  cp /defaults/allow.txt /rules/allow.txt
fi

# One-time migration: remove the four legacy MVP seed rules from existing installs.
# Preserve every other manual rule already stored in /rules/block.txt.
MIGRATION_MARKER="/rules/.legacy-seed-v1-removed"
if [ ! -f "$MIGRATION_MARKER" ]; then
  TMP="/rules/block.txt.migrate.$$"
  awk '
    $0 != "doubleclick.net" &&
    $0 != "googleadservices.com" &&
    $0 != "googlesyndication.com" &&
    $0 != "app-measurement.com"
  ' /rules/block.txt > "$TMP"
  mv "$TMP" /rules/block.txt
  touch "$MIGRATION_MARKER"
fi

exec npm start
