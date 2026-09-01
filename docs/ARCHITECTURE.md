# Architecture

## Production topology

```text
iPhone
  |
  | WireGuard full tunnel
  | 0.0.0.0/0 + ::/0
  v
home router
  |
  | UDP 51820 port-forward
  v
Raspberry Pi / Docker
  |
  +--> wireguard
  |      |
  |      +--> vpn-egress network --> NAT --> Internet
  |      |
  |      +--> DNS listener 10.66.66.1:53
  |                |
  |                +--> vpn-dns internal network
  |                         |
  |                         +--> doh-a:53
  |                         +--> doh-b:53
  |
  +--> doh-a / doh-b (Docker-internal)
  |      +--> rule engine for VPN raw DNS
  |      +--> shared rules under data/rules/
  |      +--> shared SQLite statistics volume
  |
  +--> discovery-relay-vpn
  |      (shares wireguard network namespace)
  |                |
  |                | authenticated UDP control
  |                v
  +--> discovery-relay-host
  |      (host network, preferred LAN interface)
  |                |
  |                +--> mDNS 224.0.0.251:5353
  |                +--> SSDP 239.255.255.250:1900
  |
  +--> updater
  +--> telegram-bot
```

## Network boundary

The WireGuard service is not attached to the normal Compose application network.

It has:

- `vpn-egress`: outbound Internet access;
- `vpn-dns`: an internal-only network shared only with `doh-a` and `doh-b`.

This prevents a VPN client from receiving a route to updater, Telegram or the resolver admin HTTP API. DNS is exposed to the peer only through `10.66.66.1:53` inside the WireGuard interface.

No host DNS port is published.

## Local discovery boundary

WireGuard is a Layer-3 tunnel, so multicast discovery cannot be treated as a normal routed destination. The gateway therefore DNATs only these packets arriving from `wg0` to the VPN-side discovery relay:

- IPv4 mDNS/Bonjour: `224.0.0.251:5353/udp`;
- SSDP discovery: `239.255.255.250:1900/udp`.

`discovery-relay-vpn` shares the WireGuard network namespace and talks to `discovery-relay-host` over an HMAC-authenticated UDP control channel. The host relay uses `network_mode: host` so it can emit discovery packets directly on the Raspberry's preferred physical LAN interface; by default this is auto-detected from the lowest-metric IPv4 default route.

The proxy is intentionally one-purpose:

- VPN mDNS queries are sent to the LAN; LAN mDNS responses are returned to recently active VPN queriers;
- VPN SSDP `M-SEARCH` requests are sent to the LAN; corresponding unicast SSDP responses are returned to the original VPN source ports;
- arbitrary multicast, broadcasts, LAN-originated queries and VPN-originated service advertisements are not bridged.

The control channel reuses the existing admin token only as HMAC key material. Control datagrams have a timestamp, unique ID, replay protection and a size limit. Both relay containers run read-only, without Linux capabilities and with `no-new-privileges`.

## Resolver path

The resolver accepts raw UDP and TCP DNS on port 53 inside the `vpn-dns` network. Both
paths call the same filtering function before upstream resolution and share the same
allow/block rules and SQLite-backed statistics. Port 8053 remains Docker-internal for
health and authenticated administration only; it no longer serves DoH or iOS profiles.

## Persistent WireGuard state

Runtime WireGuard material lives under:

```text
data/wireguard/
```

The directory is ignored by Git and bind-mounted at `/config`.

The entrypoint follows create-if-missing semantics for:

- server private/public key;
- client private/public key;
- preshared key.

Container recreation regenerates derived configuration and QR files but never rotates existing keys.

## IPv6 policy

The iPhone peer receives a ULA address and `::/0` is present in `AllowedIPs`.

This is intentional even on networks where the Raspberry cannot provide working IPv6 egress: IPv6 is captured by WireGuard instead of bypassing the VPN over the phone's carrier/Wi-Fi interface.

The gateway attempts IPv6 forwarding/NAT through an IPv6-enabled Docker egress bridge. If the Raspberry/home ISP has no usable IPv6 egress, IPv6 Internet access can be unavailable while applications fall back to IPv4. A carrier/Wi-Fi IPv6 address visible while WireGuard is active is considered a leak and a failed Phase-1 verification.
