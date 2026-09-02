#!/bin/sh
set -eu

ACTION="${1:-status}"
INTEGRATION="${2:-instagram}"
CA_PEM="${HOST_REPO_DIR:-.}/data/https/ca/mitmproxy-ca-cert.pem"

proxy_container_id() {
  docker compose --profile https-lab ps -q --all https-proxy 2>/dev/null || true
}

proxy_state() {
  CID="$(proxy_container_id)"
  if [ -z "$CID" ]; then
    printf '%s' "missing"
    return
  fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || printf '%s' "unknown"
}

wait_proxy() {
  for _ in $(seq 1 60); do
    STATE="$(proxy_state)"
    case "$STATE" in
      healthy|running)
        return 0
        ;;
      exited|dead)
        break
        ;;
    esac
    sleep 1
  done

  echo "https-proxy failed to become ready (state: $(proxy_state))" >&2
  docker compose --profile https-lab logs --tail=100 https-proxy >&2 || true
  return 1
}

firewall() {
  docker compose exec -T wireguard /app/https-firewall.sh "$@"
}

cleanup_interception() {
  firewall https disable >/dev/null 2>&1 || true
  firewall quic allow >/dev/null 2>&1 || true
}

start_proxy() {
  HTTPS_INTEGRATION="$INTEGRATION" docker compose --profile https-lab up -d --build --force-recreate https-proxy
  wait_proxy
}

case "$ACTION" in
  start)
    cleanup_interception
    if ! start_proxy; then
      cleanup_interception
      docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
      exit 1
    fi
    if ! firewall https enable >/dev/null; then
      cleanup_interception
      docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
      exit 1
    fi
    if ! firewall quic block >/dev/null; then
      cleanup_interception
      docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
      exit 1
    fi
    echo "integration=$INTEGRATION"
    echo "proxy=$(proxy_state)"
    echo "https=enabled"
    echo "quic=blocked"
    ;;
  stop)
    cleanup_interception
    docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
    echo "proxy=$(proxy_state)"
    echo "https=disabled"
    echo "quic=allowed"
    ;;
  status)
    echo "proxy=$(proxy_state)"
    firewall https status || true
    firewall quic status || true
    ;;
  ca-prepare)
    if [ -s "$CA_PEM" ]; then
      echo "$CA_PEM"
      exit 0
    fi

    WAS_RUNNING=0
    case "$(proxy_state)" in
      healthy|running)
        WAS_RUNNING=1
        ;;
      *)
        start_proxy
        ;;
    esac

    for _ in $(seq 1 30); do
      if [ -s "$CA_PEM" ]; then
        if [ "$WAS_RUNNING" -eq 0 ]; then
          docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
        fi
        echo "$CA_PEM"
        exit 0
      fi
      sleep 1
    done

    if [ "$WAS_RUNNING" -eq 0 ]; then
      docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
    fi
    echo "Unable to generate HTTPS CA" >&2
    exit 2
    ;;
  *)
    echo "Usage: $0 {start|stop|status|ca-prepare} [integration]" >&2
    exit 2
    ;;
esac
