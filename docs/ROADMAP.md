# Roadmap

## M0 - Bootstrap

- [x] Repository structure
- [x] Domain rule engine
- [x] Debug collector
- [x] Docker deployment

## M1 - App-less DoH

- [x] DNS message parser
- [x] DoH GET/POST endpoint
- [x] Domain filtering
- [x] Empty-answer blocked response
- [x] Upstream UDP forwarding
- [x] iOS managed DoH profile template
- [x] Profile generator
- [x] Cloudflare-compatible HTTP deployment

## M2 - Production hardening

- [ ] Correct DoH POST raw-body handling
- [ ] Full DNS name compression support
- [ ] TCP fallback for truncated upstream responses
- [ ] IPv6 upstream support
- [ ] Persistent query/debug logging
- [ ] Rate limiting
- [ ] Rule hot reload
- [ ] Metrics

## M3 - Rule feeds

- [ ] Import EasyList/AdGuard/OISD-compatible domain feeds
- [ ] Normalize and deduplicate
- [ ] Scheduled updates
- [ ] Rule provenance
- [ ] Per-client allow/block overrides

## M4 - iOS distribution

- [ ] Generate final signed/unsigned mobileconfig
- [ ] Serve profile from /install
- [ ] Validate iOS install flow
- [ ] Validate Wi-Fi and cellular behavior

## M5 - YouTube experimental

- [ ] Measure what DNS-only filtering can block
- [ ] Compare ad and non-ad playback DNS activity
- [ ] Identify safe dedicated ad endpoints if any
- [ ] Document limits of DNS-only blocking
