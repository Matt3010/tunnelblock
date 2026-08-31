#!/bin/sh
set -eu

ACTION="${1:-status}"

observer_state() {
  CID="$(docker compose --profile https-lab ps -q mitmproxy 2>/dev/null || true)"
  if [ -z "$CID" ]; then
    printf '%s' "stopped"
    return
  fi

  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || printf '%s' "unknown"
}

start_observer() {
  docker compose --profile https-lab up -d --build mitmproxy

  for _ in $(seq 1 60); do
    STATE="$(observer_state)"
    if [ "$STATE" = "healthy" ]; then
      return 0
    fi
    if [ "$STATE" = "exited" ] || [ "$STATE" = "dead" ]; then
      break
    fi
    sleep 1
  done

  echo "mitmproxy failed to become healthy (current: $(observer_state))." >&2
  docker compose --profile https-lab logs --tail=100 mitmproxy >&2 || true
  return 1
}

case "$ACTION" in
  enable)
    start_observer
    docker compose exec -T wireguard /app/phase2-firewall.sh https enable
    ;;
  disable)
    docker compose exec -T wireguard /app/phase2-firewall.sh https disable
    docker compose --profile https-lab stop mitmproxy >/dev/null 2>&1 || true
    echo "mitmproxy: stopped"
    ;;
  status)
    echo "mitmproxy: $(observer_state)"
    docker compose exec -T wireguard /app/phase2-firewall.sh https status
    ;;
  *)
    echo "Usage: $0 {enable|disable|status}" >&2
    exit 2
    ;;
esac
