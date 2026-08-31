#!/bin/sh
set -eu

ACTION="${1:-status}"
LABEL="${2:-}"

cleanup() {
  sh scripts/https-intercept.sh disable >/dev/null 2>&1 || true
  sh scripts/quic.sh allow >/dev/null 2>&1 || true
}

container_id() {
  docker compose --profile https-lab ps -q mitmproxy 2>/dev/null || true
}

case "$ACTION" in
  start)
    cleanup
    SESSION="decision-$(date -u +%Y%m%dT%H%M%SZ)"
    if ! OBSERVATION_SESSION="$SESSION" \
      PROTOBUF_DECISION_DIAGNOSTICS_ENABLED=true \
      PROTOBUF_BLOCKING_ENABLED=false \
      PROTOBUF_BLOCK_FIELD_TAGS= \
      sh scripts/https-intercept.sh enable; then
      cleanup
      exit 1
    fi
    if ! sh scripts/quic.sh block; then
      cleanup
      exit 1
    fi
    "$0" mark session-start
    echo "Decision capture: enabled ($SESSION)"
    echo "Blocking/mutation: disabled"
    ;;
  mark)
    case "$LABEL" in
      session-start|ad-video-selected|control-video-selected|ad-start|content-start|second-ad-start|test-end) ;;
      *) echo "Invalid label." >&2; exit 2 ;;
    esac
    CID="$(container_id)"
    [ -n "$CID" ] || { echo "Decision capture is not running." >&2; exit 1; }
    docker exec -e CAPTURE_LABEL="$LABEL" "$CID" python -c \
      'import json,os; from datetime import datetime,timezone; p=os.environ["OBSERVATION_LOG"]; r={"ts":datetime.now(timezone.utc).isoformat(),"event":"experiment_marker","session":os.environ.get("OBSERVATION_SESSION",""),"label":os.environ["CAPTURE_LABEL"]}; open(p,"a",encoding="utf-8").write(json.dumps(r,separators=(",",":"))+"\n")' \
      2>/dev/null
    ;;
  stop)
    "$0" mark test-end || true
    cleanup
    echo "Decision capture: disabled; HTTPS interception disabled; QUIC allowed"
    ;;
  status)
    CID="$(container_id)"
    if [ -z "$CID" ]; then
      echo "Decision capture: disabled"
    else
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
        | sed -n '/^OBSERVATION_SESSION=/p;/^PROTOBUF_DECISION_DIAGNOSTICS_ENABLED=/p;/^PROTOBUF_BLOCKING_ENABLED=/p'
    fi
    ;;
  *)
    echo "Usage: $0 {start|mark <ad-video-selected|control-video-selected|ad-start|content-start|second-ad-start>|stop|status}" >&2
    exit 2
    ;;
esac
