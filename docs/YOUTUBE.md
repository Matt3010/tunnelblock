# YouTube DNS experiment

The YouTube phase is measurement-first. DNS-only filtering cannot distinguish an ad request
from normal video traffic when both use the same hostname, so no domain is blocked
automatically by this experiment.

The old Telegram capture commands have been removed from the bot while Phase 1 focuses on
WireGuard full-tunnel validation. The underlying DNS capture/statistics code is retained for
possible future diagnostics and does not run a YouTube-specific blocking policy by itself.

## Important limitation

The VPN resolver observes DNS traffic for the whole iPhone, not just the YouTube app.
Background iOS/app activity can therefore contaminate any DNS-level measurement.

Any future YouTube work must first verify whether the official iOS app can be observed safely at
the HTTPS request layer, including TLS certificate pinning and QUIC behavior. DNS-only domain
blocking remains unsuitable for shared Google/YouTube delivery hostnames.


## Phase 2 observation lab

The repository now includes a transparent HTTPS observation lab behind the working WireGuard tunnel.

The lab is still measurement-only:

- no request is blocked;
- interception is disabled by default;
- QUIC blocking is disabled by default;
- only metadata for YouTube-related hosts is persisted;
- the test first determines whether the official YouTube iOS app accepts the private CA or rejects it through certificate pinning.

See `docs/HTTPS-OBSERVATION.md` for the diagnostic sequence.

Request-level ad filtering is out of scope until the real iPhone test demonstrates that HTTPS inspection is viable and that ad traffic can be distinguished without breaking normal playback.
