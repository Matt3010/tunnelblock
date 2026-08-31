"""Privacy-minimized helpers for YouTube Onesie/UMP diagnostics."""

from __future__ import annotations

CONFIG_PATH = (1, 16, 7, 138536474, 146311580)


def _varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError("truncated_varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, offset
    raise ValueError("oversized_varint")


def _fields(data: bytes) -> list[tuple[int, int, bytes | int]]:
    result = []
    offset = 0
    while offset < len(data):
        tag, offset = _varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("invalid_field")
        if wire == 0:
            value, offset = _varint(data, offset)
        elif wire == 1:
            if offset + 8 > len(data):
                raise ValueError("truncated_fixed64")
            value, offset = data[offset:offset + 8], offset + 8
        elif wire == 2:
            length, offset = _varint(data, offset)
            if offset + length > len(data):
                raise ValueError("truncated_bytes")
            value, offset = data[offset:offset + length], offset + length
        elif wire == 5:
            if offset + 4 > len(data):
                raise ValueError("truncated_fixed32")
            value, offset = data[offset:offset + 4], offset + 4
        else:
            raise ValueError("unsupported_wire_type")
        result.append((number, wire, value))
    return result


def _descend(data: bytes, path: tuple[int, ...]) -> list[bytes]:
    nodes = [data]
    for wanted in path:
        next_nodes = []
        for node in nodes:
            for number, wire, value in _fields(node):
                if number == wanted and wire == 2 and isinstance(value, bytes):
                    next_nodes.append(value)
        nodes = next_nodes
        if not nodes:
            break
    return nodes


def inspect_onesie_config(body: bytes) -> dict[str, object]:
    """Return only non-secret metadata from the exact known config path."""
    try:
        nodes = _descend(body, CONFIG_PATH)
        configs = []
        for node in nodes:
            fields = _fields(node)
            byte_lengths = {
                number: len(value)
                for number, wire, value in fields
                if wire == 2 and isinstance(value, bytes) and number in {1, 2}
            }
            varints = {
                number: value
                for number, wire, value in fields
                if wire == 0 and isinstance(value, int) and number in {3, 30}
            }
            expiry = int(varints.get(3, 0))
            configs.append({
                "client_key_present": byte_lengths.get(1, 0) > 0,
                "client_key_bytes": byte_lengths.get(1, 0),
                "encrypt_key_present": byte_lengths.get(2, 0) > 0,
                "encrypt_key_bytes": byte_lengths.get(2, 0),
                "expiry_bucket_seconds": (expiry // 300) * 300 if expiry else 0,
                "hot_config_enabled": bool(varints.get(30, 0)),
            })
        return {"parsed": True, "config_nodes": len(nodes), "configs": configs}
    except ValueError as error:
        return {"parsed": False, "reason": str(error), "config_nodes": 0, "configs": []}


class ByteCounter:
    def __init__(self) -> None:
        self.body_bytes = 0
        self.chunks = 0

    def __repr__(self) -> str:
        return f"ByteCounter(body_bytes={self.body_bytes}, chunks={self.chunks})"

    def feed(self, chunk: bytes) -> bytes:
        if chunk:
            self.body_bytes += len(chunk)
            self.chunks += 1
        return chunk
