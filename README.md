# adblock-general-purpose

Self-hosted iOS ad-blocking stack running on a Raspberry Pi.

The primary client path is now a WireGuard **full tunnel**. The existing public DNS-over-HTTPS endpoint remains available and is not replaced by the VPN.

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
  +--> doh-a + doh-b
  |      +--> shared allow/block rules
  |      +--> shared persistent SQLite statistics
  |
  +--> doh-proxy
  |      +--> public /dns-query, /install, /health only
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

## Existing public DoH

The current endpoint remains:

```text
https://adblock.scanferlamatteo.work/dns-query
```

Cloudflare Tunnel continues to terminate the public path and Caddy exposes only:

- `/dns-query`
- `/install`
- `/health`

Admin endpoints remain Docker-internal.

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

- `mitmproxy` runs with no host/router port exposure;
- HTTPS interception is disabled until `scripts/https-intercept.sh enable` is run;
- QUIC blocking is disabled until `scripts/quic.sh block` is run;
- the private CA and logs persist only under ignored `data/mitmproxy/`;
- only metadata for YouTube-related hosts is written;
- headers, cookies, query strings and request/response bodies are not persisted;
- no YouTube blocking rule is installed.

See [docs/HTTPS-OBSERVATION.md](docs/HTTPS-OBSERVATION.md) for the go/no-go test and rollback commands.

## Deployment

The updater watches `master`. A deployment runs the current `ops/deploy.sh`, which:

1. validates the Compose configuration;
2. builds the complete stack;
3. syntax-checks WireGuard scripts;
4. runs DNS tests;
5. runs TypeScript checks for DNS, Telegram and updater;
6. recreates the stack only after pre-flight checks pass;
7. verifies service health and updater revision;
8. rolls back to the previous SHA if deployment fails.

Persistent data is not reset during this process.

## YouTube

DNS-only filtering cannot safely distinguish YouTube ads from normal video delivery when both use shared Google infrastructure.

The existing DNS capture tooling is retained for diagnostics, but the next YouTube phase is explicitly measurement-first: transparent HTTPS interception will only be considered after a go/no-go test for TLS interception, certificate pinning and QUIC behavior. No claim is made that the official YouTube iOS app can be filtered at request level until that is demonstrated.
