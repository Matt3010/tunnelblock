#!/bin/sh
set -eu

CONFIG_DIR="${WG_CONFIG_DIR:-/config}"
PEERS_DIR="$CONFIG_DIR/peers"
ACTION="${1:-list}"
NAME="${2:-}"

valid_name() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{1,32}$'; }
peer_dir() { printf '%s/%s' "$PEERS_DIR" "$1"; }
field() { sed -n '1p' "$(peer_dir "$1")/$2"; }

require_name() {
  valid_name "$NAME" || { echo 'invalid peer name' >&2; exit 64; }
}

write_config() {
  PDIR="$(peer_dir "$NAME")"
  IPV4="$(field "$NAME" ipv4)"
  IPV6="$(field "$NAME" ipv6)"
  ENDPOINT="$(sed -n '1p' "$CONFIG_DIR/endpoint")"
  cat >"$PDIR/$NAME.conf" <<EOF
[Interface]
PrivateKey = $(cat "$PDIR/private.key")
Address = $IPV4/32, $IPV6/128
DNS = ${WG_DNS_SERVERS:-10.66.66.1}
MTU = ${WG_MTU:-1420}

[Peer]
PublicKey = $(cat "$CONFIG_DIR/server_public.key")
PresharedKey = $(cat "$PDIR/preshared.key")
Endpoint = $ENDPOINT:${WG_SERVER_PORT:-51820}
AllowedIPs = ${WG_ALLOWED_IPS:-0.0.0.0/0, ::/0}
PersistentKeepalive = 25
EOF
  chmod 0600 "$PDIR/$NAME.conf"
  qrencode -o "$PDIR/$NAME.png" -t PNG <"$PDIR/$NAME.conf"
  chmod 0600 "$PDIR/$NAME.png"
}

enable_peer() {
  PDIR="$(peer_dir "$NAME")"
  wg set wg0 peer "$(cat "$PDIR/public.key")" \
    preshared-key "$PDIR/preshared.key" \
    allowed-ips "$(field "$NAME" ipv4)/32,$(field "$NAME" ipv6)/128"
  : >"$PDIR/enabled"
}

case "$ACTION" in
  list)
    printf '['
    FIRST=1
    for PDIR in "$PEERS_DIR"/*; do
      [ -d "$PDIR" ] || continue
      PNAME="$(basename "$PDIR")"
      [ -s "$PDIR/public.key" ] || continue
      [ "$FIRST" -eq 1 ] || printf ','
      FIRST=0
      PUB="$(cat "$PDIR/public.key")"
      DUMP="$(wg show wg0 dump | awk -v p="$PUB" '$1==p {print $5 " " $6 " " $7}' || true)"
      set -- $DUMP
      printf '{"name":"%s","enabled":%s,"ipv4":"%s","ipv6":"%s","handshake":%s,"rx":%s,"tx":%s}' \
        "$PNAME" "$([ -f "$PDIR/enabled" ] && echo true || echo false)" \
        "$(cat "$PDIR/ipv4")" "$(cat "$PDIR/ipv6")" "${1:-0}" "${2:-0}" "${3:-0}"
    done
    printf ']\n'
    ;;
  add)
    require_name
    PDIR="$(peer_dir "$NAME")"
    [ ! -e "$PDIR" ] || { echo 'peer already exists' >&2; exit 65; }
    mkdir -p "$PEERS_DIR" "$PDIR"
    chmod 0700 "$PEERS_DIR" "$PDIR"
    SLOT=2
    while [ "$SLOT" -le 254 ]; do
      if ! grep -Rqx "10.66.66.$SLOT" "$PEERS_DIR"/*/ipv4 2>/dev/null; then break; fi
      SLOT=$((SLOT + 1))
    done
    [ "$SLOT" -le 254 ] || { rmdir "$PDIR"; echo 'address pool exhausted' >&2; exit 66; }
    printf '10.66.66.%s\n' "$SLOT" >"$PDIR/ipv4"
    printf 'fd42:66:66::%x\n' "$SLOT" >"$PDIR/ipv6"
    wg genkey >"$PDIR/private.key"
    wg pubkey <"$PDIR/private.key" >"$PDIR/public.key"
    wg genpsk >"$PDIR/preshared.key"
    chmod 0600 "$PDIR"/*
    write_config
    enable_peer
    "$0" get "$NAME"
    ;;
  get)
    require_name; PDIR="$(peer_dir "$NAME")"; [ -d "$PDIR" ] || exit 67
    printf '{"name":"%s","enabled":%s,"ipv4":"%s","ipv6":"%s"}\n' "$NAME" \
      "$([ -f "$PDIR/enabled" ] && echo true || echo false)" "$(field "$NAME" ipv4)" "$(field "$NAME" ipv6)"
    ;;
  enable)
    require_name; [ -d "$(peer_dir "$NAME")" ] || exit 67; enable_peer; "$0" get "$NAME"
    ;;
  disable)
    require_name; PDIR="$(peer_dir "$NAME")"; [ -d "$PDIR" ] || exit 67
    wg set wg0 peer "$(cat "$PDIR/public.key")" remove; rm -f "$PDIR/enabled"; "$0" get "$NAME"
    ;;
  rotate)
    require_name; PDIR="$(peer_dir "$NAME")"; [ -d "$PDIR" ] || exit 67
    WAS_ENABLED=0; [ -f "$PDIR/enabled" ] && WAS_ENABLED=1
    wg set wg0 peer "$(cat "$PDIR/public.key")" remove 2>/dev/null || true
    wg genkey >"$PDIR/private.key"; wg pubkey <"$PDIR/private.key" >"$PDIR/public.key"; wg genpsk >"$PDIR/preshared.key"
    chmod 0600 "$PDIR/private.key" "$PDIR/public.key" "$PDIR/preshared.key"; write_config
    [ "$WAS_ENABLED" -eq 0 ] || enable_peer
    "$0" get "$NAME"
    ;;
  delete)
    require_name; PDIR="$(peer_dir "$NAME")"; [ -d "$PDIR" ] || exit 67
    wg set wg0 peer "$(cat "$PDIR/public.key")" remove 2>/dev/null || true
    rm -rf "$PDIR"; printf '{"deleted":true}\n'
    ;;
  conf)
    require_name; cat "$(peer_dir "$NAME")/$NAME.conf"
    ;;
  png)
    require_name; cat "$(peer_dir "$NAME")/$NAME.png"
    ;;
  *) echo 'usage: peer-manager.sh list|add|get|enable|disable|rotate|delete|conf|png [name]' >&2; exit 64 ;;
esac
