# HTTPS integrations

The HTTPS layer is an opt-in diagnostic framework for application-specific strategies.
Normal VPN and DNS filtering remain unchanged while no HTTPS integration is active.

## Architecture

```text
iPhone
  |
  | WireGuard full tunnel
  v
wireguard network namespace
  |
  +--> DNS -> existing DNS blocker
  |
  +--> TCP/443 normally ----------------------> Internet
  |
  +--> TCP/443 while an integration is active
         |
         +--> transparent redirect -> https-proxy / mitmproxy
                                      |
                                      +--> strategy registry
                                             |
                                             +--> future integrations
```

UDP/443 is blocked only while a strategy is active so apps fall back from QUIC/HTTP3
to interceptable TCP. IPv6 TCP/443 is fail-closed during the test to prevent bypass.

## Strategy registry

Static integration metadata lives in `https/integrations.json`. This is the single
registry consumed by the HTTPS proxy and exposed by the updater API to Telegram.

Each integration declares:

- a stable id;
- display name and description;
- host suffixes;
- implementation strategy;
- renderer metadata for generic actions (`certificate`, `start`, `stop`, `summary`, `clear`).

App-specific behavior lives under `https/app/strategies/`. Networking, CA handling,
firewall behavior and Telegram UI do not need to be rewritten when another app is added.

## Telegram workflow

Use `/integrations`.

The menu shows all registered integrations and renders their buttons directly from the
registry. A single persistent private CA is shared by the framework; the CA button in
each integration returns the same public certificate for convenience.

Initial workflow:

The registry is currently empty. Once an integration is registered, its menu provides
CA download, start/stop, minimized TLS/HTTP results and integration-scoped clearing.

## Runtime data

Everything sensitive stays under ignored runtime paths:

```text
data/https/
  mitmproxy-ca.pem
  mitmproxy-ca-cert.pem
  mitmproxy-ca-cert.cer
  runtime-state.json
  public/
    adblock-general-purpose-ca.cer
  observations/
    <integration-id>.jsonl
```

Only `data/https/public/adblock-general-purpose-ca.cer` is returned by the authenticated updater
API for Telegram download. The private CA key is never returned.

## Safety

The HTTPS proxy is under the `https-lab` Compose profile and is stopped by default.
Interception and QUIC blocking are applied only while a strategy is active. Stopping an
integration removes both firewall changes and stops the proxy.

A deployment also stops the HTTPS lab before recreating the normal stack, so an
experimental interception session cannot silently survive an update.

The firewall redirect covers TCP/443 while active, but the ClientHello hook lets hosts
outside the selected strategy pass through without TLS interception. Keep observation
windows short and stop the integration after each test.

## Adding an integration

Create an `AppStrategy` subclass under `https/app/strategies/`, register its import path,
host suffixes and action metadata in `https/integrations.json`, then add host/behavior
tests. No WireGuard, firewall, CA, Compose, updater or Telegram change is required.

## Reading an observation result

Visible HTTP requests prove that HTTPS was readable for at least part of the selected
traffic. ClientHello plus TLS failures, with no established client TLS and no visible
HTTP requests, is only *compatible* with certificate pinning or CA rejection; it is not
proof. **Azzera risultati** removes only that integration's observation files, never CA, VPN,
DNS statistics or another integration.
