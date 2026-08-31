#!/bin/sh
set -eu

docker compose --profile https-lab ps wireguard mitmproxy
printf '\n'
sh scripts/https-intercept.sh status
sh scripts/quic.sh status
sh scripts/youtube-ump-capture.sh status

CA_PATH="${HOST_REPO_DIR:-.}/data/mitmproxy/mitmproxy-ca-cert.pem"
LOG_PATH="${HOST_REPO_DIR:-.}/data/mitmproxy/observations/metadata.jsonl"

if [ -s "$CA_PATH" ]; then
  echo "CA public certificate: ready at $CA_PATH"
else
  echo "CA public certificate: not generated yet"
fi

if [ -f "$LOG_PATH" ]; then
  echo "Observation log: $LOG_PATH"
else
  echo "Observation log: empty/not created yet"
fi
