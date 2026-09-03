#!/bin/sh
set -eu

umask 077

CONFIG_DIR="${WG_CONFIG_DIR:-/config}"
SERVER_PORT="${WG_SERVER_PORT:-51820}"
SERVER_IPV4_ADDRESS="${WG_SERVER_IPV4_ADDRESS:-10.66.66.1/24}"
SERVER_IPV6_ADDRESS="${WG_SERVER_IPV6_ADDRESS:-fd42:66:66::1/64}"
IPV4_SUBNET="${WG_IPV4_SUBNET:-10.66.66.0/24}"
IPV6_SUBNET="${WG_IPV6_SUBNET:-fd42:66:66::/64}"
ALLOWED_IPS="${WG_ALLOWED_IPS:-0.0.0.0/0, ::/0}"
DNS_SERVERS="${WG_DNS_SERVERS:-10.66.66.1}"
DNS_UPSTREAMS="${WG_DNS_UPSTREAMS:-doh-a,doh-b}"
MTU="${WG_MTU:-1420}"

mkdir -p "$CONFIG_DIR/peers"
chmod 0700 "$CONFIG_DIR" "$CONFIG_DIR/peers"

SERVER_PRIVATE="$CONFIG_DIR/server_private.key"
SERVER_PUBLIC="$CONFIG_DIR/server_public.key"
SERVER_CONF="$CONFIG_DIR/wg0.conf"

generate_keypair() {
  PRIVATE_FILE="$1"
  PUBLIC_FILE="$2"

  if [ ! -s "$PRIVATE_FILE" ]; then
    wg genkey >"$PRIVATE_FILE"
  fi

  # Public keys are derived state: refresh them from the persisted private key
  # on every start without ever rotating the private key itself.
  wg pubkey <"$PRIVATE_FILE" >"$PUBLIC_FILE"
  chmod 0600 "$PRIVATE_FILE" "$PUBLIC_FILE"
}

generate_keypair "$SERVER_PRIVATE" "$SERVER_PUBLIC"

resolve_public_ipv4() {
  for URL in "https://api.ipify.org" "https://icanhazip.com"; do
    VALUE="$(curl -4 -fsS --connect-timeout 3 --max-time 5 "$URL" 2>/dev/null | tr -d '[:space:]' || true)"
    if printf '%s' "$VALUE" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      printf '%s' "$VALUE"
      return 0
    fi
  done
  return 1
}

ENDPOINT_HOST="${WG_SERVER_ENDPOINT:-auto}"
if [ "$ENDPOINT_HOST" = "auto" ]; then
  ENDPOINT_HOST="$(resolve_public_ipv4)" || {
    echo "Unable to determine public IPv4. Set WG_SERVER_ENDPOINT in .env." >&2
    exit 3
  }
fi

case "$ENDPOINT_HOST" in
  \[*\])
    FORMATTED_ENDPOINT="$ENDPOINT_HOST"
    ;;
  *:*)
    FORMATTED_ENDPOINT="[$ENDPOINT_HOST]"
    ;;
  *)
    FORMATTED_ENDPOINT="$ENDPOINT_HOST"
    ;;
esac
printf '%s\n' "$FORMATTED_ENDPOINT" >"$CONFIG_DIR/endpoint"

# Revoke the former single-client layout without destroying its key material.
for LEGACY_DIR in "$CONFIG_DIR"/peers/*; do
  [ -d "$LEGACY_DIR" ] || continue
  if [ ! -s "$LEGACY_DIR/ipv4" ] || [ ! -s "$LEGACY_DIR/ipv6" ]; then
    LEGACY_NAME="$(basename "$LEGACY_DIR")"
    mv "$LEGACY_DIR" "$CONFIG_DIR/revoked-legacy-$LEGACY_NAME"
  fi
done

cat >"$SERVER_CONF" <<EOF
[Interface]
PrivateKey = $(cat "$SERVER_PRIVATE")
ListenPort = $SERVER_PORT
EOF

for PEER_DIR in "$CONFIG_DIR"/peers/*; do
  [ -d "$PEER_DIR" ] || continue
  [ -f "$PEER_DIR/enabled" ] || continue
  [ -s "$PEER_DIR/public.key" ] || continue
  cat >>"$SERVER_CONF" <<EOF

[Peer]
PublicKey = $(cat "$PEER_DIR/public.key")
PresharedKey = $(cat "$PEER_DIR/preshared.key")
AllowedIPs = $(cat "$PEER_DIR/ipv4")/32, $(cat "$PEER_DIR/ipv6")/128
EOF
done
chmod 0600 "$SERVER_CONF"

ip link del wg0 2>/dev/null || true
if ! ip link add dev wg0 type wireguard 2>/dev/null; then
  modprobe wireguard 2>/dev/null || true
  ip link add dev wg0 type wireguard
fi

wg setconf wg0 "$SERVER_CONF"
ip address add "$SERVER_IPV4_ADDRESS" dev wg0
IPV6_INTERFACE=0
if ip -6 address add "$SERVER_IPV6_ADDRESS" dev wg0 2>/dev/null; then
  IPV6_INTERFACE=1
else
  echo "IPv6 interface addressing unavailable; IPv6 will remain captured but without egress." >&2
fi
ip link set mtu "$MTU" up dev wg0

EGRESS_IF="$(ip route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
if [ -z "$EGRESS_IF" ]; then
  echo "Unable to determine IPv4 egress interface" >&2
  exit 4
fi

# This namespace is a dedicated Internet gateway. Default-deny forwarding prevents
# the VPN peer from pivoting into vpn-dns or any other Docker-attached network.
iptables -P FORWARD DROP
iptables -A FORWARD -i wg0 -o wg0 -j ACCEPT
iptables -A FORWARD -i wg0 -o "$EGRESS_IF" -j ACCEPT
iptables -A FORWARD -i "$EGRESS_IF" -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s "$IPV4_SUBNET" -o "$EGRESS_IF" -j MASQUERADE

IPV6_FIREWALL=0
IPV6_EGRESS_IF=""
IPV6_NAT=0

if [ "$IPV6_INTERFACE" -eq 1 ] && ip6tables -P FORWARD DROP 2>/dev/null; then
  IPV6_FIREWALL=1
  ip6tables -A FORWARD -i wg0 -o wg0 -j ACCEPT

  if IPV6_ROUTE="$(ip -6 route get 2606:4700:4700::1111 2>/dev/null)"; then
    IPV6_EGRESS_IF="$(printf '%s\n' "$IPV6_ROUTE" | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
  fi

  if [ -n "$IPV6_EGRESS_IF" ]; then
    ip6tables -A FORWARD -i wg0 -o "$IPV6_EGRESS_IF" -j ACCEPT
    ip6tables -A FORWARD -i "$IPV6_EGRESS_IF" -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    if ip6tables -t nat -A POSTROUTING -s "$IPV6_SUBNET" -o "$IPV6_EGRESS_IF" -j MASQUERADE 2>/dev/null; then
      IPV6_NAT=1
    else
      echo "IPv6 NAT is unavailable; ::/0 still prevents an IPv6 bypass." >&2
    fi
  else
    echo "No IPv6 egress route; ::/0 still prevents an IPv6 bypass." >&2
  fi
else
  # IPv4 must remain usable even on hosts where IPv6/netfilter is unavailable.
  # Keep ::/0 in the client so native phone IPv6 cannot bypass the VPN.
  printf '0' >/proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || true
  echo "IPv6 forwarding unavailable; IPv6 remains captured and IPv4 stays operational." >&2
fi

resolve_dns_upstream() {
  NAME="$1"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ADDRESS="$(getent hosts "$NAME" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    if [ -n "$ADDRESS" ] && ! printf '%s' "$ADDRESS" | grep -q ':'; then
      printf '%s' "$ADDRESS"
      return 0
    fi
    sleep 1
  done

  return 1
}

DNSMASQ_CONF="/run/dnsmasq.conf"
DNSMASQ_SERVERS="/run/dnsmasq-servers.conf"
{
  echo "port=53"
  echo "no-resolv"
  echo "no-hosts"
  echo "bind-interfaces"
  echo "interface=wg0"
  echo "listen-address=${SERVER_IPV4_ADDRESS%/*}"
  echo "cache-size=1000"
  echo "strict-order"
  echo "servers-file=$DNSMASQ_SERVERS"
} >"$DNSMASQ_CONF"

: >"$DNSMASQ_SERVERS"
OLD_IFS="$IFS"
IFS=','
for UPSTREAM in $DNS_UPSTREAMS; do
  IFS="$OLD_IFS"
  UPSTREAM="$(printf '%s' "$UPSTREAM" | tr -d ' ')"
  [ -n "$UPSTREAM" ] || continue
  UPSTREAM_IP="$(resolve_dns_upstream "$UPSTREAM")" || {
    echo "Unable to resolve DNS upstream service: $UPSTREAM" >&2
    exit 5
  }
  echo "server=$UPSTREAM_IP#53" >>"$DNSMASQ_SERVERS"
  IFS=','
done
IFS="$OLD_IFS"

# dnsmasq drops privileges after startup and must be able to reread this file on SIGHUP.
# It contains only resolver endpoint addresses, not secrets.
chmod 0644 "$DNSMASQ_SERVERS"

cleanup() {
  set +e
  [ -n "${DNSMASQ_PID:-}" ] && kill "$DNSMASQ_PID" 2>/dev/null
  iptables -D FORWARD -i wg0 -o wg0 -j ACCEPT 2>/dev/null
  iptables -D FORWARD -i wg0 -o "$EGRESS_IF" -j ACCEPT 2>/dev/null
  iptables -D FORWARD -i "$EGRESS_IF" -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
  iptables -t nat -D POSTROUTING -s "$IPV4_SUBNET" -o "$EGRESS_IF" -j MASQUERADE 2>/dev/null
  iptables -P FORWARD ACCEPT 2>/dev/null

  if [ "$IPV6_FIREWALL" -eq 1 ]; then
    ip6tables -D FORWARD -i wg0 -o wg0 -j ACCEPT 2>/dev/null
    if [ -n "$IPV6_EGRESS_IF" ]; then
      ip6tables -D FORWARD -i wg0 -o "$IPV6_EGRESS_IF" -j ACCEPT 2>/dev/null
      ip6tables -D FORWARD -i "$IPV6_EGRESS_IF" -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
      if [ "$IPV6_NAT" -eq 1 ]; then
        ip6tables -t nat -D POSTROUTING -s "$IPV6_SUBNET" -o "$IPV6_EGRESS_IF" -j MASQUERADE 2>/dev/null
      fi
    fi
    ip6tables -P FORWARD ACCEPT 2>/dev/null
  fi
  ip link del wg0 2>/dev/null
}
trap cleanup INT TERM EXIT

echo "WireGuard ready on UDP $SERVER_PORT; peers are managed through Telegram."
dnsmasq --keep-in-foreground --conf-file="$DNSMASQ_CONF" &
DNSMASQ_PID="$!"
wait "$DNSMASQ_PID"
