# TunnelBlock installation

## Requirements

- Raspberry Pi or Linux host with a supported Docker Engine and Docker Compose v2;
- Git and OpenSSL;
- Telegram bot token from BotFather;
- numeric Telegram user ID allowed to administer the stack;
- GitHub token with read access, used by the updater;
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

Then forward UDP/51820 to the Raspberry Pi, open `/vpn` in Telegram, create a peer and
import its QR code in the official WireGuard app on iOS or Android.

## Updates

After bootstrap, use only:

```text
/update
/update_status
```

Do not run `ops/deploy.sh` directly. Never run `docker compose down -v` and never delete
`data/wireguard/` during an update or recovery.

## Verification

```bash
docker compose ps
docker compose exec -T wireguard /app/healthcheck.sh
docker compose exec -T wireguard wg show wg0
```

See [WIREGUARD.md](WIREGUARD.md) for the full remote-connectivity test.
