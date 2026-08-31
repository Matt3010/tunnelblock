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
  run)
    [ -t 0 ] || { echo "Interactive terminal required." >&2; exit 2; }
    "$0" start
    trap 'cleanup' EXIT HUP INT TERM
    CID="$(container_id)"
    [ -n "$CID" ] || { echo "UMP capture failed to start." >&2; exit 1; }
    RUN_CODE=0
    docker exec -i "$CID" python -c '
import json
import os
from datetime import datetime, timezone

path = os.environ["OBSERVATION_LOG"]
session = os.environ.get("OBSERVATION_SESSION", "")

def mark(label):
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "experiment_marker",
        "session": session,
        "label": label,
    }
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")

steps = (
    ("ad-video-selected", "Invio, poi tocca subito il video CON pubblicità"),
    ("ad-start", "Invio appena inizia la pubblicità"),
    ("content-start", "Invio appena inizia il contenuto normale"),
    ("second-ad-start", "Invio se inizia un secondo ad; s + Invio se non compare", True),
    ("control-video-selected", "Invio, poi tocca subito un video SENZA pubblicità"),
    ("content-start", "Invio appena inizia il contenuto del video di controllo"),
)

print("Sessione pronta. Ogni Invio marca immediatamente la fase indicata.", flush=True)
for step in steps:
    label, prompt = step[0], step[1]
    answer = input(prompt + ": ")
    if len(step) == 3 and answer.strip().lower() == "s":
        print("Secondo ad saltato.", flush=True)
        continue
    mark(label)
    print("Marcato: " + label, flush=True)
mark("test-end")
' || RUN_CODE=$?
    cleanup
    trap - EXIT HUP INT TERM
    if [ "$RUN_CODE" -ne 0 ]; then
      echo "Interactive capture interrupted or failed." >&2
      exit "$RUN_CODE"
    fi
    echo "UMP capture: disabled; HTTPS interception disabled; QUIC allowed"
    echo "Ora esegui: python3 scripts/analyze-youtube-ump.py"
    ;;
  start)
    cleanup
    SESSION="ump-$(date -u +%Y%m%dT%H%M%SZ)"
    if ! OBSERVATION_SESSION="$SESSION" UMP_DIAGNOSTICS_ENABLED=true \
      sh scripts/https-intercept.sh enable; then
      cleanup
      exit 1
    fi
    if ! sh scripts/quic.sh block; then
      cleanup
      exit 1
    fi
    "$0" mark session-start
    echo "UMP decision capture: enabled ($SESSION)"
    echo "Blocking/mutation: unavailable"
    ;;
  mark)
    case "$LABEL" in
      session-start|ad-video-selected|control-video-selected|ad-start|content-start|second-ad-start|test-end) ;;
      *) echo "Invalid label." >&2; exit 2 ;;
    esac
    CID="$(container_id)"
    [ -n "$CID" ] || { echo "UMP capture is not running." >&2; exit 1; }
    docker exec -e CAPTURE_LABEL="$LABEL" "$CID" python -c \
      'import json,os; from datetime import datetime,timezone; p=os.environ["OBSERVATION_LOG"]; r={"ts":datetime.now(timezone.utc).isoformat(),"event":"experiment_marker","session":os.environ.get("OBSERVATION_SESSION",""),"label":os.environ["CAPTURE_LABEL"]}; open(p,"a",encoding="utf-8").write(json.dumps(r,separators=(",",":"))+"\n")' \
      2>/dev/null
    ;;
  stop)
    "$0" mark test-end || true
    cleanup
    echo "UMP capture: disabled; HTTPS interception disabled; QUIC allowed"
    ;;
  status)
    CID="$(container_id)"
    if [ -z "$CID" ]; then
      echo "UMP capture: disabled"
    else
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
        | sed -n '/^OBSERVATION_SESSION=/p;/^UMP_DIAGNOSTICS_ENABLED=/p'
    fi
    ;;
  *)
    echo "Usage: $0 {run|start|mark <ad-video-selected|control-video-selected|ad-start|content-start|second-ad-start>|stop|status}" >&2
    exit 2
    ;;
esac
