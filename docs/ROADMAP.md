# Roadmap

## M0 - DNS blocker foundation

- [x] Repository structure
- [x] Domain rule engine
- [x] Docker deployment
- [x] Persistent SQLite statistics
- [x] Telegram administration
- [x] Automatic updater with rollback

## M1 - Public DoH (retired)

- [x] DoH GET/POST endpoint
- [x] Domain filtering
- [x] Upstream DNS forwarding
- [x] Dynamic iOS managed DoH profile at `/install`
- [x] Cloudflare-compatible public deployment
- [x] Public/admin endpoint isolation
- [x] Retired after migration to WireGuard-only access
- [x] Removed public proxy, DoH route and managed iOS profile

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

- [x] Transparent HTTPS proxy container
- [x] Persistent private CA outside Git
- [x] Observation-only metadata logging
- [x] Reversible HTTPS interception toggle
- [x] Reversible QUIC/UDP 443 toggle
- [x] IPv6 fail-closed policy during interception tests
- [x] Keep interception disabled by default
- [x] Run the real iPhone TLS/pinning/QUIC go/no-go test

## M6 - YouTube experimental

- [x] DNS-only limitation documented
- [x] Legacy labeled DNS capture backend retained for diagnostics
- [x] Test official YouTube iOS TLS interception
- [x] Determine that app-wide certificate pinning does not prevent inspection
- [x] Compare ad and normal-content request metadata on a real iPhone
- [x] Reject path-level ad/playback categories as unsafe blocking signals
- [x] Add streaming InnerTube protobuf marker/field discovery
- [x] Validate protobuf ad-marker discrimination on a real iPhone capture
- [x] Rank nearest verified enclosing protobuf fields and distances
- [x] Correlate each ad marker with nearest field and protobuf ancestor chain
- [x] Correlate shared protobuf ancestors by physical node for dry-run mutation planning
- [x] Restrict mutation to shared physical nodes containing all ad markers
- [x] Add runtime-only one-shot mutation controller with safe defaults
- [x] Unify diagnostic and mutation node selection with planned==mutated fail-closed guard
- [x] Reject field-tag denaturing as ineffective on live iOS test
- [x] Add length-preserving shared-node payload neutralization
- [x] Add protobuf field-denaturing mechanism behind disabled interlocks
- [x] Reject field-14 payload neutralization as ineffective on live iOS test
- [x] Remove obsolete field mutation and generic decision-fingerprint controls
- [x] Add privacy-minimized Onesie config and `initplayback`/UMP timeline capture
- [ ] Validate that current YouTube iOS uses the observed Onesie/UMP path
- [x] Implement fail-closed local UMP framing, HMAC, AES-CTR and compression handling
- [x] Port published `adPlacements`/`adSlots` schema targets as a disabled one-shot filter
- [ ] Validate the local one-shot filter on the real iPhone before persistent enablement
