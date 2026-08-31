# adblock-general-purpose

Self-hosted iOS ad-blocking stack running on a Raspberry Pi. Clients use a WireGuard
**full tunnel**; no public DNS-over-HTTPS endpoint is exposed.

## Architecture

```text
iPhone
  |
  | WireGuard
  | AllowedIPs = 0.0.0.0/0, ::/0
  v
home router
  |
  | UDP 51820
  v
Raspberry Pi / Docker
  |
  +--> wireguard gateway
  |      +--> NAT / Internet egress
  |      +--> local VPN DNS 10.66.66.1:53
  |               |
  |               +--> doh-a:53
  |               +--> doh-b:53
  |
  +--> doh-a + doh-b (Docker-internal only)
  |      +--> shared allow/block rules
  |      +--> shared persistent SQLite statistics
  |
  +--> updater
  +--> telegram-bot
```

The WireGuard container is isolated from updater, Telegram and admin-only service endpoints. It reaches only the resolver replicas through an internal Docker network and the Internet through a separate egress network.

## Persistent state

Mutable data stays outside Git:

```text
data/rules/
data/wireguard/
```

SQLite, updater state and Telegram state use named Docker volumes.

WireGuard server/client private keys, the preshared key, generated client configuration and QR image are created at runtime under `data/wireguard/`. Existing files are reused, so `docker compose up -d --force-recreate` and automatic updates do not rotate keys.

Never use `docker compose down -v` as part of normal deployment or recovery.

## WireGuard-only exposure

The resolver HTTP/admin API and raw DNS replicas are Docker-internal. The host publishes
only WireGuard UDP/51820; there is no public DoH, profile-download or resolver health endpoint.
The iPhone receives DNS `10.66.66.1` from its WireGuard configuration.

After preparing the private CA, its public certificate is available only inside the VPN at
`http://10.66.66.1:8081/mitmproxy-ca-cert.cer`. Docker does not publish this port on the host.

## WireGuard Phase 1

Phase 1 provides only:

- full-tunnel WireGuard for IPv4 and captured IPv6;
- NAT/forwarding through the Raspberry;
- VPN DNS routed through the existing rule engine;
- persistent keys/configuration;
- iPhone client configuration and QR generation;
- health checking and updater integration.

It does **not** implement HTTPS/TLS interception, a private CA, transparent proxying, QUIC blocking or YouTube request-level filtering.

See [docs/WIREGUARD.md](docs/WIREGUARD.md) for router setup, iPhone import and verification.

## Phase 2 HTTPS observation lab

The repository now also contains a diagnostic transparent-proxy lab for YouTube testing.

It is designed to be safe by default:

- the `mitmproxy` service itself is stopped by default and has no host/router port exposure;
- `scripts/https-intercept.sh enable` starts the observer and only then installs the HTTPS redirect;
- QUIC blocking is disabled until `scripts/quic.sh block` is run;
- the private CA and logs persist only under ignored `data/mitmproxy/`;
- only metadata for YouTube-related hosts is written;
- headers, cookies, query strings and request/response bodies are not persisted;
- no YouTube blocking rule is installed.

See [docs/HTTPS-OBSERVATION.md](docs/HTTPS-OBSERVATION.md) for the go/no-go test and rollback commands.

Captured metadata can be summarized without exposing individual hosts, paths or payloads:

```bash
python3 scripts/analyze-youtube-observations.py
```

The report now focuses on InnerTube protobuf discovery: aggregate ad-marker counts and the nearest plausible protobuf field plus distance statistics for those markers. The old path-level ad/playback classifier was removed after real-device temporal testing showed that the same endpoint families occur during both ads and normal content.

The protobuf mutation mechanism is present but inert by default. It requires both `PROTOBUF_BLOCKING_ENABLED=true` and an explicit, validated `PROTOBUF_BLOCK_FIELD_TAGS` list; the repository ships with blocking disabled and an empty field list.

## Deployment

The updater watches `master`. A deployment runs the current `ops/deploy.sh`, which:

1. validates the Compose configuration;
2. builds the complete stack;
3. syntax-checks WireGuard scripts and tests the Phase-2 metadata analyzer;
4. runs DNS tests;
5. runs TypeScript checks for DNS, Telegram and updater;
6. recreates the stack only after pre-flight checks pass;
7. verifies service health and updater revision;
8. rolls back to the previous SHA if deployment fails.

Persistent data is not reset during this process.

## YouTube

DNS-only filtering cannot safely distinguish YouTube ads from normal video delivery when both use shared Google infrastructure.

The real iPhone go/no-go test confirmed that the official app can be observed over TCP after QUIC is disabled. Temporal comparison then showed that request-path categories such as playback, page-ad and telemetry endpoints overlap across ad and normal-content windows, so they are not treated as safe blocking signals. The current experiment instead discovers ad-bearing InnerTube protobuf fields before any mutation is enabled.
