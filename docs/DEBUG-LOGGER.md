# Raspberry Pi debug logger

Run:

```bash
cd server
npm install
DEBUG_TOKEN=change-me npm run debug-server
```

Default endpoint:

```text
POST http://raspberry-pi:8787/events
GET  http://raspberry-pi:8787/health
```

Client environment:

```bash
DEBUG_ENDPOINT=http://raspberry-pi:8787/events
DEBUG_TOKEN=change-me
```

## Payload policy for the development phase

For simplicity, debug mode keeps the complete payload available to the capture layer.

- UTF-8 data is sent as-is.
- Binary data is base64 encoded.
- No field redaction is performed.
- The collector accepts events up to 10 MiB.
- HTTPS plaintext is not available unless a later milestone explicitly implements TLS interception.

This mode is for trusted development devices and a trusted Raspberry Pi only.
