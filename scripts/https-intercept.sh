#!/bin/sh
set -eu

ACTION="${1:-status}"

case "$ACTION" in
  enable)
    CID="$(docker compose ps -q mitmproxy)"
    if [ -z "$CID" ]; then
      echo "mitmproxy container is not running." >&2
      exit 2
    fi

    STATE="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || true)"
    if [ "$STATE" != "healthy" ]; then
      echo "mitmproxy must be healthy before enabling interception (current: ${STATE:-unknown})." >&2
      exit 3
    fi
    ;;
  disable|status)
    ;;
  *)
    echo "Usage: $0 {enable|disable|status}" >&2
    exit 2
    ;;
esac

docker compose exec -T wireguard /app/phase2-firewall.sh https "$ACTION"
