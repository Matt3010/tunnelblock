# Debug logger

The existing Fastify collector in `server/` remains the debug backend.

Public endpoint:

```text
https://adblock.scanferlamatteo.work/events
```

For the initial lab phase, full payloads available to the capture layer may be logged.

HTTPS application payload remains encrypted unless a later explicit TLS-inspection mode is implemented.
