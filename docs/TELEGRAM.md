# Telegram bot

The Telegram bot is the remote control panel for the DoH resolver.

## Commands

```text
/status
/stats
/topblocked
/topallowed
/block example.com
/allow example.com
/unblock example.com
/unallow example.com
/reload
/profile
/help
```

The bot does not execute arbitrary shell commands.

It talks only to the internal authenticated DoH admin API.

## Required environment variables

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
ADMIN_API_TOKEN
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list of numeric Telegram user IDs.

## Security

- Do not commit Telegram tokens.
- Do not expose the internal admin API publicly.
- The bot container calls `http://doh:8053/admin/*` over the Docker network.
- Rules are mounted from `./rules:/rules`, so manual block/allow changes persist on the Raspberry Pi.
