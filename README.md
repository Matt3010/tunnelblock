# adblock-general-purpose

Experimental general-purpose iOS network ad blocker.

## Current MVP

The project currently contains:

- domain rule engine with allow/block precedence
- unit tests
- iOS `NEPacketTunnelProvider` skeleton
- optional Raspberry Pi debug collector
- full available-payload debug events
- Docker deployment for the collector

The current milestone intentionally does **not** perform TLS interception.

## Repository layout

```text
ios/PacketTunnel/   iOS Network Extension skeleton
server/             TypeScript filtering/debug services
rules/              allow/block lists
docs/               architecture, debug logger and roadmap
docker-compose.yml  Raspberry Pi collector deployment
```

## Run tests

```bash
cd server
npm install
npm test
```

## Raspberry Pi debug collector

Create a local `.env`:

```bash
DEBUG_TOKEN=replace-with-a-long-random-token
```

Then:

```bash
docker compose up -d --build
```

Health check:

```text
GET http://<raspberry-ip>:8787/health
```

Debug endpoint:

```text
POST http://<raspberry-ip>:8787/events
Authorization: Bearer <DEBUG_TOKEN>
```

During this development phase, the collector stores/logs the **complete payload available to the capture layer**. UTF-8 data is sent as text and binary data is base64 encoded.

For HTTPS, application plaintext is still encrypted until/unless a later isolated TLS-inspection milestone is implemented.

## Next milestone

M1 implements real DNS packet parsing/filtering inside the iOS tunnel and streams the observed DNS packets/events to the Raspberry Pi collector.

See `docs/ROADMAP.md`.
