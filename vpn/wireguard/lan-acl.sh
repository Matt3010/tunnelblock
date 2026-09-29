#!/bin/sh
set -eu

# Per-peer LAN access control.
#
# FORWARD -i wg0 -o <egress> -> TB_LAN
#   TB_LAN        : private destinations only -> TB_LAN_PRIV (Internet returns)
#   TB_LAN_PRIV   : TB_LAN_PEERS, then REJECT
#   TB_LAN_PEERS  : per-peer ACCEPT rules, rebuilt atomically by `apply`
#
# The terminal REJECT never moves, so rebuilding peer rules fails closed.

CONFIG_DIR="${WG_CONFIG_DIR:-/config}"
PEERS_DIR="$CONFIG_DIR/peers"
LAN_RANGES="${WG_LAN_RANGES:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16}"
LAN6_RANGES="${WG_LAN6_RANGES:-fc00::/7,fe80::/10}"

ensure_chain() {
  TOOL="$1"
  CHAIN="$2"
  "$TOOL" -N "$CHAIN" 2>/dev/null || "$TOOL" -F "$CHAIN"
}

init_family() {
  TOOL="$1"
  RANGES="$2"
  REJECT_WITH="$3"

  ensure_chain "$TOOL" TB_LAN_PEERS
  ensure_chain "$TOOL" TB_LAN_PRIV
  ensure_chain "$TOOL" TB_LAN

  "$TOOL" -A TB_LAN_PRIV -j TB_LAN_PEERS
  "$TOOL" -A TB_LAN_PRIV -j REJECT --reject-with "$REJECT_WITH"

  OLD_IFS="$IFS"
  IFS=','
  for RANGE in $RANGES; do
    IFS="$OLD_IFS"
    RANGE="$(printf '%s' "$RANGE" | tr -d ' ')"
    [ -n "$RANGE" ] && "$TOOL" -A TB_LAN -d "$RANGE" -j TB_LAN_PRIV
    IFS=','
  done
  IFS="$OLD_IFS"
}

teardown_family() {
  TOOL="$1"
  for CHAIN in TB_LAN TB_LAN_PRIV TB_LAN_PEERS; do
    "$TOOL" -F "$CHAIN" 2>/dev/null || true
  done
  for CHAIN in TB_LAN TB_LAN_PRIV TB_LAN_PEERS; do
    "$TOOL" -X "$CHAIN" 2>/dev/null || true
  done
}

# Prints "full", or one validated rule per line (IP/any, IP/tcp/PORT, IP/udp/PORT).
# A peer without a policy file predates LAN ACLs and keeps its former full access.
peer_policy() {
  POLICY="$1/lan"
  if [ ! -f "$POLICY" ]; then
    echo full
    return
  fi
  if grep -qx full "$POLICY"; then
    echo full
    return
  fi
  grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/(any|(tcp|udp)/[0-9]{1,5})$' "$POLICY" || true
}

ipv4_rules() {
  for PDIR in "$PEERS_DIR"/*; do
    [ -d "$PDIR" ] && [ -s "$PDIR/ipv4" ] || continue
    SRC="$(sed -n '1p' "$PDIR/ipv4")"
    peer_policy "$PDIR" | while IFS= read -r RULE; do
      case "$RULE" in
        full)
          echo "-A TB_LAN_PEERS -s $SRC/32 -j ACCEPT"
          ;;
        */any)
          echo "-A TB_LAN_PEERS -s $SRC/32 -d ${RULE%/any}/32 -j ACCEPT"
          ;;
        */tcp/*|*/udp/*)
          HOST="${RULE%%/*}"
          REST="${RULE#*/}"
          echo "-A TB_LAN_PEERS -s $SRC/32 -d $HOST/32 -p ${REST%/*} --dport ${REST#*/} -j ACCEPT"
          echo "-A TB_LAN_PEERS -s $SRC/32 -d $HOST/32 -p icmp --icmp-type echo-request -j ACCEPT"
          ;;
      esac
    done
  done | awk '!seen[$0]++'
}

# Custom rules are IPv4-only: discovered LAN services are IPv4. Only full-access
# peers may reach private IPv6 destinations.
ipv6_rules() {
  for PDIR in "$PEERS_DIR"/*; do
    [ -d "$PDIR" ] && [ -s "$PDIR/ipv6" ] || continue
    if [ "$(peer_policy "$PDIR" | sed -n '1p')" = "full" ]; then
      echo "-A TB_LAN_PEERS -s $(sed -n '1p' "$PDIR/ipv6")/128 -j ACCEPT"
    fi
  done
}

apply() {
  {
    echo '*filter'
    echo ':TB_LAN_PEERS - [0:0]'
    ipv4_rules
    echo 'COMMIT'
  } | iptables-restore --noflush

  if ip6tables -S TB_LAN_PRIV >/dev/null 2>&1; then
    {
      echo '*filter'
      echo ':TB_LAN_PEERS - [0:0]'
      ipv6_rules
      echo 'COMMIT'
    } | ip6tables-restore --noflush
  fi
}

case "${1:-}" in
  init)
    init_family iptables "$LAN_RANGES" icmp-admin-prohibited
    ;;
  init6)
    init_family ip6tables "$LAN6_RANGES" icmp6-adm-prohibited
    ;;
  apply)
    apply
    ;;
  teardown)
    teardown_family iptables
    teardown_family ip6tables
    ;;
  *)
    echo "Usage: $0 init|init6|apply|teardown" >&2
    exit 2
    ;;
esac
