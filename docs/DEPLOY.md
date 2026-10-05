# Deploying changes

Deployments are manual. Nothing pulls from GitHub on its own and the web panel has no
update button, so a push to `master` changes nothing on the Raspberry until you deploy it.

On the Raspberry:

```bash
cd ~/adblock-general-purpose
git pull
docker compose up -d --build --remove-orphans
docker compose ps
```

`--build` rebuilds only images whose sources changed, and Compose recreates only the
containers whose image or configuration changed. If the WireGuard image changes, VPN
clients see a brief interruption while it restarts.

Persistent data lives in `data/` and in named volumes, so it survives every deployment.
Never run `docker compose down -v` and never delete `data/wireguard/`.

## Rolling back

```bash
git log --oneline -5
git checkout <previous-sha>
docker compose up -d --build --remove-orphans
```

Return to the branch with `git checkout master` once the fix is pushed.

## The `updater` service

Despite its name, `updater` no longer deploys anything. It is the control API behind the
web panel: VPN users, LAN access, network discovery, the daily blocklist refresh and
service health.
