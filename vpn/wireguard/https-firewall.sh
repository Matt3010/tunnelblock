#!/bin/sh
set -eu

WG_IF="${WG_INTERFACE:-wg0}"
IPV4_SUBNET="${WG_IPV4_SUBNET:-10.66.66.0/24}"
IPV6_SUBNET="${WG_IPV6_SUBNET:-fd42:66:66::/64}"
MITM_PORT="${MITM_TRANSPARENT_PORT:-8080}"

HTTPS4_COMMENT="adblock-https-intercept-v4"
HTTPS6_COMMENT="adblock-https-intercept-v6"
QUIC4_COMMENT="adblock-https-quic-v4"
QUIC6_COMMENT="adblock-https-quic-v6"

https4_present() {
  iptables -t nat -C PREROUTING -i "$WG_IF" -s "$IPV4_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS4_COMMENT" -j REDIRECT --to-ports "$MITM_PORT" >/dev/null 2>&1
}

https6_block_present() {
  command -v ip6tables >/dev/null 2>&1 || return 1
  ip6tables -C FORWARD -i "$WG_IF" -s "$IPV6_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS6_COMMENT" -j REJECT >/dev/null 2>&1
}

quic4_present() {
  iptables -C FORWARD -i "$WG_IF" -s "$IPV4_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC4_COMMENT" -j REJECT >/dev/null 2>&1
}

quic6_present() {
  command -v ip6tables >/dev/null 2>&1 || return 1
  ip6tables -C FORWARD -i "$WG_IF" -s "$IPV6_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC6_COMMENT" -j REJECT >/dev/null 2>&1
}

ipv6_active() {
  command -v ip6tables >/dev/null 2>&1 \
    && ip -6 address show dev "$WG_IF" 2>/dev/null | grep -q 'inet6 '
}

enable_interception() {
  if ! https4_present; then
    iptables -t nat -A PREROUTING -i "$WG_IF" -s "$IPV4_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS4_COMMENT" -j REDIRECT --to-ports "$MITM_PORT"
  fi

  if ipv6_active && ! https6_block_present; then
    ip6tables -I FORWARD 1 -i "$WG_IF" -s "$IPV6_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS6_COMMENT" -j REJECT
  fi
}

disable_interception() {
  while https4_present; do
    iptables -t nat -D PREROUTING -i "$WG_IF" -s "$IPV4_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS4_COMMENT" -j REDIRECT --to-ports "$MITM_PORT"
  done

  if command -v ip6tables >/dev/null 2>&1; then
    while https6_block_present; do
      ip6tables -D FORWARD -i "$WG_IF" -s "$IPV6_SUBNET" -p tcp --dport 443 -m comment --comment "$HTTPS6_COMMENT" -j REJECT
    done
  fi
}

block_quic() {
  if ! quic4_present; then
    iptables -I FORWARD 1 -i "$WG_IF" -s "$IPV4_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC4_COMMENT" -j REJECT
  fi

  if ipv6_active && ! quic6_present; then
    ip6tables -I FORWARD 1 -i "$WG_IF" -s "$IPV6_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC6_COMMENT" -j REJECT
  fi
}

allow_quic() {
  while quic4_present; do
    iptables -D FORWARD -i "$WG_IF" -s "$IPV4_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC4_COMMENT" -j REJECT
  done

  if command -v ip6tables >/dev/null 2>&1; then
    while quic6_present; do
      ip6tables -D FORWARD -i "$WG_IF" -s "$IPV6_SUBNET" -p udp --dport 443 -m comment --comment "$QUIC6_COMMENT" -j REJECT
    done
  fi
}

case "${1:-}:${2:-}" in
  interception:enable)
    enable_interception
    echo "enabled"
    ;;
  interception:disable)
    disable_interception
    echo "disabled"
    ;;
  interception:status)
    if https4_present; then echo "enabled"; else echo "disabled"; fi
    ;;
  quic:block)
    block_quic
    echo "blocked"
    ;;
  quic:allow)
    allow_quic
    echo "allowed"
    ;;
  quic:status)
    if quic4_present; then echo "blocked"; else echo "allowed"; fi
    ;;
  *)
    echo "Usage: $0 interception {enable|disable|status} | quic {block|allow|status}" >&2
    exit 2
    ;;
esac
