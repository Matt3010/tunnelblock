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

wireguard_dns_reload_supported() {
  docker compose exec -T wireguard sh -c '
    test -f /run/dnsmasq-servers.conf &&
    grep -q "^servers-file=/run/dnsmasq-servers.conf$" /run/dnsmasq.conf &&
    pidof dnsmasq >/dev/null 2>&1
  ' >/dev/null 2>&1
}

configure_wireguard_dns_upstreams() {
  UPSTREAMS="$1"
  log "Configure live VPN DNS upstreams: $UPSTREAMS"

  docker compose exec -T -e DNS_UPSTREAM_SELECTION="$UPSTREAMS" wireguard sh -eu -c '
    SERVERS_FILE=/run/dnsmasq-servers.conf
    TMP_FILE="$SERVERS_FILE.tmp"
    : >"$TMP_FILE"

    resolve_upstream() {
      NAME="$1"
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        ADDRESS="$(getent hosts "$NAME" 2>/dev/null | awk "NR==1 {print \$1}" || true)"
        if [ -n "$ADDRESS" ] && ! printf "%s" "$ADDRESS" | grep -q ":"; then
          printf "%s" "$ADDRESS"
          return 0
        fi
        sleep 1
      done
      return 1
    }

    OLD_IFS="$IFS"
    IFS=","
    for UPSTREAM in $DNS_UPSTREAM_SELECTION; do
      IFS="$OLD_IFS"
      UPSTREAM="$(printf "%s" "$UPSTREAM" | tr -d " ")"
      [ -n "$UPSTREAM" ] || continue
      UPSTREAM_IP="$(resolve_upstream "$UPSTREAM")"
      echo "server=$UPSTREAM_IP#53" >>"$TMP_FILE"
      IFS=","
    done
    IFS="$OLD_IFS"

    test -s "$TMP_FILE"
    mv "$TMP_FILE" "$SERVERS_FILE"
    kill -HUP "$(pidof dnsmasq)"
  ' >>"$LOG_FILE" 2>&1
}

can_roll_resolvers() {
  wireguard_dns_reload_supported &&
    [ "$(service_state doh-a)" = "healthy" ] &&
    [ "$(service_state doh-b)" = "healthy" ]
}

rolling_update_resolvers() {
  log "== Rolling DNS resolver update =="

  # Keep doh-a as the only live upstream while doh-b is replaced.
  configure_wireguard_dns_upstreams "doh-a"
  docker compose up -d --no-deps --force-recreate doh-b >>"$LOG_FILE" 2>&1
  wait_service doh-b healthy
  configure_wireguard_dns_upstreams "doh-a,doh-b"

  # Then keep doh-b serving while doh-a is replaced.
  configure_wireguard_dns_upstreams "doh-b"
  docker compose up -d --no-deps --force-recreate doh-a >>"$LOG_FILE" 2>&1
  wait_service doh-a healthy
  configure_wireguard_dns_upstreams "doh-a,doh-b"
}

reconcile_stack() {
  if can_roll_resolvers; then
    rolling_update_resolvers
    log "== Reconcile remaining stack without forcing unchanged services =="
    docker compose up -d --remove-orphans >>"$LOG_FILE" 2>&1
  else
    log "== Rolling DNS unavailable; perform compatibility full recreation =="
    docker compose up -d --force-recreate --remove-orphans >>"$LOG_FILE" 2>&1
  fi
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

  log "== Pre-flight: build complete stack =="
  docker compose build >>"$LOG_FILE" 2>&1

  log "== Pre-flight: build HTTPS integration lab =="
  docker compose --profile https-lab build https-proxy >>"$LOG_FILE" 2>&1

  log "== Pre-flight: shell checks =="
  sh -n ops/deploy.sh vpn/wireguard/entrypoint.sh vpn/wireguard/healthcheck.sh vpn/wireguard/show-client.sh vpn/wireguard/https-firewall.sh scripts/wireguard-client.sh scripts/https-ca.sh scripts/https-runtime.sh >>"$LOG_FILE" 2>&1

  log "== Pre-flight: DNS tests =="
  docker compose run --rm --no-deps --entrypoint npm doh-a test >>"$LOG_FILE" 2>&1
  docker compose run --rm --no-deps --entrypoint npm updater test >>"$LOG_FILE" 2>&1

  log "== Pre-flight: HTTPS framework and registry tests =="
  docker compose --profile https-lab run --rm --no-deps --entrypoint python https-proxy -B -m unittest discover -s /tests -v >>"$LOG_FILE" 2>&1

  log "== Pre-flight: TypeScript checks =="
  docker compose run --rm --no-deps --entrypoint npm doh-a run typecheck >>"$LOG_FILE" 2>&1
  docker compose run --rm --no-deps --entrypoint npm telegram-bot run typecheck >>"$LOG_FILE" 2>&1
  docker compose run --rm --no-deps --entrypoint npm updater run typecheck >>"$LOG_FILE" 2>&1

  log "== Pre-flight passed =="
  log "== Stop experimental HTTPS lab =="
  sh scripts/https-runtime.sh stop >>"$LOG_FILE" 2>&1 || true

  reconcile_stack
  sh scripts/https-runtime.sh reset-state >>"$LOG_FILE" 2>&1

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
  reconcile_stack

  wait_service doh-a healthy
  wait_service doh-b healthy
  wait_service updater healthy
  if docker compose config --services | grep -qx doh-proxy; then
    wait_service doh-proxy running
  fi
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
  notify "✅ TunnelBlock successfully updated to $TARGET_SHA."
  exit 0
fi

log "Deployment failed with exit code $DEPLOY_CODE."

set +e
rollback_previous
ROLLBACK_CODE="$?"
set -e

if [ "$ROLLBACK_CODE" -eq 0 ]; then
  log "Rollback recovered the previous stack."
  notify "❌ TunnelBlock update failed. Rollback completed. Use /update_status for details."
else
  log "CRITICAL: rollback failed with exit code $ROLLBACK_CODE."
  notify "❌ TunnelBlock update failed and rollback is incomplete. Use /update_status for details."
fi

node /update-state.mjs failed
exit "$DEPLOY_CODE"
