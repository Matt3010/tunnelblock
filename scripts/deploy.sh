#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

echo "[1/5] Pulling latest code"
git pull --ff-only

echo "[2/5] Building new images while current services stay online"
docker compose build doh-a doh-b telegram-bot debug-collector

echo "[3/5] Updating first DoH replica"
docker compose up -d --no-deps doh-a
sleep 2
docker compose exec -T doh-a node -e "fetch('http://127.0.0.1:8053/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

echo "[4/5] Updating second DoH replica"
docker compose up -d --no-deps doh-b
sleep 2
docker compose exec -T doh-b node -e "fetch('http://127.0.0.1:8053/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

echo "[5/5] Updating proxy/control services"
docker compose up -d doh-proxy telegram-bot debug-collector

echo
echo "Deployment complete."
docker compose ps
