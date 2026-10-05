# Web panel

The `web` service is the control panel for TunnelBlock. It is reachable from anywhere
through the Cloudflare Tunnel on the host:

```text
Browser --HTTPS--> Cloudflare --tunnel--> 127.0.0.1:8092 (proxy, nginx) --> web:8080
```

The browser asks for the user (`admin` by default) and the password set in `.env`.

## Publishing

In the Cloudflare Zero Trust dashboard, open the tunnel that runs on the Raspberry
(**Networks → Tunnels**) and add a **public hostname**, for example
`tunnelblock.example.com`, with service `http://localhost:8092`.

Nothing is opened on the router or the LAN: the nginx front binds to `127.0.0.1` only,
and the panel itself has no published port.

## Protection

- HTTP Basic auth on every request, over Cloudflare's HTTPS.
- Five wrong passwords from the same address lock that address out for 15 minutes.
  The address is the visitor's real one (`CF-Connecting-IP`), so an attacker cannot lock
  you out.
- nginx limits each address to 10 requests per second (burst 40) and 30 connections.
- Writes from other sites are refused (`Origin` check), so a malicious page cannot drive
  the panel through credentials the browser remembers.
- The admin token stays on the server; the browser never sees it.

Optionally add a Cloudflare Access policy on the hostname for a second login.

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
WEB_PORT        loopback port of the nginx front, default: 8092
ADMIN_API_TOKEN
```

`ops/install.sh` generates `WEB_PASSWORD` and prints it once. Rerunning it on an
existing installation adds the credentials if they are missing. Change the password by
editing `.env` and recreating the `web` container.
