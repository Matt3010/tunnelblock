# WireGuard full-tunnel gateway

## Scope

This document covers Phase 1 only.

Expected result:

```text
WireGuard ON
  -> Internet works
  -> public IPv4 = home connection
  -> DNS is handled by the existing blocker
  -> IPv4 and IPv6 routes are captured by the tunnel
```

There is no TLS interception, private CA, transparent HTTPS proxy, QUIC blocking or YouTube request classification in this phase.

## Runtime files and key persistence

The first successful start creates:

```text
data/wireguard/
  server_private.key
  server_public.key
  wg0.conf
  peers/
    iphone/
      private.key
      public.key
      preshared.key
      iphone.conf
      iphone.png
```

`data/` is already ignored by Git.

The container only generates a key when the corresponding persistent file is absent. Recreating the service with `--force-recreate`, updating the repository, rebuilding images or rolling back does not rotate those keys.

Do not delete `data/wireguard/` unless you intentionally want to revoke and replace the VPN identity.

## Endpoint

Default behavior:

```env
WG_SERVER_ENDPOINT=auto
```

On container start, the gateway discovers the current public IPv4 and writes it into the generated iPhone configuration.

If the home connection has a stable DDNS hostname, set this in the Raspberry repository's local `.env`:

```env
WG_SERVER_ENDPOINT=vpn.example.net
```

This value is not a secret.

A normal IPv4 router port-forward requires a publicly reachable WAN IPv4. If the ISP places the home connection behind CGNAT, forwarding UDP 51820 on the local router is not sufficient; obtain a public IPv4 from the ISP or use another directly reachable endpoint strategy.

## Router port forwarding

Create exactly this inbound NAT rule:

```text
Protocol:       UDP only
External port:  51820
Internal IP:    <Raspberry Pi LAN IPv4>
Internal port:  51820
```

Do not create a TCP rule.

Do not expose:

- port 53;
- updater port 8090;
- resolver admin routes;
- Telegram/control APIs.

## Import the iPhone client

After the WireGuard service is healthy, run on the Raspberry:

```bash
sh scripts/wireguard-client.sh qr
```

In the official WireGuard iOS app:

1. tap **Add a tunnel**;
2. choose **Create from QR code**;
3. scan the QR shown in the Raspberry terminal;
4. save the tunnel;
5. enable it.

To print the raw client file instead:

```bash
sh scripts/wireguard-client.sh conf
```

The QR and raw configuration contain the client's private key and preshared key. Treat both as secrets and do not paste them into GitHub, Telegram logs or support messages.

## Important: old managed DoH profile

For the Phase-1 DNS verification, temporarily disable/remove the previously installed managed DoH profile on the iPhone.

Otherwise iOS may continue sending encrypted DNS to the public DoH endpoint, which still travels through the VPN but makes it impossible to prove that the WireGuard-provided DNS server `10.66.66.1` is being used directly.

The public DoH service itself remains available and unchanged.

## Verification

Perform the first remote test with **Wi-Fi disabled on the iPhone** and cellular data enabled. This avoids false negatives caused by routers that do not support NAT loopback/hairpin.

### 1. Check WireGuard handshake

Enable the tunnel on the iPhone, then on the Raspberry:

```bash
docker compose exec -T wireguard wg show wg0
```

The iPhone peer must show:

- a recent `latest handshake`;
- increasing receive/transmit counters.

### 2. Check the public IPv4

On the Raspberry:

```bash
curl -4 https://api.ipify.org ; echo
```

Note the result.

With Wi-Fi still disabled and WireGuard enabled on the iPhone, open an IP-check site in Safari.

The iPhone public IPv4 must equal the Raspberry/home public IPv4. If it shows the mobile carrier address, the full tunnel is not working.

### 3. Check DNS reaches the existing blocker

On the Raspberry:

```bash
docker compose logs -f doh-a doh-b
```

Then open a hostname not recently cached on the iPhone.

You should see DNS queries in the existing resolver logs. They also feed the same persistent SQLite statistics and existing Telegram diagnostics.

The VPN DNS path is:

```text
iPhone
  -> 10.66.66.1:53
  -> dnsmasq inside wireguard
  -> doh-a/doh-b:53
  -> existing rule engine
  -> upstream DNS
```

### 4. Check IPv6 cannot bypass the tunnel

With WireGuard enabled, use an IPv6 test site from the iPhone.

Acceptable Phase-1 outcomes:

- IPv6 works and the visible IPv6 belongs to the home connection; or
- IPv6 is unavailable and traffic uses the working IPv4 tunnel.

Failure:

- an IPv6 address belonging to the mobile carrier or the remote Wi-Fi network is visible while WireGuard is enabled.

### 5. Check all-route configuration

The generated client configuration must contain:

```text
AllowedIPs = 0.0.0.0/0, ::/0
DNS = 10.66.66.1
```

You can inspect it locally on the Raspberry with:

```bash
sh scripts/wireguard-client.sh conf
```

Remember that this command prints secrets.

## Health and status

Compose health:

```bash
docker compose ps
```

WireGuard detail:

```bash
docker compose exec -T wireguard wg show wg0
```

The WireGuard healthcheck validates the persistent client configuration, `wg0`, the UDP listen port and the local DNS forwarder process.

## Legacy IKEv2 material

`vpn/strongswan/` is retained as historical IKEv2 material only.

It is not wired into the active Compose stack and is not deleted by the WireGuard implementation.
