#!/bin/sh
set -eu

CLIENT_NAME="${WG_CLIENT_NAME:-iphone}"
SERVER_PORT="${WG_SERVER_PORT:-51820}"
CLIENT_CONF="/config/peers/$CLIENT_NAME/$CLIENT_NAME.conf"

test -s "/config/server_private.key"
test -s "$CLIENT_CONF"
ip link show wg0 >/dev/null 2>&1
wg show wg0 >/dev/null 2>&1
test "$(wg show wg0 listen-port)" = "$SERVER_PORT"
pidof dnsmasq >/dev/null 2>&1
