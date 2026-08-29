#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

echo "[1/7] Pulling latest code"
git pull --ff-only

echo "[2/7] Building redundant DoH replicas and control services"
docker compose build doh-a doh-b telegram-bot updater debug-collector

echo "[3/7] Starting new DoH replicas without touching port 8053"
docker compose up -d --no-deps doh-a doh-b

echo "[4/7] Waiting for both replicas"
for service in doh-a doh-b; do
  attempts=0
  until docker compose exec -T "$service" node -e "fetch('http://127.0.0.1:8053/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 20 ]; then
      echo "$service did not become healthy; keeping the old DoH service untouched."
      exit 1
    fi
    sleep 1
  done
done

echo "[5/7] Switching public port 8053 from old DoH container to Caddy proxy"
OLD_DOH_IDS="$(docker ps -q --filter label=com.docker.compose.service=doh || true)"
if [ -n "$OLD_DOH_IDS" ]; then
  docker stop $OLD_DOH_IDS
fi

if ! docker compose up -d --no-deps doh-proxy; then
  echo "Proxy failed to start. Attempting to restart the old DoH container."
  if [ -n "$OLD_DOH_IDS" ]; then
    docker start $OLD_DOH_IDS || true
  fi
  exit 1
fi

echo "[6/7] Verifying proxy health"
attempts=0
until node_test="$(curl -fsS http://127.0.0.1:8053/health 2>/dev/null)" && [ "$node_test" = '{"ok":true}' ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 20 ]; then
    echo "Proxy health check failed."
    exit 1
  fi
  sleep 1
done

echo "[7/7] Starting control services and removing obsolete DoH container"
docker compose up -d telegram-bot debug-collector
if [ -n "$OLD_DOH_IDS" ]; then
  docker rm $OLD_DOH_IDS >/dev/null 2>&1 || true
fi

echo
echo "HA migration complete."
docker compose ps
