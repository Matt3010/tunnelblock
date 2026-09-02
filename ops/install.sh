#!/bin/sh
set -eu

if [ ! -f docker-compose.yml ] || [ ! -f ops/install.sh ]; then
  echo "Run this command from the TunnelBlock repository root." >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 3; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 4; }
command -v openssl >/dev/null 2>&1 || { echo "OpenSSL is required." >&2; exit 5; }

if [ -f .env ]; then
  echo "Existing .env preserved. Validate it before continuing."
else
  printf 'Telegram bot token: '
  read -r TELEGRAM_TOKEN
  printf 'Allowed Telegram user ID (comma-separated if multiple): '
  read -r TELEGRAM_USERS
  printf 'GitHub token with read access to this repository: '
  read -r GITHUB_READ_TOKEN
  printf 'Public IP or DDNS hostname [auto]: '
  read -r WG_ENDPOINT
  WG_ENDPOINT="${WG_ENDPOINT:-auto}"

  [ -n "$TELEGRAM_TOKEN" ] || { echo "Telegram bot token is required." >&2; exit 6; }
  printf '%s' "$TELEGRAM_USERS" | grep -Eq '^[0-9]+(,[[:space:]]*[0-9]+)*$' || {
    echo "Telegram user IDs must be numeric and comma-separated." >&2
    exit 7
  }
  [ -n "$GITHUB_READ_TOKEN" ] || { echo "GitHub token is required for /update." >&2; exit 8; }

  ADMIN_TOKEN="$(openssl rand -hex 32)"
  REPO_PATH="$(pwd -P)"
  umask 077
  {
    printf 'HOST_REPO_DIR=%s\n' "$REPO_PATH"
    printf 'WG_SERVER_ENDPOINT=%s\n' "$WG_ENDPOINT"
    printf 'ADMIN_API_TOKEN=%s\n' "$ADMIN_TOKEN"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_TOKEN"
    printf 'TELEGRAM_ALLOWED_USER_IDS=%s\n' "$TELEGRAM_USERS"
    printf 'GITHUB_TOKEN=%s\n' "$GITHUB_READ_TOKEN"
  } >.env
  echo "Created .env with mode 0600."
fi

mkdir -p data/rules data/wireguard data/https
chmod 0700 data/wireguard data/https
docker compose config --quiet

printf 'Build and start the initial TunnelBlock stack now? [y/N] '
read -r CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES)
    docker compose build
    docker compose up -d
    docker compose ps
    echo "Initial stack started. Continue with router UDP/51820 and Telegram /vpn setup."
    ;;
  *)
    echo "Configuration validated; no containers were changed."
    ;;
esac
