# Telegram bot

The Telegram bot is the remote control panel for the WireGuard DNS resolver.

## Commands

```text
/status
/diag
/domains
/lists
/vpn
/integrations
/topblocked
/topallowed
/reload
/update
/update_status
/help
```

### Blocklist diagnostics

`/lists` shows configured/active lists, unique combined domains, overlap between lists,
cached domain counts, per-list unique coverage and refresh errors.

`/domains` shows the current DNS decision, the effective matching rule and every enabled
external blocklist that currently matches the selected domain.

`/topblocked` and `/topallowed` enrich the query counters with the rule source that is
currently active for each domain.

The bot does not execute arbitrary shell commands.

It talks only to the authenticated resolver/updater APIs on the Docker network.

`/vpn` creates and manages platform-independent WireGuard peers. After creating a peer,
the bot provides the same QR/config onboarding steps for iOS and Android.

`/integrations` renders the optional HTTPS strategy registry. The registry is currently
empty and normal DNS filtering never requires a CA certificate.

## Required environment variables

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
ADMIN_API_TOKEN
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list of numeric Telegram user IDs.

## Security

- Do not commit Telegram tokens.
- Resolver administration stays on the internal Docker network.
- The bot talks directly to the resolver on the Docker network.
- Rules and external-list caches are persisted under the mounted rules directory.
