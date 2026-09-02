#!/bin/sh
set -eu

ACTION="${1:-status}"
INTEGRATION="${2:-}"
MODE="${3:-observe}"
STATE_FILE="./data/https/runtime-state.json"

write_state() {
  ACTIVE="$1"
  ID="$2"
  CURRENT_MODE="$3"
  mkdir -p "$(dirname "$STATE_FILE")"
  TMP="$STATE_FILE.tmp.$$"
  if [ "$ACTIVE" = "true" ]; then
    printf '{"active":true,"integration":"%s","mode":"%s","startedAt":"%s"}\n'       "$ID" "$CURRENT_MODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMP"
  else
    printf '{"active":false,"integration":null,"mode":"disabled","startedAt":null}\n' >"$TMP"
  fi
  mv -f "$TMP" "$STATE_FILE"
}

proxy_state() {
  CID="$(docker compose --profile https-lab ps -q https-proxy 2>/dev/null || true)"
  if [ -z "$CID" ]; then
    printf '%s' "stopped"
    return
  fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || printf '%s' "unknown"
}

wait_proxy() {
  for _ in $(seq 1 60); do
    STATE="$(proxy_state)"
    if [ "$STATE" = "healthy" ]; then
      return 0
    fi
    if [ "$STATE" = "exited" ] || [ "$STATE" = "dead" ]; then
      break
    fi
    sleep 1
  done
  docker compose --profile https-lab logs --tail=100 https-proxy >&2 || true
  return 1
}

cleanup_runtime() {
  docker compose exec -T wireguard /app/https-firewall.sh interception disable >/dev/null 2>&1 || true
  docker compose exec -T wireguard /app/https-firewall.sh quic allow >/dev/null 2>&1 || true
  docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
}

case "$ACTION" in
  start)
    case "$INTEGRATION" in
      ""|*[!a-z0-9_-]*)
        echo "Invalid integration id." >&2
        exit 2
        ;;
    esac
    if [ "$MODE" != "observe" ]; then
      echo "Invalid HTTPS strategy mode." >&2
      exit 2
    fi
    if [ "$(sh scripts/https-ca.sh status)" != "ready" ]; then
      echo "CA not ready. Prepare and install the CA before starting HTTPS inspection." >&2
      exit 3
    fi

    cleanup_runtime
    if ! HTTPS_ACTIVE_STRATEGY="$INTEGRATION" HTTPS_MODE="$MODE" \
      docker compose --profile https-lab up -d --force-recreate https-proxy; then
      cleanup_runtime
      write_state false "" disabled
      exit 4
    fi
    if ! wait_proxy; then
      cleanup_runtime
      write_state false "" disabled
      exit 5
    fi
    if ! docker compose exec -T wireguard /app/https-firewall.sh interception enable >/dev/null; then
      cleanup_runtime
      write_state false "" disabled
      exit 6
    fi
    if ! docker compose exec -T wireguard /app/https-firewall.sh quic block >/dev/null; then
      cleanup_runtime
      write_state false "" disabled
      exit 7
    fi
    write_state true "$INTEGRATION" "$MODE"
    echo "started"
    ;;
  stop)
    cleanup_runtime
    write_state false "" disabled
    echo "stopped"
    ;;
  reset-state)
    write_state false "" disabled
    echo "reset"
    ;;
  status)
    if [ -s "$STATE_FILE" ]; then
      cat "$STATE_FILE"
    else
      printf '{"active":false,"integration":null,"mode":"disabled","startedAt":null}\n'
    fi
    ;;
  *)
    echo "Usage: $0 {start <integration> [observe]|stop|status|reset-state}" >&2
    exit 2
    ;;
esac
