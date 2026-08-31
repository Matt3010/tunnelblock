# HTTPS observation lab

## Scope

Phase 2 is a diagnostic lab for the official YouTube iOS app.

It does not block YouTube ads. Its purpose is to answer three questions before any request-level filtering is attempted:

1. does the app use QUIC/HTTP/3 in a way that bypasses TCP interception?
2. does the app accept a user-installed private CA?
3. if TLS can be observed, are ad and normal-video requests distinguishable at HTTP level?

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
- no YouTube block rule is installed.

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
- HTTP version.

The addon does **not** persist:

- request headers;
- response headers;
- cookies;
- Authorization values;
- query strings;
- request bodies;
- response bodies.

Payloads are streamed through rather than buffered by the addon. Normal mitmdump flow
output is disabled so Docker logs do not become a second, less-redacted traffic log.
TLS failures are persisted only as coarse categories, never as raw library error strings.

The metadata log rotates at approximately 25 MiB.

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

# CA
sh scripts/mitmproxy-ca.sh prepare
sh scripts/mitmproxy-ca.sh status
sh scripts/mitmproxy-ca.sh export-ios
sh scripts/mitmproxy-ca.sh fingerprint
```
