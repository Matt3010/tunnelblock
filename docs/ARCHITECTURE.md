# Architecture

## M0

```text
iOS app
  |
  v
NEPacketTunnelProvider
  |
  +--> local DNS / hostname filtering engine
  |
  +--> normal Internet routing

Optional debug stream
  |
  v
Raspberry Pi debug collector
```

The debug collector can receive the full payload available to the tunnel.

Without TLS interception, HTTPS application payload remains encrypted. Raw packet payloads can still be recorded for protocol analysis.

Debugging must never be required for filtering to work.
