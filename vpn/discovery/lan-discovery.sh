#!/bin/sh
set -eu

# Scans the Raspberry's own LAN (host network namespace) and prints one header
# line followed by nmap XML. The updater parses the result.

PORTS="${LAN_DISCOVERY_PORTS:-21,22,23,25,53,80,81,88,110,111,139,143,389,443,445,548,554,587,631,873,993,995,1080,1194,1400,1433,1521,1883,2049,2375,2376,3000,3001,3306,3389,3483,4533,5000,5001,5006,5432,5601,5900,5985,6379,6443,7878,8000,8006,8008,8009,8080,8081,8083,8086,8088,8089,8090,8096,8123,8181,8200,8443,8448,8554,8686,8787,8880,8888,8920,8989,9000,9090,9091,9100,9117,9200,9443,9696,10000,19999,32400,51413}"
MIN_PREFIX=22

IFACE="$(ip -4 route show default | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
[ -n "$IFACE" ] || { echo 'no default IPv4 route' >&2; exit 3; }

CIDR="$(ip -4 -o address show dev "$IFACE" scope global | awk 'NR == 1 {print $4}')"
[ -n "$CIDR" ] || { echo "no IPv4 address on $IFACE" >&2; exit 3; }

SELF="${CIDR%/*}"
PREFIX="${CIDR#*/}"
# Never sweep huge networks: fall back to the /24 around this host.
[ "$PREFIX" -ge "$MIN_PREFIX" ] || PREFIX=24
TARGET="$SELF/$PREFIX"

printf '# tunnelblock-discovery interface=%s self=%s target=%s\n' "$IFACE" "$SELF" "$TARGET"

exec nmap -sS -T4 --max-retries 1 --host-timeout 90s \
  -e "$IFACE" -p "$PORTS" -oX - "$TARGET"
