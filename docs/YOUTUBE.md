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

The real iPhone test demonstrated that HTTPS inspection is viable when QUIC is forced to fall back to TCP. A temporal ad/content comparison then showed that request paths are not a reliable blocker: `/videoplayback`, `/initplayback`, watch-time telemetry and ad-related endpoints can all appear across both windows.

The experiment moved from marker correlation to the modern playback transport. It now observes the exact Onesie hot-config protobuf path and the timing/size of encrypted `googlevideo.com/initplayback` UMP responses. Response bytes, keys and query values are not persisted and traffic is forwarded unchanged.

A first real iPhone temporal capture strongly validated this direction: the ad window contained 18 `/pagead/` markers across three protobuf responses (about 200 KiB scanned), while a roughly 29-second normal-content window contained one 36-byte protobuf response and zero ad markers. This validates the marker as a useful ad-window discriminator, but not yet any specific protobuf field number.

The scanner therefore ranks the nearest verified length-delimited field enclosing each marker and records distance statistics. It also keeps the marker identity separate and derives a bounded nearest-to-outer ancestor chain for each marker, so a capture can distinguish patterns such as `pagead -> field 14` from `googleadservices -> field 7`. Shared ancestors are correlated by their physical tag/payload span inside the response, not just by field number; the report includes shared-node count, per-marker depth and aggregate payload size. This is a dry-run mutation-planning signal only and does not alter traffic. Broader candidate lists remain diagnostic because nested protobuf messages and random schema-free byte patterns can produce multiple plausible ancestors.

Aggregate the minimized log with:

```bash
python3 scripts/analyze-youtube-observations.py
```

Live tests proved that both renaming field 14 and neutralizing its complete payload leave the ad intact. That machinery has therefore been removed rather than retained as a misleading switch. No parent field is promoted automatically and the current UMP experiment does not mutate traffic.
