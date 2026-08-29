# Raspberry Pi debug logger

Run the collector on the Raspberry Pi:

```bash
cd server
npm install
DEBUG_TOKEN=<your-secret-token> npm run debug-server
```

Public collector:

```text
POST https://adblock.scanferlamatteo.work/events
GET  https://adblock.scanferlamatteo.work/health
```

Client environment:

```bash
DEBUG_ENDPOINT=https://adblock.scanferlamatteo.work/events
DEBUG_TOKEN=<your-secret-token>
```

The token must remain outside Git and should be supplied only through the runtime environment.

## Payload policy for the development phase

For simplicity, debug mode keeps the complete payload available to the capture layer.

- UTF-8 data is sent as-is.
- Binary data is base64 encoded.
- No field redaction is performed.
- The collector accepts events up to 10 MiB.
- HTTPS plaintext is not available unless a later milestone explicitly implements TLS interception.

This mode is for trusted development devices and a trusted Raspberry Pi only.
