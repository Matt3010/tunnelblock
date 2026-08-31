#!/bin/sh
set -eu

ACTION="${1:-status}"

cleanup() {
  sh scripts/https-intercept.sh disable >/dev/null 2>&1 || true
  sh scripts/quic.sh allow >/dev/null 2>&1 || true
}

container_id() {
  docker compose --profile https-lab ps -q mitmproxy 2>/dev/null || true
}

case "$ACTION" in
  enable)
    cleanup
    if ! OBSERVATION_LOG_ENABLED=false \
      UMP_DIAGNOSTICS_ENABLED=false \
      YOUTUBE_UMP_FILTER_ENABLED=true \
      sh scripts/https-intercept.sh enable; then
      cleanup
      exit 1
    fi
    if ! sh scripts/quic.sh block; then
      cleanup
      exit 1
    fi
    echo "YouTube preroll request test: enabled (automatic one-shot)"
    echo "Persistent traffic logging: disabled"
    ;;
  disable)
    cleanup
    echo "YouTube UMP filter: disabled; HTTPS interception disabled; QUIC allowed"
    ;;
  status)
    CID="$(container_id)"
    if [ -z "$CID" ]; then
      echo "YouTube preroll request test: disabled"
    else
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
        | sed -n '/^YOUTUBE_UMP_FILTER_ENABLED=/p;/^OBSERVATION_LOG_ENABLED=/p'
    fi
    ;;
  *)
    echo "Usage: $0 {enable|disable|status}" >&2
    exit 2
    ;;
esac
