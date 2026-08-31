#!/bin/sh
set -eu

ACTION="${1:-status}"

case "$ACTION" in
  block|allow|status)
    ;;
  *)
    echo "Usage: $0 {block|allow|status}" >&2
    exit 2
    ;;
esac

docker compose exec -T wireguard /app/phase2-firewall.sh quic "$ACTION"
