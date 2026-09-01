import base64
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import selectors
import socket
import struct
import time
from collections import deque

MDNS_GROUP = "224.0.0.251"
MDNS_PORT = 5353
SSDP_GROUP = "239.255.255.250"
SSDP_PORT = 1900
DEFAULT_CONTROL_PORT = 39090
READY_FILE = "/tmp/discovery-relay.ready"
MAX_CONTROL_BYTES = 32768
AUTH_WINDOW_SECONDS = 60


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return default if value is None else int(value)


def canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


class ReplayCache:
    def __init__(self, ttl: int = AUTH_WINDOW_SECONDS) -> None:
        self.ttl = ttl
        self._items = {}
        self._order = deque()

    def add(self, message_id: str, now: float) -> bool:
        self.prune(now)
        if message_id in self._items:
            return False
        self._items[message_id] = now
        self._order.append((message_id, now))
        return True

    def prune(self, now: float) -> None:
        cutoff = now - self.ttl
        while self._order and self._order[0][1] < cutoff:
            message_id, timestamp = self._order.popleft()
            if self._items.get(message_id) == timestamp:
                self._items.pop(message_id, None)


class Codec:
    def __init__(self, token: str) -> None:
        if not token:
            raise ValueError("DISCOVERY_RELAY_TOKEN is required")
        self.key = token.encode("utf-8")
        self.replays = ReplayCache()

    def encode(self, kind: str, **fields) -> bytes:
        body = {
            "v": 1,
            "kind": kind,
            "ts": int(time.time()),
            "id": secrets.token_hex(8),
            **fields,
        }
        signature = hmac.new(self.key, canonical_json(body), hashlib.sha256).hexdigest()
        envelope = {**body, "sig": signature}
        encoded = canonical_json(envelope)
        if len(encoded) > MAX_CONTROL_BYTES:
            raise ValueError("control datagram too large")
        return encoded

    def decode(self, data: bytes) -> dict:
        if len(data) > MAX_CONTROL_BYTES:
            raise ValueError("control datagram too large")
        envelope = json.loads(data.decode("utf-8"))
        if envelope.get("v") != 1:
            raise ValueError("unsupported control protocol")
        signature = envelope.pop("sig", "")
        expected = hmac.new(self.key, canonical_json(envelope), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid control signature")
        now = time.time()
        timestamp = int(envelope.get("ts", 0))
        if abs(now - timestamp) > AUTH_WINDOW_SECONDS:
            raise ValueError("stale control datagram")
        message_id = envelope.get("id")
        if not isinstance(message_id, str) or not self.replays.add(message_id, now):
            raise ValueError("replayed control datagram")
        return envelope


def get_iface_ipv4(name: str) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        packed = struct.pack("256s", name[:15].encode("utf-8"))
        result = fcntl.ioctl(sock.fileno(), 0x8915, packed)
    return socket.inet_ntoa(result[20:24])


def route_entries():
    entries = []
    with open("/proc/net/route", "r", encoding="utf-8") as handle:
        next(handle, None)
        for line in handle:
            parts = line.strip().split()
            if len(parts) < 8:
                continue
            iface, destination, gateway, flags, _, _, metric = parts[:7]
            if destination != "00000000":
                continue
            try:
                flags_value = int(flags, 16)
                metric_value = int(metric)
                gateway_ip = socket.inet_ntoa(struct.pack("<L", int(gateway, 16)))
            except (ValueError, OSError):
                continue
            if not flags_value & 0x2:
                continue
            entries.append((metric_value, iface, gateway_ip))
    return sorted(entries)


def detect_default_iface() -> str:
    entries = route_entries()
    if not entries:
        raise RuntimeError("no default IPv4 route found")
    return entries[0][1]


def detect_default_gateway() -> str:
    entries = route_entries()
    if not entries:
        raise RuntimeError("no default IPv4 route found")
    return entries[0][2]


def make_udp_socket(bind_host: str, bind_port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((bind_host, bind_port))
    sock.setblocking(False)
    return sock


def make_multicast_socket(group: str, port: int, iface_ip: str, ttl: int) -> socket.socket:
    sock = make_udp_socket("", port)
    membership = socket.inet_aton(group) + socket.inet_aton(iface_ip)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface_ip))
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
    return sock


def make_ssdp_search_socket(iface_ip: str) -> socket.socket:
    sock = make_udp_socket(iface_ip, 0)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface_ip))
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
    return sock


def is_mdns_query(payload: bytes) -> bool:
    if len(payload) < 12:
        return False
    flags = struct.unpack("!H", payload[2:4])[0]
    return (flags & 0x8000) == 0


def is_mdns_response(payload: bytes) -> bool:
    if len(payload) < 12:
        return False
    flags = struct.unpack("!H", payload[2:4])[0]
    return (flags & 0x8000) != 0


def force_mdns_multicast_response(payload: bytes) -> bytes:
    if not is_mdns_query(payload) or len(payload) < 12:
        return payload
    questions = struct.unpack("!H", payload[4:6])[0]
    if questions == 0:
        return payload

    data = bytearray(payload)
    offset = 12
    try:
        for _ in range(questions):
            while True:
                if offset >= len(data):
                    raise ValueError
                length = data[offset]
                if length == 0:
                    offset += 1
                    break
                if length & 0xC0 == 0xC0:
                    if offset + 1 >= len(data):
                        raise ValueError
                    offset += 2
                    break
                if length & 0xC0:
                    raise ValueError
                offset += 1 + length
            if offset + 4 > len(data):
                raise ValueError
            qclass_offset = offset + 2
            qclass = struct.unpack("!H", data[qclass_offset:qclass_offset + 2])[0]
            qclass &= 0x7FFF
            data[qclass_offset:qclass_offset + 2] = struct.pack("!H", qclass)
            offset += 4
    except ValueError:
        return payload

    return bytes(data)


def is_ssdp_search(payload: bytes) -> bool:
    first_line = payload.split(b"\r\n", 1)[0].strip().upper()
    return first_line == b"M-SEARCH * HTTP/1.1"


def is_ssdp_response(payload: bytes) -> bool:
    first_line = payload.split(b"\r\n", 1)[0].strip().upper()
    return first_line.startswith(b"HTTP/1.1 200")


def encode_payload(payload: bytes) -> str:
    return base64.b64encode(payload).decode("ascii")


def decode_payload(value: str) -> bytes:
    payload = base64.b64decode(value, validate=True)
    if len(payload) > 16384:
        raise ValueError("discovery payload too large")
    return payload


def prune_clients(items: dict, ttl: int, now: float) -> None:
    for key, last_seen in list(items.items()):
        if now - last_seen > ttl:
            items.pop(key, None)


def is_vpn_client(address: str, subnet: ipaddress.IPv4Network, server_ip: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return isinstance(ip, ipaddress.IPv4Address) and ip in subnet and address != server_ip


def write_ready() -> None:
    with open(READY_FILE, "w", encoding="utf-8") as handle:
        handle.write("ready\n")


def run_host(codec: Codec, control_port: int) -> None:
    configured_iface = os.getenv("DISCOVERY_LAN_IFACE", "auto")
    lan_iface = detect_default_iface() if configured_iface == "auto" else configured_iface
    lan_ip = get_iface_ipv4(lan_iface)

    control = make_udp_socket("", control_port)
    mdns = make_multicast_socket(MDNS_GROUP, MDNS_PORT, lan_ip, 255)
    ssdp_search = make_ssdp_search_socket(lan_ip)

    selector = selectors.DefaultSelector()
    selector.register(control, selectors.EVENT_READ, "control")
    selector.register(mdns, selectors.EVENT_READ, "mdns")
    selector.register(ssdp_search, selectors.EVENT_READ, "ssdp")

    vpn_endpoint = None
    vpn_seen_at = 0.0
    write_ready()
    print(f"Discovery host relay ready on {lan_iface} ({lan_ip}), control UDP/{control_port}", flush=True)

    while True:
        for key, _ in selector.select(timeout=1.0):
            now = time.time()
            if key.data == "control":
                try:
                    data, addr = control.recvfrom(MAX_CONTROL_BYTES + 1)
                    message = codec.decode(data)
                except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    continue

                kind = message.get("kind")
                if kind == "register":
                    vpn_endpoint = addr
                    vpn_seen_at = now
                    continue

                if kind != "packet":
                    continue

                vpn_endpoint = addr
                vpn_seen_at = now
                try:
                    payload = decode_payload(message.get("payload", ""))
                except (ValueError, TypeError):
                    continue

                proto = message.get("proto")
                if proto == "mdns" and is_mdns_query(payload):
                    mdns.sendto(force_mdns_multicast_response(payload), (MDNS_GROUP, MDNS_PORT))
                elif proto == "ssdp" and is_ssdp_search(payload):
                    ssdp_search.sendto(payload, (SSDP_GROUP, SSDP_PORT))

            elif key.data == "mdns":
                try:
                    payload, _ = mdns.recvfrom(16384)
                except OSError:
                    continue
                if not is_mdns_response(payload):
                    continue
                if vpn_endpoint and now - vpn_seen_at <= 15:
                    try:
                        control.sendto(
                            codec.encode("packet", proto="mdns", payload=encode_payload(payload)),
                            vpn_endpoint,
                        )
                    except (OSError, ValueError):
                        pass

            elif key.data == "ssdp":
                try:
                    payload, _ = ssdp_search.recvfrom(16384)
                except OSError:
                    continue
                if not is_ssdp_response(payload):
                    continue
                if vpn_endpoint and now - vpn_seen_at <= 15:
                    try:
                        control.sendto(
                            codec.encode("packet", proto="ssdp", payload=encode_payload(payload)),
                            vpn_endpoint,
                        )
                    except (OSError, ValueError):
                        pass


def run_vpn(codec: Codec, control_port: int) -> None:
    wg_iface = os.getenv("DISCOVERY_WG_IFACE", "wg0")
    wg_ip = get_iface_ipv4(wg_iface)
    subnet = ipaddress.ip_network(os.getenv("WG_IPV4_SUBNET", "10.66.66.0/24"))
    host_gateway = os.getenv("DISCOVERY_HOST_GATEWAY") or detect_default_gateway()
    host_endpoint = (host_gateway, control_port)
    mdns_client_ttl = env_int("DISCOVERY_MDNS_CLIENT_TTL", 120)
    ssdp_client_ttl = env_int("DISCOVERY_SSDP_CLIENT_TTL", 15)

    control = make_udp_socket("", 0)
    mdns = make_udp_socket(wg_ip, MDNS_PORT)
    ssdp = make_udp_socket(wg_ip, SSDP_PORT)

    selector = selectors.DefaultSelector()
    selector.register(control, selectors.EVENT_READ, "control")
    selector.register(mdns, selectors.EVENT_READ, "mdns")
    selector.register(ssdp, selectors.EVENT_READ, "ssdp")

    mdns_clients = {}
    ssdp_clients = {}
    last_register = 0.0

    write_ready()
    print(
        f"Discovery VPN relay ready on {wg_iface} ({wg_ip}), host gateway {host_gateway}:{control_port}",
        flush=True,
    )

    while True:
        now = time.time()
        if now - last_register >= 5:
            try:
                control.sendto(codec.encode("register"), host_endpoint)
                last_register = now
            except (OSError, ValueError):
                pass

        prune_clients(mdns_clients, mdns_client_ttl, now)
        prune_clients(ssdp_clients, ssdp_client_ttl, now)

        for key, _ in selector.select(timeout=1.0):
            now = time.time()

            if key.data == "mdns":
                try:
                    payload, addr = mdns.recvfrom(16384)
                except OSError:
                    continue
                client_ip, _ = addr
                if not is_vpn_client(client_ip, subnet, wg_ip) or not is_mdns_query(payload):
                    continue
                mdns_clients[client_ip] = now
                try:
                    control.sendto(
                        codec.encode("packet", proto="mdns", payload=encode_payload(payload)),
                        host_endpoint,
                    )
                except (OSError, ValueError):
                    pass

            elif key.data == "ssdp":
                try:
                    payload, addr = ssdp.recvfrom(16384)
                except OSError:
                    continue
                client_ip, client_port = addr
                if not is_vpn_client(client_ip, subnet, wg_ip) or not is_ssdp_search(payload):
                    continue
                ssdp_clients[(client_ip, client_port)] = now
                try:
                    control.sendto(
                        codec.encode("packet", proto="ssdp", payload=encode_payload(payload)),
                        host_endpoint,
                    )
                except (OSError, ValueError):
                    pass

            elif key.data == "control":
                try:
                    data, addr = control.recvfrom(MAX_CONTROL_BYTES + 1)
                except OSError:
                    continue
                if addr[0] != host_gateway or addr[1] != control_port:
                    continue
                try:
                    message = codec.decode(data)
                    if message.get("kind") != "packet":
                        continue
                    payload = decode_payload(message.get("payload", ""))
                except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
                    continue

                proto = message.get("proto")
                if proto == "mdns" and is_mdns_response(payload):
                    prune_clients(mdns_clients, mdns_client_ttl, now)
                    for client_ip in list(mdns_clients):
                        try:
                            mdns.sendto(payload, (client_ip, MDNS_PORT))
                        except OSError:
                            pass
                elif proto == "ssdp" and is_ssdp_response(payload):
                    prune_clients(ssdp_clients, ssdp_client_ttl, now)
                    for client_addr in list(ssdp_clients):
                        try:
                            ssdp.sendto(payload, client_addr)
                        except OSError:
                            pass


def main() -> None:
    mode = os.getenv("DISCOVERY_MODE", "").strip().lower()
    if mode not in {"host", "vpn"}:
        raise SystemExit("DISCOVERY_MODE must be 'host' or 'vpn'")
    control_port = env_int("DISCOVERY_RELAY_PORT", DEFAULT_CONTROL_PORT)
    codec = Codec(os.getenv("DISCOVERY_RELAY_TOKEN", ""))

    if mode == "host":
        run_host(codec, control_port)
    else:
        run_vpn(codec, control_port)


if __name__ == "__main__":
    main()
