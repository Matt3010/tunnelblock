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
                                             +--> instagram
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
- supported actions such as `observe` and, in the future, `filter`.

App-specific behavior lives under `https/app/strategies/`. Networking, CA handling,
firewall behavior and Telegram UI do not need to be rewritten when another app is added.

## Telegram workflow

Use `/integrations`.

The menu shows all registered integrations and the current HTTPS runtime state. The CA
controls are global because the same private CA is reused by all strategies.

Initial workflow:

1. tap **Prepara CA**;
2. tap **Scarica CA** and install the `.cer` profile on the test iPhone;
3. in iOS enable full trust for that CA under Certificate Trust Settings;
4. open the desired integration, for example Instagram;
5. tap **Avvia osservazione**;
6. use the app briefly;
7. tap **Ferma osservazione**.

The first Instagram strategy is observation-only. It records minimized TLS/HTTP metadata
for matching Meta/Instagram hosts and never stores headers, cookies, query strings,
request bodies or response bodies.

## Runtime data

Everything sensitive stays under ignored runtime paths:

```text
data/https/
  mitmproxy-ca.pem
  mitmproxy-ca-cert.pem
  mitmproxy-ca-cert.cer
  runtime-state.json
  observations/
    instagram.jsonl

data/https-public/
  mitmproxy-ca-cert.cer
```

Only `data/https-public/mitmproxy-ca-cert.cer` is returned by the authenticated updater
API for Telegram download. The private CA key is never returned.

## Safety

The HTTPS proxy is under the `https-lab` Compose profile and is stopped by default.
Interception and QUIC blocking are applied only while a strategy is active. Stopping an
integration removes both firewall changes and stops the proxy.

A deployment also stops the HTTPS lab before recreating the normal stack, so an
experimental interception session cannot silently survive an update.

Because transparent interception covers TCP/443 device-wide while active, other apps
that use certificate pinning may temporarily fail. Keep observation windows short and
stop the integration after each test.
