# Changelog

All notable changes to TunnelBlock are documented here. The project follows Semantic
Versioning from its first tagged stable release.

## Unreleased

- Replaced the Telegram bot with a LAN-only web panel protected by HTTP Basic auth.
  A stolen Telegram account can no longer control the stack. Set `WEB_PASSWORD` in `.env`
  (rerun `ops/install.sh` to generate it); `TELEGRAM_*` variables are no longer used.
- Removed automatic deployment on push to `master`; updates start only from the web panel.
- Added per-user LAN access control from Telegram, prefilled by automatic network discovery.
  New VPN users are Internet-only by default; existing users keep full LAN access.
- Rebranded the public project as TunnelBlock while retaining runtime identifiers for compatibility.
- Added guided installation, continuous integration and GitHub contribution templates.
- Documented shared iOS and Android WireGuard support.

## 1.0.0 - 2026-09-02

- WireGuard full-tunnel gateway with persistent multi-peer identities.
- Replicated DNS filtering with allow/block rules, statistics, caching and rate limits.
- Telegram administration for peers, rules, lists, diagnostics and updates.
- Authenticated updater with pre-flight validation and rollback.
- Optional HTTPS strategy framework, disabled by default with an empty registry.
