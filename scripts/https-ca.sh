#!/bin/sh
set -eu

ACTION="${1:-status}"
DATA_DIR="./data/https"
PUBLIC_DIR="./data/https/public"
PEM="$DATA_DIR/mitmproxy-ca-cert.pem"
DER="$DATA_DIR/mitmproxy-ca-cert.cer"
PUBLIC_DER="$PUBLIC_DIR/adblock-general-purpose-ca.cer"

proxy_state() {
  CID="$(docker compose --profile https-lab ps -q https-proxy 2>/dev/null || true)"
  if [ -z "$CID" ]; then
    printf '%s' "stopped"
    return
  fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || printf '%s' "unknown"
}

wait_proxy() {
  for _ in $(seq 1 60); do
    STATE="$(proxy_state)"
    if [ "$STATE" = "healthy" ]; then
      return 0
    fi
    if [ "$STATE" = "exited" ] || [ "$STATE" = "dead" ]; then
      break
    fi
    sleep 1
  done
  docker compose --profile https-lab logs --tail=100 https-proxy >&2 || true
  return 1
}

prepare() {
  mkdir -p "$DATA_DIR" "$PUBLIC_DIR"

  if [ -s "$PEM" ] && [ -s "$DER" ] && [ -s "$PUBLIC_DER" ]; then
    echo "ready"
    return
  fi

  HTTPS_ACTIVE_STRATEGY="" HTTPS_MODE="disabled"     docker compose --profile https-lab up -d --build --force-recreate https-proxy

  if ! wait_proxy; then
    docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true
    echo "Unable to start HTTPS proxy while generating CA." >&2
    exit 2
  fi

  for _ in $(seq 1 30); do
    [ -s "$PEM" ] && break
    sleep 1
  done

  docker compose --profile https-lab stop https-proxy >/dev/null 2>&1 || true

  if [ ! -s "$PEM" ]; then
    echo "mitmproxy CA was not generated." >&2
    exit 3
  fi

  docker compose --profile https-lab run --rm --no-deps --entrypoint python https-proxy -c '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
src = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem")
dst = Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.cer")
dst.write_bytes(x509.load_pem_x509_certificate(src.read_bytes()).public_bytes(Encoding.DER))
'

  if [ ! -s "$DER" ]; then
    echo "Unable to export iOS CA certificate." >&2
    exit 4
  fi

  TMP="$PUBLIC_DER.tmp.$$"
  cp "$DER" "$TMP"
  chmod 0644 "$TMP"
  mv -f "$TMP" "$PUBLIC_DER"
  echo "ready"
}

case "$ACTION" in
  prepare)
    prepare
    ;;
  status)
    if [ -s "$PUBLIC_DER" ]; then
      echo "ready"
    else
      echo "missing"
    fi
    ;;
  fingerprint)
    if [ ! -s "$PEM" ]; then
      echo "CA not prepared" >&2
      exit 2
    fi
    docker compose --profile https-lab run --rm --no-deps --entrypoint python https-proxy -c '
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes
cert = x509.load_pem_x509_certificate(Path("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem").read_bytes())
print(cert.fingerprint(hashes.SHA256()).hex(":").upper())
'
    ;;
  *)
    echo "Usage: $0 {prepare|status|fingerprint}" >&2
    exit 2
    ;;
esac
