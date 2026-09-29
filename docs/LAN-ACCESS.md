# Per-user LAN access

Every VPN user always has Internet access. Access to the home network (private
IPv4 ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`)
is decided per user from Telegram:

| Mode | Effect |
| --- | --- |
| 🌐 Internet only | No LAN destination is reachable. Default for new users. |
| 🎯 Selected devices | Only the chosen device/port pairs (or whole devices) are reachable. |
| 🔓 Full LAN | Every LAN device and port is reachable, including private IPv6. |

Users created before this feature have no policy file and keep **Full LAN**, so
upgrading never cuts existing access. Restrict them from Telegram when needed.

## Telegram

`/vpn` → select a user → **🏠 LAN access**.

- Devices and open ports come from the automatic network discovery, so the lists
  are prefilled: tap a device, then tick the ports this user may reach, or
  **All ports** for the whole device.
- **➕ Manual rule** adds devices or ports the scan did not see
  (`192.168.1.50`, `192.168.1.50:8123`, `192.168.1.50 udp 1900`).
- **🔍 Rescan network** refreshes the inventory on demand.

Selecting a port also allows ping (ICMP echo) to that device. Changes apply
immediately, including to connections that are already open.

## Network discovery

The `lan-discovery` service (Compose profile `tools`, stopped by default) runs
`nmap` in the host network namespace against the Raspberry's own LAN:

- subnet of the default-route interface (networks larger than `/22` are limited
  to the `/24` around the Raspberry);
- ARP host discovery plus a TCP SYN scan of common home/self-hosted service ports
  (override with `LAN_DISCOVERY_PORTS`);
- reverse-DNS hostnames and MAC vendors when available.

The updater runs it at startup when no inventory exists, every
`LAN_SCAN_INTERVAL_HOURS` (default 12, `0` disables) and on request from Telegram.
The inventory is stored in the updater volume (`lan-inventory.json`). UDP services
are not scanned; add them as manual rules.

## Firewall model

Inside the WireGuard namespace, traffic from `wg0` to the egress interface passes
through `TB_LAN` before the generic Internet accept:

```text
FORWARD -i wg0 -o eth0 -> TB_LAN        private destinations -> TB_LAN_PRIV
                          TB_LAN_PRIV   -> TB_LAN_PEERS, then REJECT
                          TB_LAN_PEERS  per-user ACCEPT rules
```

`TB_LAN_PEERS` is rebuilt atomically with `iptables-restore` from
`data/wireguard/peers/<name>/lan`; the final REJECT never moves, so a rebuild fails
closed. Custom rules are IPv4-only; only Full LAN users reach private IPv6.
