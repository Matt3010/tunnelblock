# strongSwan IKEv2 gateway

This directory contains the server-side IKEv2 configuration used by iOS.

The intended topology is:

```text
iPhone
  |
  | IKEv2
  v
Raspberry Pi / strongSwan
  |
  +--> DNS filtering
  +--> debug logging
  +--> Internet forwarding
```

Secrets and private keys must stay outside Git.
