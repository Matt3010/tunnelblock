# HTTPS observation lab

## Scope

Phase 2 contains the diagnostic lab and an explicit one-shot local filter for the official YouTube iOS app. The diagnostic work answered these questions:

1. does the app use QUIC/HTTP/3 in a way that bypasses TCP interception?
2. does the app accept a user-installed private CA?
3. if TLS can be observed, can ad-bearing InnerTube protobuf responses be identified without persisting payloads?

The normal VPN remains unchanged while the lab is disabled.

## Safety defaults

The lab is deliberately fail-safe:

- the mitmproxy observer service is **stopped by default**;
- HTTPS interception is **disabled by default**;
- QUIC blocking is **disabled by default**;
- no proxy port is published on the Raspberry host or router;
- the mitmproxy service shares the WireGuard network namespace only;
- recreating WireGuard removes temporary interception/firewall rules;
- the private CA and observation logs live under ignored runtime data;
- the YouTube UMP filter is disabled by default and must be explicitly enabled.

Runtime state:

```text
data/mitmproxy/
  mitmproxy-ca.pem
  mitmproxy-ca-cert.pem
  mitmproxy-ca-cert.cer       # created only by export-ios
  observations/
    metadata.jsonl
    metadata.jsonl.1          # rotation backup
```

The CA private key is contained in the mitmproxy runtime material under `data/mitmproxy/`. Never commit, paste or publish that directory.

## Data minimization

The custom mitmproxy addon records metadata only for YouTube-related host suffixes.

Default suffixes:

```text
youtube.com
googlevideo.com
googleapis.com
ytimg.com
ggpht.com
doubleclick.net
googlesyndication.com
googleadservices.com
```

Recorded fields can include:

- timestamp;
- TLS SNI, transport, version, negotiated cipher/ALPN and coarse failure category;
- HTTP host;
- method;
- URL path **without query string**, with long/token-like path segments redacted;
- response status;
- HTTP version;
- for eligible InnerTube protobuf responses only: total scanned bytes, aggregate ad-marker counts, marker-specific nearest field numbers/distances, bounded protobuf ancestor chains, and shared physical ancestor summaries (field number, marker depths, node count and payload-size statistics).

The addon does **not** persist:

- request headers;
- response headers;
- cookies;
- Authorization values;
- query strings;
- request bodies;
- response bodies.

Request bodies and ordinary response bodies are streamed through rather than buffered by the addon. For `youtubei.googleapis.com/youtubei/v1/*`, the request is constrained to identity encoding and protobuf response bytes are scanned in-flight with a bounded tail buffer. The scanner looks for ad-related byte markers and plausible enclosing length-delimited field numbers, then forwards the original bytes unchanged. It never writes response payloads to disk.

The field-number mutation path was removed after both tag denaturing and complete field-14 payload neutralization left ad playback unchanged in live tests. There is currently no blocking or mutation switch.

Normal mitmdump flow output is disabled so Docker logs do not become a second, less-redacted traffic log. TLS failures are persisted only as coarse categories, never as raw library error strings.

The metadata log rotates at approximately 25 MiB.

Generate an aggregate report that does not reproduce individual hosts, paths or payloads:

```bash
python3 scripts/analyze-youtube-observations.py
```

## Local Onesie/UMP filter

The marker-bearing `field 14` experiment showed correlation but not control:
renaming its tag and then neutralizing its complete payload both left ad playback
unchanged with exact planned/applied counts. Treat that branch as descriptive ad
metadata, not as evidence of the player decision.

The filter mirrors the current open-source Maasea behavior without its external
Cloudflare Worker. It acquires keys from the exact config path
`1>16>7>138536474>146311580`, keeps them only in memory, verifies the request
`encryptedClientKey`, parses UMP, verifies HMAC-SHA256, decrypts AES-128-CTR, and
handles gzip/brotli. It removes only `PlayerResponse` fields 45/68,
`PlaybackTracking` field 18, and `NextResponse` field 53 inside encrypted
GetWatch contents.

It reconstructs, recompresses, re-encrypts and signs locally. The original response
is forwarded byte-for-byte on missing keys, HMAC failure, unsupported framing or
compression, malformed protobuf, or zero applicable fields. Mutation is one-shot
per proxy process, applies only to an authenticated encrypted UMP control pair,
and is disabled in Compose. Ordinary `/player` responses remain byte-for-byte
unchanged so the one-shot cannot split duplicated player state across transports.

Protocol and schema references are pinned conceptually to Maasea `65075cdb`, the
current [GoogleVideo UMP implementation](https://github.com/LuanRT/googlevideo),
and the published [Innertube UMP documentation](https://github.com/davidzeng0/innertube/blob/main/googlevideo/ump.md).

Enable the automatic session:

```bash
sh scripts/youtube-ump-filter.sh enable
```

No markers or report are required. Fully close and reopen YouTube, then play a
video normally. Persistent observation logging is disabled for this session. After
the test, restore interception off and QUIC allowed:

```bash
sh scripts/youtube-ump-filter.sh disable
```

The report focuses on protobuf marker counts, marker-specific nearest fields/distances, ancestor-chain frequencies and shared physical ancestor candidates. Shared candidates are computed from tag/payload coordinates in memory and emitted only as aggregate field/depth/size metadata; absolute positions and payload bytes are not persisted. These values are dry-run evidence, not blocking decisions; repeated ad/no-ad validation is required before any structural target can be configured for mutation.

`mitmdump` runs with `flow_detail=0`, so its normal request/response flow summaries are not written to Docker stdout. The JSONL file above is the canonical observation log; container logs are reserved for proxy/runtime failures.

## Architecture

```text
iPhone
  |
  | WireGuard
  v
wireguard network namespace
  |
  +--> DNS 10.66.66.1 -> existing blocker
  |
  +--> TCP/443 normally ----------------------> Internet
  |
  +--> TCP/443 when HTTPS test is enabled
         |
         +--> iptables REDIRECT -> :8080
                                  |
                                  +--> mitmproxy transparent mode
                                           |
                                           +--> Internet

UDP/443 (QUIC)
  |
  +--> normally allowed
  +--> optionally REJECTed during the QUIC test
```

IPv4 TCP/443 is transparently redirected when the HTTPS test is enabled.

During that test, IPv6 TCP/443 is fail-closed instead of being allowed to bypass the IPv4 transparent proxy. This is temporary and is removed by `https-intercept.sh disable`.

## Status

After deployment:

```bash
sh scripts/phase2-status.sh
```

Expected initial state:

```text
wireguard: healthy
mitmproxy: stopped
HTTPS IPv4 interception: disabled
QUIC IPv4 UDP/443: allowed
```

The observer is started only for an explicit HTTPS test or briefly while preparing the CA. Normal updater deployments remove the stopped lab container before recreating WireGuard, while leaving `data/mitmproxy/` untouched; this avoids stale network-namespace references and leaves the lab inactive.

## Public CA export

Generate the persistent CA without enabling HTTPS interception:

```bash
sh scripts/mitmproxy-ca.sh prepare
```

Then check that the public certificate exists:

```bash
sh scripts/mitmproxy-ca.sh status
```

Export only the public certificate in iOS-friendly DER form:

```bash
sh scripts/mitmproxy-ca.sh export-ios
```

Result:

```text
data/mitmproxy/mitmproxy-ca-cert.cer
```

`export-ios` also publishes an isolated copy containing no private material. With WireGuard
connected, open this URL on the iPhone:

```text
http://10.66.66.1:8081/mitmproxy-ca-cert.cer
```

The endpoint listens only on the WireGuard address; Docker exposes no host port for it.

Optional SHA-256 fingerprint:

```bash
sh scripts/mitmproxy-ca.sh fingerprint
```

Do not copy `mitmproxy-ca.pem` or any private-key material to the iPhone.

## iPhone CA trust

Use this only on the test iPhone.

After transferring and installing `mitmproxy-ca-cert.cer`:

1. install the downloaded profile/certificate in iOS Settings;
2. open **Settings -> General -> About -> Certificate Trust Settings**;
3. enable full trust for the installed mitmproxy CA.

A trusted private CA can inspect TLS traffic that does not use certificate pinning. Remove the CA from the iPhone when the experiment is finished.

## Diagnostic sequence

### A. Baseline: interception ON, QUIC allowed

```bash
sh scripts/https-intercept.sh enable
sh scripts/quic.sh allow
```

Use the YouTube app briefly.

Inspect metadata:

```bash
tail -n 100 data/mitmproxy/observations/metadata.jsonl
```

If playback works but the proxy sees nothing useful, QUIC may be carrying the traffic.

### B. Force TCP by blocking QUIC

```bash
sh scripts/quic.sh block
```

Fully close and reopen the YouTube app, then play a video.

Inspect:

```bash
tail -n 200 data/mitmproxy/observations/metadata.jsonl
docker compose --profile https-lab logs --tail=100 mitmproxy
```

Interpretation:

- `tls_clienthello` followed by `tls_established_client` and `http_request`: TLS interception is viable for that host;
- `tls_clienthello` followed by `tls_failed_client`, or app failure before any HTTP request: likely CA rejection or certificate pinning;
- no matching events even with QUIC blocked: traffic may use other hostnames/transports and needs further measurement.

This is a go/no-go test, not proof that ads can be blocked safely.

## Validated iPhone result

The real-device test passed. With QUIC allowed, part of the official YouTube iOS app traffic was visible over intercepted TCP. With UDP/443 blocked, video playback continued and the observer recorded successful TLS/HTTP exchanges for YouTube APIs and `googlevideo.com` playback endpoints. Some isolated TLS failures remain host-specific and do not establish app-wide pinning.

This is a technical go for deeper inspection only. A subsequent temporal ad/content test showed that path-level categories overlap across both phases: normal playback uses the same `googlevideo.com` delivery endpoints and ad-related telemetry can arrive during normal content. Those path labels are therefore no longer treated as prospective blocking rules.

The next validation target is the InnerTube protobuf layer. A first real temporal capture already showed 18 `/pagead/` markers in the ad window and none in the subsequent normal-content window, so protobuf marker detection is a substantially cleaner discriminator than HTTP path categories.

Field selection remains intentionally unresolved. The scanner now reports the nearest decoded length-delimited field that actually encloses each marker, plus min/max/average byte distance. Only repeated nearest-field evidence across ad captures, combined with zero/benign evidence in no-ad captures, can promote a field into the explicit mutation allowlist.

## Restore normal VPN behavior

Always restore both switches after a test:

```bash
sh scripts/https-intercept.sh disable
sh scripts/quic.sh allow
```

Verify:

```bash
sh scripts/phase2-status.sh
```

A WireGuard/container recreation also removes the temporary firewall rules, so interception does not persist accidentally across updater deployments.

## Commands

```bash
# status
sh scripts/phase2-status.sh

# HTTPS transparent interception
sh scripts/https-intercept.sh enable
sh scripts/https-intercept.sh disable
sh scripts/https-intercept.sh status

# QUIC / HTTP/3
sh scripts/quic.sh block
sh scripts/quic.sh allow
sh scripts/quic.sh status

# automatic one-shot Onesie/UMP filter
sh scripts/youtube-ump-filter.sh enable
sh scripts/youtube-ump-filter.sh disable

# CA
sh scripts/mitmproxy-ca.sh prepare
sh scripts/mitmproxy-ca.sh status
sh scripts/mitmproxy-ca.sh export-ios
sh scripts/mitmproxy-ca.sh fingerprint
```
