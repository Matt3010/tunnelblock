#!/bin/sh
set -eu

ACTION="${1:-qr}"
CLIENT_NAME="${2:-${WG_CLIENT_NAME:-iphone}}"
BASE="/config/peers/$CLIENT_NAME"
CONF="$BASE/$CLIENT_NAME.conf"
PNG="$BASE/$CLIENT_NAME.png"

if [ ! -s "$CONF" ]; then
  echo "WireGuard client config not found: $CONF" >&2
  exit 2
fi

case "$ACTION" in
  qr)
    qrencode -t ANSIUTF8 <"$CONF"
    ;;
  conf)
    cat "$CONF"
    ;;
  path)
    printf '%s\n' "$CONF"
    ;;
  png)
    test -s "$PNG"
    printf '%s\n' "$PNG"
    ;;
  *)
    echo "Usage: show-client.sh [qr|conf|path|png] [client-name]" >&2
    exit 64
    ;;
esac
