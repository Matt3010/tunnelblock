# Web panel

The `web` service is the control panel for TunnelBlock. Open it from a device on the
home network:

```text
http://<raspberry-lan-ip>:8088
```

The browser asks for the user (`admin` by default) and the password set in `.env`.

## Who can reach it

- **LAN:** any device on the home network, after logging in.
- **VPN:** only VPN users whose [LAN access](LAN-ACCESS.md) includes the Raspberry on
  port 8088 (or **Full LAN**). Other VPN users cannot reach it at all.
- **Internet:** never. The panel refuses every non-private source address, even with
  valid credentials. Do not forward port 8088 on the router.

Five wrong passwords from the same address lock that address out for 15 minutes.
Writes from other sites are refused (`Origin` check), so a malicious page cannot drive
the panel through credentials the browser remembers.

Traffic on the LAN is plain HTTP. Over the VPN it is encrypted by WireGuard.

## Pages

- **Overview:** resolver statistics, service health, most blocked and most requested
  domains, update state with the latest deployment log, **Update now** and
  **Reload DNS rules**. A failed update and its rollback show up here.
- **Domains:** observed domains with their decision; set each one to Default, Allow or
  Block.
- **Blocklists:** coverage, errors, add/enable/disable/refresh/remove sources.
- **VPN:** create users, show the QR code, download the `.conf`, enable/disable,
  rotate keys, delete, and edit per-user [LAN access](LAN-ACCESS.md).
- **HTTPS:** the optional [HTTPS integrations](HTTPS-INTEGRATIONS.md) registry.

The panel talks only to the authenticated resolver and updater APIs on the Docker
network. It does not run shell commands.

## Environment variables

```text
WEB_USER        default: admin
WEB_PASSWORD    required, at least 12 characters
WEB_PORT        host port, default: 8088
ADMIN_API_TOKEN
```

`ops/install.sh` generates `WEB_PASSWORD` and prints it once. Rerunning it on an
existing installation adds the credentials if they are missing. Change the password by
editing `.env` and recreating the `web` container.

## Security

- Never commit `.env`.
- The admin token stays on the server; the browser never sees it.
- Sessions do not exist: every request carries Basic credentials, so changing
  `WEB_PASSWORD` takes effect immediately after the container restarts.
