#!/bin/sh
set -eu

ACTION="${1:-status}"
CA_DIR="${HOST_REPO_DIR:-.}/data/mitmproxy"
PEM="$CA_DIR/mitmproxy-ca-cert.pem"
DER="$CA_DIR/mitmproxy-ca-cert.cer"
PUBLIC_DIR="${HOST_REPO_DIR:-.}/data/mitmproxy-public"
PUBLIC_DER="$PUBLIC_DIR/mitmproxy-ca-cert.cer"
VPN_CA_URL="http://10.66.66.1:8081/mitmproxy-ca-cert.cer"

observer_state() {
  CID="$(docker compose --profile https-lab ps -q mitmproxy 2>/dev/null || true)"
  if [ -z "$CID" ]; then
    printf '%s' "stopped"
    return
  fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || printf '%s' "unknown"
}

prepare_ca() {
  mkdir -p "$CA_DIR"
  docker compose --profile https-lab up -d --build mitmproxy

  for _ in $(seq 1 60); do
    if [ -s "$PEM" ] && [ "$(observer_state)" = "healthy" ]; then
      docker compose --profile https-lab stop mitmproxy >/dev/null 2>&1 || true
      echo "Public CA certificate ready: $PEM"
      return 0
    fi
    sleep 1
  done

  echo "Unable to generate the mitmproxy CA." >&2
  docker compose --profile https-lab logs --tail=100 mitmproxy >&2 || true
  exit 2
}

require_public_ca() {
  if [ ! -s "$PEM" ]; then
    echo "Public CA certificate not found. Run: sh scripts/mitmproxy-ca.sh prepare" >&2
    exit 2
  fi
}

run_python() {
  docker compose --profile https-lab run --rm --no-deps --entrypoint python mitmproxy -c "$1"
}

case "$ACTION" in
  prepare)
    prepare_ca
    ;;
  status)
    if [ -s "$PEM" ]; then
      echo "Public CA certificate ready: $PEM"
    else
      echo "Public CA certificate not generated yet."
      exit 1
    fi
    ;;
  path)
    require_public_ca
    printf '%s\n' "$PEM"
    ;;
  export-ios)
    require_public_ca
    run_python '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
src = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem")
dst = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.cer")
dst.write_bytes(x509.load_pem_x509_certificate(src.read_bytes()).public_bytes(Encoding.DER))
'
    mkdir -p "$PUBLIC_DIR"
    TMP_PUBLIC="$PUBLIC_DER.tmp.$$"
    cp "$DER" "$TMP_PUBLIC"
    chmod 0644 "$TMP_PUBLIC"
    mv -f "$TMP_PUBLIC" "$PUBLIC_DER"
    echo "iOS-installable public CA exported to: $DER"
    echo "With WireGuard connected, download it from: $VPN_CA_URL"
    ;;
  fingerprint)
    require_public_ca
    run_python '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes
cert = x509.load_pem_x509_certificate(Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem").read_bytes())
print(cert.fingerprint(hashes.SHA256()).hex(":").upper())
'
    ;;
  *)
    echo "Usage: $0 {prepare|status|path|export-ios|fingerprint}" >&2
    exit 2
    ;;
esac
