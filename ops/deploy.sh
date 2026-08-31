#!/bin/sh
set -u

cd /workspace

STATE_FILE="${UPDATER_STATE_FILE:-/updater-data/state.json}"
LOG_FILE="${UPDATER_LOG_FILE:-/updater-data/deploy.log}"
PREVIOUS_SHA="${PREVIOUS_SHA:?PREVIOUS_SHA is required}"
TARGET_SHA="${TARGET_SHA:?TARGET_SHA is required}"
DEPLOY_STARTED_AT="${DEPLOY_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

export UPDATER_STATE_FILE="$STATE_FILE"
export UPDATER_LOG_FILE="$LOG_FILE"
export PREVIOUS_SHA TARGET_SHA DEPLOY_STARTED_AT
export DEPLOY_SHA="$TARGET_SHA"

log() {
  printf '%s\n' "$*" >>"$LOG_FILE"
}

notify() {
  MESSAGE="$1"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || return 0
  [ -n "${TELEGRAM_ALLOWED_USER_IDS:-}" ] || return 0

  OLD_IFS="$IFS"
  IFS=','
  for CHAT_ID in $TELEGRAM_ALLOWED_USER_IDS; do
    IFS="$OLD_IFS"
    CHAT_ID="$(printf '%s' "$CHAT_ID" | tr -d ' ')"
    [ -n "$CHAT_ID" ] || continue
    curl -fsS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$CHAT_ID" \
      --data-urlencode "text=$MESSAGE" >/dev/null 2>&1 || true
    IFS=','
  done
  IFS="$OLD_IFS"
}

service_state() {
  SERVICE="$1"
  CID="$(docker compose ps -q --all "$SERVICE" 2>/dev/null || true)"
  if [ -z "$CID" ]; then
    printf '%s' "missing"
    return
  fi

  docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$CID" 2>/dev/null || printf '%s' "unknown"
}

wait_service() {
  SERVICE="$1"
  EXPECTED="$2"

  for i in $(seq 1 60); do
    STATE="$(service_state "$SERVICE")"
    if [ "$STATE" = "$EXPECTED" ]; then
      return 0
    fi
    sleep 1
  done

  log "ERROR: $SERVICE expected $EXPECTED, got $(service_state "$SERVICE")"
  docker compose ps --all "$SERVICE" >>"$LOG_FILE" 2>&1 || true
  docker compose logs --no-color --tail=120 "$SERVICE" >>"$LOG_FILE" 2>&1 || true
  return 1
}

verify_updater_revision() {
  EXPECTED_SHA="$1"
  CID="$(docker compose ps -q updater 2>/dev/null || true)"
  [ -n "$CID" ] || return 1

  docker exec "$CID" node -e '
    const expected = process.argv[1];
    fetch("http://127.0.0.1:8090/status", {
      headers: { authorization: "Bearer " + process.env.ADMIN_API_TOKEN }
    })
      .then(async response => {
        if (!response.ok) process.exit(2);
        const status = await response.json();
        process.exit(status.runtimeBuildSha === expected ? 0 : 3);
      })
      .catch(() => process.exit(4));
  ' "$EXPECTED_SHA"
}

verify_stack() {
  EXPECTED_SHA="$1"
  wait_service doh-a healthy || return 1
  wait_service doh-b healthy || return 1
  wait_service updater healthy || return 1
  wait_service doh-proxy running || return 1
  wait_service telegram-bot running || return 1
  wait_service wireguard healthy || return 1

  for i in $(seq 1 30); do
    if verify_updater_revision "$EXPECTED_SHA"; then
      return 0
    fi
    sleep 1
  done

  log "ERROR: updater runtimeBuildSha does not match expected $EXPECTED_SHA"
  docker compose logs --no-color --tail=120 updater >>"$LOG_FILE" 2>&1 || true
  return 1
}

deploy_target() (
  set -eu

  log "== Deploy $TARGET_SHA =="
  log "== Pre-flight: docker compose config =="
  docker compose config --quiet >>"$LOG_FILE" 2>&1
  docker compose --profile https-lab config --quiet >>"$LOG_FILE" 2>&1

  log "== Pre-flight: build complete stack =="
  docker compose build >>"$LOG_FILE" 2>&1
  docker compose --profile https-lab build mitmproxy >>"$LOG_FILE" 2>&1

  log "== Pre-flight: WireGuard/Phase-2 shell checks =="
  sh -n vpn/wireguard/entrypoint.sh vpn/wireguard/healthcheck.sh vpn/wireguard/show-client.sh vpn/wireguard/phase2-firewall.sh scripts/wireguard-client.sh scripts/https-intercept.sh scripts/quic.sh scripts/phase2-status.sh scripts/mitmproxy-ca.sh >>"$LOG_FILE" 2>&1

  log "== Pre-flight: DNS tests =="
  docker compose run --rm --no-deps --entrypoint npm doh-a test >>"$LOG_FILE" 2>&1

  log "== Pre-flight: TypeScript checks =="
  docker compose run --rm --no-deps --entrypoint npm doh-a run typecheck >>"$LOG_FILE" 2>&1
  docker compose run --rm --no-deps --entrypoint npm telegram-bot run typecheck >>"$LOG_FILE" 2>&1
  docker compose run --rm --no-deps --entrypoint npm updater run typecheck >>"$LOG_FILE" 2>&1

  log "== Pre-flight passed =="
  log "== Ensure Phase-2 lab is off =="
  docker compose exec -T wireguard /app/phase2-firewall.sh https disable >>"$LOG_FILE" 2>&1 || true
  docker compose exec -T wireguard /app/phase2-firewall.sh quic allow >>"$LOG_FILE" 2>&1 || true
  docker compose --profile https-lab rm -f -s mitmproxy >>"$LOG_FILE" 2>&1 || true

  log "== Recreate complete stack =="
  docker compose up -d --force-recreate --remove-orphans >>"$LOG_FILE" 2>&1

  log "== Verify stack =="
  verify_stack "$TARGET_SHA"
)

rollback_previous() (
  set -eu

  log "== Rollback to $PREVIOUS_SHA =="
  git -c safe.directory=/workspace reset --hard "$PREVIOUS_SHA" >>"$LOG_FILE" 2>&1
  export DEPLOY_SHA="$PREVIOUS_SHA"

  docker compose config --quiet >>"$LOG_FILE" 2>&1
  docker compose build >>"$LOG_FILE" 2>&1
  docker compose up -d --force-recreate --remove-orphans >>"$LOG_FILE" 2>&1

  wait_service doh-a healthy
  wait_service doh-b healthy
  wait_service updater healthy
  wait_service doh-proxy running
  wait_service telegram-bot running
  if docker compose config --services | grep -qx wireguard; then
    wait_service wireguard healthy
  fi
  verify_updater_revision "$PREVIOUS_SHA"
)

mkdir -p "$(dirname "$STATE_FILE")"
node /update-state.mjs running

set +e
deploy_target
DEPLOY_CODE="$?"
set -e

if [ "$DEPLOY_CODE" -eq 0 ]; then
  log "Deployment completed successfully."
  node /update-state.mjs success
  notify "✅ AdBlock aggiornato correttamente a $TARGET_SHA."
  exit 0
fi

log "Deployment failed with exit code $DEPLOY_CODE."

set +e
rollback_previous
ROLLBACK_CODE="$?"
set -e

if [ "$ROLLBACK_CODE" -eq 0 ]; then
  log "Rollback recovered the previous stack."
  notify "❌ Aggiornamento AdBlock fallito. Rollback completato. Usa /update_status per i dettagli."
else
  log "CRITICAL: rollback failed with exit code $ROLLBACK_CODE."
  notify "❌ Aggiornamento AdBlock fallito e rollback incompleto. Usa /update_status per i dettagli."
fi

node /update-state.mjs failed
exit "$DEPLOY_CODE"
