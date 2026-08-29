# Availability and recovery

The primary DoH endpoint is served by two resolver replicas behind a stable Caddy proxy.

```text
Cloudflare Tunnel
      |
      v
doh-proxy :8053
   |        |
   v        v
doh-a     doh-b
```

During a normal deployment, update one resolver at a time. Do not use `docker compose down`.

Use:

```bash
sh scripts/deploy.sh
```

## If the Raspberry Pi or Cloudflare Tunnel is completely offline

A local redundant container cannot protect against power loss, ISP loss, Raspberry failure or Cloudflare Tunnel failure.

On the iPhone, remove/disable the AdBlock DNS profile temporarily:

```text
Settings
-> General
-> VPN & Device Management
-> AdBlock General Purpose
-> Remove Profile
```

The phone will immediately return to the network-provided DNS.

Once:

```text
https://adblock.scanferlamatteo.work/health
```

is healthy again, reinstall from:

```text
https://adblock.scanferlamatteo.work/install
```

A true automatic off-site fallback requires a second independently hosted DoH endpoint.
