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

The implementation moved from marker correlation to the modern playback transport. The explicit one-shot experiment validates the exact plaintext `OnesieRequest.innertube_request` envelope of an `initplayback` request. It then changes only `InnertubeRequest.enable_ad_placements_preroll` (field 13), as identified by the public [googlevideo Onesie schema](https://github.com/LuanRT/googlevideo/blob/main/protos/video_streaming/innertube_request.proto), from true to false. The request size is unchanged, planned and applied counts must match, and any mismatch forwards the original request. Responses are no longer mutated. The test does not depend on cached hot-config keys; no keys, payloads or query values are persisted and no external Worker is used.

A first real iPhone temporal capture strongly validated this direction: the ad window contained 18 `/pagead/` markers across three protobuf responses (about 200 KiB scanned), while a roughly 29-second normal-content window contained one 36-byte protobuf response and zero ad markers. This validates the marker as a useful ad-window discriminator, but not yet any specific protobuf field number.

The scanner therefore ranks the nearest verified length-delimited field enclosing each marker and records distance statistics. It also keeps the marker identity separate and derives a bounded nearest-to-outer ancestor chain for each marker, so a capture can distinguish patterns such as `pagead -> field 14` from `googleadservices -> field 7`. Shared ancestors are correlated by their physical tag/payload span inside the response, not just by field number; the report includes shared-node count, per-marker depth and aggregate payload size. This is a dry-run mutation-planning signal only and does not alter traffic. Broader candidate lists remain diagnostic because nested protobuf messages and random schema-free byte patterns can produce multiple plausible ancestors.

Aggregate the minimized log with:

```bash
python3 scripts/analyze-youtube-observations.py
```

Live tests proved that renaming field 14, neutralizing its complete payload, and removing assumed response-side ad fields leave the ad intact. That machinery has therefore been removed rather than retained as a misleading switch. No parent response field is promoted automatically. The current test instead targets the explicit upstream preroll request flag and remains disabled by default and automatic one-shot when enabled.
