#!/bin/sh
set -eu

SERVER_PORT="${WG_SERVER_PORT:-51820}"

test -s "/config/server_private.key"
ip link show wg0 >/dev/null 2>&1
wg show wg0 >/dev/null 2>&1
test "$(wg show wg0 listen-port)" = "$SERVER_PORT"
pidof dnsmasq >/dev/null 2>&1
