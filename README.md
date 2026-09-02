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
  +--> https-proxy (opt-in profile, stopped by default)
  |      +--> application strategy registry
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

## WireGuard

The VPN provides:

- full-tunnel WireGuard for IPv4 and captured IPv6;
- NAT/forwarding through the Raspberry;
- VPN DNS routed through the existing rule engine;
- compressed DNS-name parsing and automatic UDP-to-TCP upstream fallback;
- IPv4/IPv6 upstream resolver support and configurable query rate limiting;
- in-memory LRU response cache that respects and ages upstream TTL values;
- persistent keys/configuration;
- iPhone client configuration and QR generation;
- health checking and updater integration.

Normal filtering remains DNS-based. An opt-in HTTPS integration lab can temporarily intercept TLS traffic for registered application strategies; it is stopped by default and managed from Telegram.

Use `/integrations` in the Telegram bot to manage registered app strategies and observation sessions. The registry is currently empty. Only the public CA certificate can be downloaded; its private key never leaves the Raspberry Pi.

See [docs/WIREGUARD.md](docs/WIREGUARD.md) for router setup and VPN verification, and [docs/HTTPS-INTEGRATIONS.md](docs/HTTPS-INTEGRATIONS.md) for the HTTPS strategy architecture and safety model.

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

## License

This project is open source under the [MIT License](LICENSE). You may use,
modify and redistribute it subject to the license notice.
