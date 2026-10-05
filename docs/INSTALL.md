# TunnelBlock installation

## Requirements

- Raspberry Pi or Linux host with a supported Docker Engine and Docker Compose v2;
- Git and OpenSSL;
- router access for one UDP/51820 port-forward;
- public IPv4 or a reachable DDNS hostname (CGNAT requires another endpoint strategy).

## One-time bootstrap

```bash
git clone https://github.com/Matt3010/tunnelblock.git
cd tunnelblock
sh ops/install.sh
```

The installer creates `.env` only when it does not already exist, generates a random
admin API token, validates Compose and asks before the initial build/start. It never
deletes volumes or existing material under `data/wireguard/`.

Then forward UDP/51820 to the Raspberry Pi, publish the [web panel](WEB.md) through
your Cloudflare Tunnel, log in with the credentials printed by the installer, create a
VPN user in **VPN** and
import its QR code in the official WireGuard app on iOS or Android.

## Updates

Deploy manually over SSH, see [DEPLOY.md](DEPLOY.md). Never run `docker compose down -v` and never delete
`data/wireguard/` during an update or recovery.

## Verification

```bash
docker compose ps
docker compose exec -T wireguard /app/healthcheck.sh
docker compose exec -T wireguard wg show wg0
```

See [WIREGUARD.md](WIREGUARD.md) for the full remote-connectivity test.
