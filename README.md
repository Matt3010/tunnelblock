# adblock-general-purpose

Experimental app-less iOS ad blocker using DNS-over-HTTPS.

## Primary architecture

```text
iPhone
  |
  | managed DoH profile
  v
https://adblock.scanferlamatteo.work/dns-query
  |
  | Cloudflare Tunnel
  v
Raspberry Pi
  |
  +--> DoH resolver / rule engine
  +--> upstream DNS
```

No iOS app, no Xcode sideloading, no VPS and no inbound router ports are required.

## Current MVP

- DoH endpoint at `/dns-query`
- domain allow/block engine
- DNS packet parser
- blocked DNS response generation
- upstream DNS forwarding
- iOS `.mobileconfig` template
- Docker deployment
- IKEv2 code retained only as an alternative experiment

## Raspberry deployment

Create a local `.env` containing the required service secrets, then:

```bash
docker compose up -d
```

Services:

```text
DoH resolver:      http://raspberry:8053/dns-query
DoH health:        http://raspberry:8053/health
```

Configure Cloudflare Tunnel so:

```text
https://adblock.scanferlamatteo.work/dns-query -> http://localhost:8053/dns-query
https://adblock.scanferlamatteo.work/health    -> http://localhost:8053/health
```

## Generate iOS profile

```bash
node scripts/generate-doh-profile.mjs
```

This creates:

```text
profiles/adblock-doh.mobileconfig
```

Install that profile on the iPhone.

## Limitation

DNS filtering can block many ad/tracker domains, but it cannot reliably distinguish YouTube ads from normal video traffic when both are served through shared Google infrastructure.

The YouTube-specific work remains experimental.

## Public endpoint boundary

The public reverse proxy exposes only:

- `/dns-query`
- `/install`
- `/health`

Administrative endpoints under `/admin/*` remain reachable only inside the Docker network and are not forwarded by the public proxy.
