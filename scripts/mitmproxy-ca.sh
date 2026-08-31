#!/bin/sh
set -eu

ACTION="${1:-status}"
CA_DIR="${HOST_REPO_DIR:-.}/data/mitmproxy"
PEM="$CA_DIR/mitmproxy-ca-cert.pem"
DER="$CA_DIR/mitmproxy-ca-cert.cer"

require_public_ca() {
  if [ ! -s "$PEM" ]; then
    echo "Public CA certificate not found yet. Ensure the mitmproxy service is healthy." >&2
    exit 2
  fi
}

case "$ACTION" in
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
    docker compose exec -T mitmproxy python -c '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
src = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem")
dst = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.cer")
dst.write_bytes(x509.load_pem_x509_certificate(src.read_bytes()).public_bytes(Encoding.DER))
'
    echo "iOS-installable public CA exported to: $DER"
    ;;
  fingerprint)
    require_public_ca
    docker compose exec -T mitmproxy python -c '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes
cert = x509.load_pem_x509_certificate(Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem").read_bytes())
print(cert.fingerprint(hashes.SHA256()).hex(":").upper())
'
    ;;
  *)
    echo "Usage: $0 {status|path|export-ios|fingerprint}" >&2
    exit 2
    ;;
esac
