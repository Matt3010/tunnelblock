#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
ACTION="${1:-qr}"
CLIENT_NAME="${2:-iphone}"

exec docker compose exec -T wireguard /app/show-client.sh "$ACTION" "$CLIENT_NAME"
