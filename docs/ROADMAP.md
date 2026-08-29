# Roadmap

## M0 - Bootstrap

- [x] Repository structure
- [x] Domain rule engine
- [x] Unit tests
- [x] Packet Tunnel skeleton
- [x] Optional Raspberry Pi debug collector
- [x] Full available-payload debug event format

## M1 - DNS filtering

- [ ] Parse IPv4/IPv6 UDP packets
- [ ] Parse DNS queries
- [ ] Match queried hostnames against RuleEngine
- [ ] Return blocked DNS responses locally
- [ ] Forward allowed DNS queries
- [ ] Stream raw DNS packets/events to the debug collector

## M2 - Tunnel routing

- [ ] Forward non-DNS traffic correctly
- [ ] TCP/UDP flow observability
- [ ] Config synchronization
- [ ] Persistent debug storage on Raspberry Pi

## M3 - Rule feeds

- [ ] Import external filter lists
- [ ] Deduplication and normalization
- [ ] Scheduled updates
- [ ] Per-rule provenance

## M4 - YouTube experimental

- [ ] Capture playback traffic on a dedicated test device
- [ ] Compare ad vs non-ad sessions
- [ ] QUIC/HTTP3 behavior analysis
- [ ] Evaluate what can be filtered without TLS interception
- [ ] Only then evaluate a separate TLS-inspection lab mode
