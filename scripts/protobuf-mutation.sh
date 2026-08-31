#!/bin/sh
set -eu

ACTION="${1:-status}"
FIELD="${2:-}"

observer_cid() {
  docker compose --profile https-lab ps -q mitmproxy 2>/dev/null || true
}

cleanup() {
  sh scripts/https-intercept.sh disable >/dev/null 2>&1 || true
  sh scripts/quic.sh allow >/dev/null 2>&1 || true
}

runtime_setting() {
  CID="$(observer_cid)"
  if [ -z "$CID" ]; then
    printf '%s\n' "stopped|false|"
    return
  fi

  BLOCKING="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
      | sed -n 's/^PROTOBUF_BLOCKING_ENABLED=//p' \
      | tail -n 1
  )"
  FIELDS="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
      | sed -n 's/^PROTOBUF_BLOCK_FIELD_TAGS=//p' \
      | tail -n 1
  )"

  printf '%s|%s|%s\n' "running" "${BLOCKING:-false}" "${FIELDS:-}"
}

enable_mutation() {
  case "$FIELD" in
    ''|*[!0-9]*)
      echo "Usage: $0 enable <field-number>" >&2
      exit 2
      ;;
  esac

  if [ "$FIELD" -le 1 ]; then
    echo "Field number must be greater than 1." >&2
    exit 2
  fi

  cleanup

  if ! PROTOBUF_BLOCKING_ENABLED=true \
    PROTOBUF_BLOCK_FIELD_TAGS="$FIELD" \
    sh scripts/https-intercept.sh enable; then
    cleanup
    echo "Failed to start structural protobuf mutation mode." >&2
    exit 1
  fi

  if ! sh scripts/quic.sh block; then
    cleanup
    echo "Failed to block QUIC; mutation mode was disabled." >&2
    exit 1
  fi

  SETTING="$(runtime_setting)"
  if [ "$SETTING" != "running|true|$FIELD" ]; then
    cleanup
    echo "Runtime mutation settings did not match the requested field." >&2
    exit 1
  fi

  echo "Protobuf structural mutation: enabled"
  echo "Target field: $FIELD"
  echo "Required markers: pagead + googleadservices"
  echo "HTTPS interception: enabled"
  echo "QUIC UDP/443: blocked"
}

case "$ACTION" in
  enable)
    enable_mutation
    ;;
  disable)
    cleanup
    echo "Protobuf structural mutation: disabled"
    echo "HTTPS interception: disabled"
    echo "QUIC UDP/443: allowed"
    ;;
  status)
    SETTING="$(runtime_setting)"
    STATE="${SETTING%%|*}"
    REST="${SETTING#*|}"
    BLOCKING="${REST%%|*}"
    FIELDS="${REST#*|}"

    if [ "$STATE" = "running" ] && [ "$BLOCKING" = "true" ] && [ -n "$FIELDS" ]; then
      echo "Protobuf structural mutation: enabled (field $FIELDS)"
    else
      echo "Protobuf structural mutation: disabled"
    fi
    ;;
  *)
    echo "Usage: $0 {enable <field-number>|disable|status}" >&2
    exit 2
    ;;
esac
