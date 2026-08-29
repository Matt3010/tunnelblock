#!/bin/sh
set -eu

mkdir -p /rules

if [ ! -f /rules/block.txt ]; then
  cp /defaults/block.txt /rules/block.txt
fi

if [ ! -f /rules/allow.txt ]; then
  cp /defaults/allow.txt /rules/allow.txt
fi

/migrate-rules.sh

exec npm start
