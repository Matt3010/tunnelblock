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
  +--> updater
  +--> telegram-bot
```

## Network boundary

The WireGuard service is not attached to the normal Compose application network.

It has:

- `vpn-egress`: outbound Internet access;
- `vpn-dns`: an internal-only network shared only with `doh-a` and `doh-b`.

This prevents a VPN client from receiving a route to updater, Telegram or the resolver admin HTTP API. DNS is exposed to the peer only through `10.66.66.1:53` inside the WireGuard interface.

The namespace also serves the public mitmproxy CA certificate on `10.66.66.1:8081`.
Its read-only document root is a separate bind mount containing only the DER certificate;
private CA material is never mounted into the gateway. Port 8081 is bound to the WireGuard
address and is not published by Docker or forwarded by the router.

No host DNS port is published.

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


## Phase 2 HTTPS observation namespace

The diagnostic `mitmproxy` service uses:

```yaml
network_mode: "service:wireguard"
```

so it shares the WireGuard network namespace without being attached to the normal application network and without publishing a host port.

Normal state:

```text
iPhone TCP/443 -> WireGuard FORWARD -> Internet
```

Observation state:

```text
iPhone TCP/443
  -> PREROUTING REDIRECT in the WireGuard namespace
  -> local :8080
  -> mitmproxy transparent mode
  -> Internet
```

The redirect rule is not created by container startup. It exists only after the explicit Phase-2 enable command and disappears on disable or WireGuard recreation.

QUIC remains independent. UDP/443 is allowed by default and can be temporarily rejected to force a TCP fallback during the go/no-go test.

IPv6 TCP/443 is temporarily rejected while interception is enabled rather than being allowed to bypass the IPv4 transparent proxy.

The proxy's persistent runtime directory is:

```text
data/mitmproxy/
```

It contains the private CA and minimized observation metadata and is covered by the repository's existing `data/` ignore rule.

The offline observation analyzer reads that JSONL file and emits aggregate counters only. Its candidate ad/playback labels are diagnostic output and are not connected to mitmproxy request handling or firewall rules.

No mitmproxy endpoint or CA material is exposed publicly.
