# System-agnostic updater

The updater container checks the private GitHub repository for changes to `master`.

Default polling interval:

```text
300 seconds (5 minutes)
```

Telegram fallbacks remain available:

```text
/update
/update_status
```

## Current deployment flow

For a detected target SHA:

1. `updater/bootstrap-update.sh` fetches `origin/master`;
2. it records the previous SHA;
3. it resets the working tree to the exact target SHA;
4. it executes the target checkout's `ops/deploy.sh`;
5. Compose configuration is validated;
6. every image is built while the current runtime is still active;
7. WireGuard shell scripts are syntax-checked;
8. DNS tests run;
9. TypeScript checks run for DNS, Telegram and updater;
10. only after pre-flight succeeds, the complete stack is recreated;
11. service health and updater build SHA are verified;
12. any failure triggers a reset/rebuild/recreate of the previous SHA.

Deployment state and logs persist in the updater data volume.

## Persistent data boundary

Mutable DNS rules live under:

```text
data/rules/
```

WireGuard runtime identity lives under:

```text
data/wireguard/
```

Both paths are ignored by Git and survive `git reset --hard` as well as container recreation.

WireGuard uses create-if-missing key generation. Therefore an automatic deployment using `docker compose up -d --force-recreate --remove-orphans` reuses the existing server/client private keys and preshared key.

Named volumes preserve:

- DNS SQLite statistics;
- updater state/logs;
- Telegram state.

Normal deployment never invokes `docker compose down -v`.

## Rollback

The rollback path returns the repository to the previous SHA, rebuilds it and recreates the previous stack with orphan removal.

This matters when a failed target introduced a new service: the orphaned target service is removed after the repository is reset instead of being left running outside the previous Compose definition.

Persistent state is not deleted during rollback.

## Configuration

The GitHub token stays in the local Raspberry `.env` and is never committed.

For a private repository, it only needs repository Contents read access.

## Security

The updater mounts `/var/run/docker.sock`, which is effectively host-administrator capability.

Its API is not published externally and remains protected by `ADMIN_API_TOKEN`.

The WireGuard client network is isolated from the updater and other control-plane services.
