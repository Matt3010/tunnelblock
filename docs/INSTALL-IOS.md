# iOS installation without an app

The target user flow is:

```text
Safari on iPhone
  -> download .mobileconfig
  -> Settings
  -> Profile Downloaded
  -> Install
  -> VPN appears in iOS settings
```

No IPA, Xcode sideload or 7-day free provisioning cycle is required for the configuration profile itself.

## Current development state

The repository contains a template:

```text
profiles/adblock.mobileconfig.example
```

Before installing it, replace the placeholder UUIDs with real UUIDs and configure credentials matching the strongSwan server.

The VPN hostname is:

```text
adblock.scanferlamatteo.work
```

## Server requirements

The Raspberry Pi must expose IKEv2 directly to the Internet:

- UDP 500
- UDP 4500

HTTPS on `adblock.scanferlamatteo.work` is used for the debug collector and, later, for profile distribution. It is not a replacement for IKEv2 UDP traffic.

## Important Cloudflare note

A normal Cloudflare HTTP reverse proxy / Tunnel does not carry native IKEv2 UDP 500/4500.

Therefore the VPN endpoint must use one of these approaches:

1. port-forward UDP 500/4500 from the router to the Raspberry Pi;
2. place the VPN gateway on a public VPS;
3. use another transport/product that explicitly supports the required UDP forwarding.

The HTTPS debug collector can remain behind Cloudflare.
