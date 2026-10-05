#!/bin/sh
set -eu

if [ ! -f docker-compose.yml ] || [ ! -f ops/install.sh ]; then
  echo "Run this command from the TunnelBlock repository root." >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 3; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 4; }
command -v openssl >/dev/null 2>&1 || { echo "OpenSSL is required." >&2; exit 5; }

new_web_password() {
  openssl rand -base64 18 | tr '+/' '-_'
}

if [ -f .env ]; then
  echo "Existing .env preserved. Validate it before continuing."
  if ! grep -q '^WEB_PASSWORD=' .env; then
    WEB_PASS="$(new_web_password)"
    printf 'WEB_USER=admin\nWEB_PASSWORD=%s\n' "$WEB_PASS" >>.env
    echo "Added web panel credentials to .env: user admin, password $WEB_PASS"
  fi
else
  printf 'Public IP or DDNS hostname [auto]: '
  read -r WG_ENDPOINT
  WG_ENDPOINT="${WG_ENDPOINT:-auto}"

  ADMIN_TOKEN="$(openssl rand -hex 32)"
  WEB_PASS="$(new_web_password)"
  REPO_PATH="$(pwd -P)"
  umask 077
  {
    printf 'HOST_REPO_DIR=%s\n' "$REPO_PATH"
    printf 'WG_SERVER_ENDPOINT=%s\n' "$WG_ENDPOINT"
    printf 'ADMIN_API_TOKEN=%s\n' "$ADMIN_TOKEN"
    printf 'WEB_USER=admin\n'
    printf 'WEB_PASSWORD=%s\n' "$WEB_PASS"
  } >.env
  echo "Created .env with mode 0600."
  echo "Web panel login: user admin, password $WEB_PASS (stored in .env)"
fi

mkdir -p data/rules data/wireguard
chmod 0700 data/wireguard
docker compose config --quiet

printf 'Build and start the initial TunnelBlock stack now? [y/N] '
read -r CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES)
    docker compose build
    docker compose up -d
    docker compose ps
    echo "Initial stack started. Point a Cloudflare Tunnel public hostname at http://localhost:8092 to open the web panel. Forward only UDP/51820 on the router."
    ;;
  *)
    echo "Configuration validated; no containers were changed."
    ;;
esac
