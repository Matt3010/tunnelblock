# Availability and recovery

The production client path is WireGuard-only. Do not run `docker compose down -v`, and never
delete `data/wireguard/` during recovery.

## Normal recovery

Deploy and roll back manually as described in [DEPLOY.md](DEPLOY.md); neither deletes
persistent data.

Check the stack with:

```bash
docker compose ps
docker compose exec -T wireguard /app/healthcheck.sh
docker compose exec -T wireguard wg show wg0
```

If the tunnel is unavailable, temporarily disable WireGuard in the official mobile app to restore
ordinary device connectivity while diagnosing the Raspberry, router UDP/51820 forwarding or ISP.
