# Roadmap

## M0 - DNS blocker foundation

- [x] Repository structure
- [x] Domain rule engine
- [x] Docker deployment
- [x] Persistent SQLite statistics
- [x] Telegram administration
- [x] Automatic updater with rollback

## M1 - Public DoH

- [x] DoH GET/POST endpoint
- [x] Domain filtering
- [x] Upstream DNS forwarding
- [x] Dynamic iOS managed DoH profile at `/install`
- [x] Cloudflare-compatible public deployment
- [x] Public/admin endpoint isolation

## M2 - Rule feeds and diagnostics

- [x] External domain-feed import
- [x] Normalize and deduplicate
- [x] Scheduled updates
- [x] Rule provenance, multi-list attribution and overlap diagnostics
- [x] Rule hot reload
- [x] Resolver/query metrics via SQLite
- [ ] Per-client allow/block overrides

## M3 - Resolver hardening

- [ ] Full DNS name-compression coverage
- [ ] TCP fallback for truncated upstream responses
- [ ] IPv6 upstream support
- [ ] Rate limiting

## M4 - WireGuard full tunnel

- [x] Dockerized WireGuard gateway
- [x] Persistent server/client keys
- [x] Full IPv4/IPv6 route capture
- [x] NAT/Internet forwarding
- [x] VPN DNS through the existing blocker
- [x] iPhone QR/config export
- [x] Healthcheck and updater integration
- [x] Real iPhone handshake and full-tunnel validation

## M5 - HTTPS observation lab

- [ ] Transparent HTTPS proxy container
- [ ] Persistent private CA outside Git
- [ ] Observation-only metadata logging
- [ ] Reversible HTTPS interception toggle
- [ ] Reversible QUIC/UDP 443 toggle
- [ ] TLS/pinning/QUIC go/no-go diagnostics
- [ ] Keep interception disabled by default

## M6 - YouTube experimental

- [x] DNS-only limitation documented
- [x] Legacy labeled DNS capture backend retained for diagnostics
- [ ] Test official YouTube iOS TLS interception
- [ ] Determine whether certificate pinning prevents inspection
- [ ] Compare ad and normal-video request metadata
- [ ] Identify request-level signals only if interception is viable
- [ ] Add blocking rules only after false-positive validation
