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

The experiment therefore moved one layer upstream to InnerTube protobuf responses. In discovery mode the proxy asks `youtubei.googleapis.com/youtubei/v1/*` for uncompressed responses, scans them in-flight for ad markers such as `/pagead/`, and records only aggregate marker counts plus plausible enclosing protobuf field numbers. Response bytes are not persisted and are forwarded unchanged.

A first real iPhone temporal capture strongly validated this direction: the ad window contained 18 `/pagead/` markers across three protobuf responses (about 200 KiB scanned), while a roughly 29-second normal-content window contained one 36-byte protobuf response and zero ad markers. This validates the marker as a useful ad-window discriminator, but not yet any specific protobuf field number.

The scanner therefore ranks the nearest verified length-delimited field enclosing each marker and records distance statistics. Broader candidate lists remain diagnostic because nested protobuf messages and random schema-free byte patterns can produce multiple plausible ancestors.

Aggregate the minimized log with:

```bash
python3 scripts/analyze-youtube-observations.py
```

A field-denaturing implementation is available for the later blocking experiment, but the checked-in configuration keeps `PROTOBUF_BLOCKING_ENABLED=false` and `PROTOBUF_BLOCK_FIELD_TAGS` empty. Historical field numbers are not trusted automatically; current iOS observations must validate them first.
