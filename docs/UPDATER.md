# System-agnostic updater

Updates are performed by the `updater` container, not by host-specific scripts.

The normal control surface is Telegram:

```text
/update
/update_status
```

The updater:

1. fetches `master` from GitHub;
2. resets the local checkout to the remote revision;
3. rebuilds images while the current resolvers remain online;
4. replaces `doh-a` and waits for health;
5. replaces `doh-b` and waits for health;
6. refreshes the proxy, Telegram bot and debug collector.

Mutable rules live under:

```text
data/rules/
```

and are ignored by Git, so updates do not overwrite Telegram-managed rules.

## Private GitHub repository

Because the repository is private, automatic fetching requires a fine-grained GitHub token in `.env`:

```env
GITHUB_TOKEN=github_pat_...
```

Grant only read access to repository Contents.

## Security note

The updater mounts `/var/run/docker.sock`. Access to the Docker socket is effectively host-administrator access. The updater API is not published to the host or Cloudflare and is protected by `ADMIN_API_TOKEN`; only the authenticated Telegram bot talks to it over the internal Docker network.
