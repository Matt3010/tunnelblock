# TunnelBlock

Self-hosted mobile ad blocking through WireGuard, designed for Raspberry Pi and
managed from a web panel published through a Cloudflare Tunnel. iOS and Android clients use the same full-tunnel configuration;
no public DNS or administration endpoint is exposed.

## Features

| Capability | iOS | Android |
| --- | :---: | :---: |
| WireGuard full tunnel | ✅ | ✅ |
| DNS allow/block rules | ✅ | ✅ |
| QR and `.conf` onboarding | ✅ | ✅ |
| Multiple VPN peers | ✅ | ✅ |
| Web panel administration (via Cloudflare Tunnel) | ✅ | ✅ |
| Per-user LAN access with network discovery | ✅ | ✅ |

Filtering is DNS-based: there is no TLS interception and no CA to install.

## Quick start

Requirements: a Raspberry Pi or Linux host with Git, Docker Engine, Docker Compose
and a router capable of forwarding UDP/51820.

```bash
git clone https://github.com/Matt3010/tunnelblock.git
cd tunnelblock
sh ops/install.sh
```

The installer preserves an existing `.env`, never removes Docker volumes and never
touches existing WireGuard keys. See [docs/INSTALL.md](docs/INSTALL.md) before exposing
UDP/51820 on the router.

## Architecture

```text
Mobile device (iOS / Android)
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
  +--> updater (control API: VPN users, LAN access, service health)
  +--> proxy (nginx, 127.0.0.1:8092) <-- Cloudflare Tunnel (HTTPS)
  +--> web panel (Basic auth)
```

The WireGuard container is isolated from updater, the web panel and admin-only service endpoints. It reaches only the resolver replicas through an internal Docker network and the Internet through a separate egress network.

## Persistent state

Mutable data stays outside Git:

```text
data/rules/
data/wireguard/
```

SQLite and updater state use named Docker volumes.

WireGuard server/client private keys, the preshared key, generated client configuration and QR image are created at runtime under `data/wireguard/`. Existing files are reused, so `docker compose up -d --force-recreate` and updates do not rotate keys.

Never use `docker compose down -v` as part of normal deployment or recovery.

## WireGuard-only exposure

The resolver HTTP/admin API and raw DNS replicas are Docker-internal. The host publishes
only WireGuard UDP/51820. The web panel's nginx front listens on 127.0.0.1 and is
reached through the host's Cloudflare Tunnel; there is no public DoH, profile-download or resolver health endpoint.
The mobile device receives DNS `10.66.66.1` from its WireGuard configuration.

## WireGuard

The VPN provides:

- full-tunnel WireGuard for IPv4 and captured IPv6;
- NAT/forwarding through the Raspberry;
- VPN DNS routed through the existing rule engine;
- compressed DNS-name parsing and automatic UDP-to-TCP upstream fallback;
- IPv4/IPv6 upstream resolver support and configurable query rate limiting;
- in-memory LRU response cache that respects and ages upstream TTL values;
- persistent keys/configuration;
- platform-independent client configuration and QR generation;
- health checking.

Use **LAN access** on a user in the **VPN** page to choose which home-network devices and ports
that user may reach; see [docs/LAN-ACCESS.md](docs/LAN-ACCESS.md).

See [docs/WIREGUARD.md](docs/WIREGUARD.md) for router setup and VPN verification.

## Deployment

Deployments are manual, over SSH on the Raspberry: `git pull` then
`docker compose up -d --build --remove-orphans`. A push to `master` deploys nothing by
itself. See [docs/DEPLOY.md](docs/DEPLOY.md). Never use `docker compose down -v`.

## License

This project is open source under the [MIT License](LICENSE). You may use,
modify and redistribute it subject to the license notice.
