# HTTPS integrations

The HTTPS subsystem is an optional, strategy-based inspection framework. It is
disabled by default and is controlled primarily from Telegram through
`/integrations`.

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
  +--> TCP/443 normally ------------------------------> Internet
  |
  +--> while an integration inspection is active
         |
         +--> iptables REDIRECT -> https-proxy:8080
                                   |
                                   +--> strategy registry
                                          |
                                          +--> InstagramStrategy
                                          +--> future strategies
```

UDP/443 is rejected only while HTTPS inspection is active so applications fall
back from QUIC/HTTP/3 to TCP. IPv6 TCP/443 is fail-closed during interception so
it cannot bypass the IPv4 transparent proxy.

## Safety defaults

- `https-proxy` belongs to the `https-lab` Compose profile and is not started
  by the normal deployment.
- HTTPS interception and QUIC blocking are disabled unless explicitly started.
- No proxy port is published on the Raspberry Pi or router.
- Recreating the WireGuard container removes temporary firewall rules.
- CA private material and observation data live only under ignored
  `data/https/`.
- The default strategy streams request and response bodies and does not store
  headers, cookies, query strings, request bodies, or response bodies.
- Instagram is observation-only: no payload mutation or ad blocking is enabled.

## Strategy registry

Tracked configuration lives at:

```text
https/config/integrations.json
```

Each integration declares:

- stable id;
- display name and description;
- Python strategy class;
- host suffixes;
- Telegram-visible actions.

Application-specific logic belongs under `https/strategies/`. Networking,
certificate handling, logging and lifecycle control remain generic.

## Telegram workflow

Use:

```text
/integrations
```

The bot lists registered integrations. Selecting one exposes its registered
actions. For Instagram the initial actions are:

- download the public CA certificate for iOS;
- start HTTPS inspection;
- stop HTTPS inspection;
- view aggregate TLS/HTTP results;
- clear prior observation results.

The CA action sends only the public DER certificate through Telegram. The
mitmproxy private CA key never leaves `data/https/ca/`.

After installing the certificate on iOS, enable full trust under:

```text
Settings -> General -> About -> Certificate Trust Settings
```

The first Instagram test is a go/no-go test for TLS interception. If Safari works
with the trusted CA but Instagram produces TLS client failures and no HTTP
requests, certificate pinning is the likely blocker.

## Adding another application

1. Add a strategy class under `https/strategies/`.
2. Register it in `https/config/integrations.json`.
3. Define the host suffixes and Telegram actions.
4. Add tests for host matching and any custom behavior.
5. Keep observation-only behavior until a mutation rule has been independently
   validated.

No WireGuard, CA, or transparent-proxy code should need to change for a new
application strategy.
