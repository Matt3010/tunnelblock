# System-agnostic updater

The updater container automatically checks GitHub for changes to `master`.

Default polling interval:

```text
300 seconds (5 minutes)
```

Normal workflow:

```text
push to master
  -> updater detects new SHA
  -> rolling deploy
  -> Telegram notification
```

No SSH command and no manual `/update` is required for normal deployments.

Telegram commands remain available as fallbacks:

```text
/update
/update_status
```

The updater:

1. fetches `master` from GitHub;
2. compares the remote SHA with the local checkout;
3. when they differ, starts a rolling update;
4. rebuilds images while the current resolvers remain online;
5. replaces `doh-a` and waits for health;
6. replaces `doh-b` and waits for health;
7. refreshes the proxy, Telegram bot and debug collector;
8. notifies Telegram on success/failure.

Mutable rules live under:

```text
data/rules/
```

and are ignored by Git.

## Configuration

```env
GITHUB_TOKEN=github_pat_...
AUTO_UPDATE_INTERVAL_SEC=300
```

For a private repository, `GITHUB_TOKEN` needs only read access to repository Contents.

## Security

The updater mounts `/var/run/docker.sock`, which effectively grants host-administrator capability. Its API is not published externally and is protected by `ADMIN_API_TOKEN`.
