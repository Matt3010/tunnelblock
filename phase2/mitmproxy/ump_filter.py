"""Local fail-closed filtering for encrypted YouTube Onesie/UMP responses."""

from __future__ import annotations

import gzip
import hashlib
import hmac
from dataclasses import dataclass
from typing import Callable

try:
    import brotli
except ModuleNotFoundError:  # Host pre-flight may omit it; mitmproxy includes it.
    brotli = None
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


ONESIE_HEADER = 10
ONESIE_DATA = 11
PLAYER_RESPONSE = 0
ENCRYPTED_INNERTUBE_RESPONSE_PART = 25


def _proto_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError("truncated protobuf varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, offset
    raise ValueError("oversized protobuf varint")


def _encode_proto_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("negative protobuf varint")
    encoded = bytearray()
    while value > 0x7f:
        encoded.append((value & 0x7f) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


@dataclass(frozen=True)
class ProtoField:
    number: int
    wire: int
    raw: bytes
    value: bytes | int


def _proto_fields(data: bytes) -> list[ProtoField]:
    fields = []
    offset = 0
    while offset < len(data):
        start = offset
        tag, offset = _proto_varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("invalid protobuf field")
        if wire == 0:
            value, offset = _proto_varint(data, offset)
        elif wire == 1:
            if offset + 8 > len(data):
                raise ValueError("truncated fixed64")
            value, offset = data[offset:offset + 8], offset + 8
        elif wire == 2:
            length, offset = _proto_varint(data, offset)
            if offset + length > len(data):
                raise ValueError("truncated bytes")
            value, offset = data[offset:offset + length], offset + length
        elif wire == 5:
            if offset + 4 > len(data):
                raise ValueError("truncated fixed32")
            value, offset = data[offset:offset + 4], offset + 4
        else:
            raise ValueError("unsupported protobuf wire type")
        fields.append(ProtoField(number, wire, data[start:offset], value))
    return fields


def _length_field(number: int, value: bytes) -> bytes:
    return (
        _encode_proto_varint((number << 3) | 2)
        + _encode_proto_varint(len(value))
        + value
    )


def _rewrite_length_fields(
    data: bytes,
    transforms: dict[int, Callable[[bytes], tuple[bytes, int]] | None],
) -> tuple[bytes, int]:
    output = bytearray()
    changes = 0
    for field in _proto_fields(data):
        transform = transforms.get(field.number, "missing")
        if transform == "missing":
            output.extend(field.raw)
        elif transform is None:
            if field.wire != 2:
                raise ValueError("removal field has unexpected wire type")
            changes += 1
        else:
            if field.wire != 2 or not isinstance(field.value, bytes):
                raise ValueError("target field has unexpected wire type")
            value, nested_changes = transform(field.value)
            output.extend(_length_field(field.number, value))
            changes += nested_changes
    return bytes(output), changes


def _first_varint(data: bytes, number: int) -> int | None:
    for field in _proto_fields(data):
        if field.number == number and field.wire == 0:
            assert isinstance(field.value, int)
            return field.value
    return None


def _first_bytes(data: bytes, number: int) -> bytes | None:
    for field in _proto_fields(data):
        if field.number == number and field.wire == 2:
            assert isinstance(field.value, bytes)
            return field.value
    return None


def _replace_bytes(data: bytes, replacements: dict[int, bytes]) -> bytes:
    seen = set()
    output = bytearray()
    for field in _proto_fields(data):
        if field.number in replacements:
            if field.wire != 2:
                raise ValueError("replacement field has unexpected wire type")
            output.extend(_length_field(field.number, replacements[field.number]))
            seen.add(field.number)
        else:
            output.extend(field.raw)
    if seen != set(replacements):
        raise ValueError("replacement field missing")
    return bytes(output)


def _filter_playback_tracking(data: bytes) -> tuple[bytes, int]:
    return _rewrite_length_fields(data, {18: None})


def _count_fields(data: bytes, numbers: set[int]) -> int:
    return sum(field.number in numbers for field in _proto_fields(data))


def _count_player_targets(data: bytes) -> int:
    count = _count_fields(data, {45, 68})
    for field in _proto_fields(data):
        if field.number == 9 and field.wire == 2:
            assert isinstance(field.value, bytes)
            count += _count_fields(field.value, {18})
    return count


def _filter_player(data: bytes) -> tuple[bytes, int]:
    return _rewrite_length_fields(
        data,
        {9: _filter_playback_tracking, 45: None, 68: None},
    )


def filter_player_response(data: bytes) -> tuple[bytes, int]:
    """Remove only schema-verified PlayerResponse ad decision fields."""
    try:
        planned = _count_player_targets(data)
        filtered, applied = _filter_player(data)
        if planned != applied:
            return data, 0
        return filtered, applied
    except ValueError:
        return data, 0


def _filter_next(data: bytes) -> tuple[bytes, int]:
    return _rewrite_length_fields(data, {53: None})


def _filter_content(data: bytes) -> tuple[bytes, int]:
    return _rewrite_length_fields(data, {2: _filter_player, 3: _filter_next})


def _filter_encrypted_wrapper(data: bytes) -> tuple[bytes, int]:
    return _rewrite_length_fields(data, {4: _filter_content})


def _count_content_targets(data: bytes) -> int:
    count = 0
    for field in _proto_fields(data):
        if field.wire != 2 or not isinstance(field.value, bytes):
            continue
        if field.number == 2:
            count += _count_player_targets(field.value)
        elif field.number == 3:
            count += _count_fields(field.value, {53})
    return count


def _count_wrapper_targets(data: bytes) -> int:
    count = 0
    for field in _proto_fields(data):
        if field.number == 4 and field.wire == 2:
            assert isinstance(field.value, bytes)
            count += _count_content_targets(field.value)
    return count


def _filter_player_envelope(data: bytes) -> tuple[bytes, int]:
    if _first_varint(data, 1) not in {None, 1}:
        raise ValueError("onesie proxy status is not OK")
    if _first_varint(data, 2) not in {None, 200}:
        raise ValueError("onesie HTTP status is not OK")

    def filter_body(body: bytes) -> tuple[bytes, int]:
        planned = _count_player_targets(body)
        filtered, applied = _filter_player(body)
        if planned != applied:
            raise ValueError("planned/applied PlayerResponse mismatch")
        return filtered, applied

    return _rewrite_length_fields(data, {4: filter_body})


def _crypt(client_key: bytes, iv: bytes, data: bytes) -> bytes:
    if len(client_key) != 32 or len(iv) != 16:
        raise ValueError("invalid Onesie crypto material")
    cipher = Cipher(algorithms.AES(client_key[:16]), modes.CTR(iv))
    operation = cipher.encryptor()
    return operation.update(data) + operation.finalize()


def _signature(client_key: bytes, ciphertext: bytes, iv: bytes) -> bytes:
    return hmac.new(client_key[16:], ciphertext + iv, hashlib.sha256).digest()


def _decrypt(client_key: bytes, iv: bytes, ciphertext: bytes, signature: bytes) -> bytes:
    if not hmac.compare_digest(_signature(client_key, ciphertext, iv), signature):
        raise ValueError("Onesie HMAC mismatch")
    return _crypt(client_key, iv, ciphertext)


def _decompress(data: bytes, algorithm: int) -> bytes:
    if algorithm == 0:
        return data
    if algorithm == 1:
        return gzip.decompress(data)
    if algorithm == 2:
        if brotli is None:
            raise ValueError("brotli support unavailable")
        return brotli.decompress(data)
    raise ValueError("unsupported compression")


def _compress(data: bytes, algorithm: int) -> bytes:
    if algorithm == 0:
        return data
    if algorithm == 1:
        return gzip.compress(data, mtime=0)
    if algorithm == 2:
        if brotli is None:
            raise ValueError("brotli support unavailable")
        return brotli.compress(data)
    raise ValueError("unsupported compression")


def _ump_varint(data: bytes, offset: int) -> tuple[int, int]:
    if offset >= len(data):
        raise ValueError("truncated UMP varint")
    first = data[offset]
    # Count leading one bits, capped at four.
    size = 1
    mask = 0x80
    while size < 5 and first & mask:
        size += 1
        mask >>= 1
    if offset + size > len(data):
        raise ValueError("truncated UMP varint")
    shift = 0 if size == 5 else 8 - size
    value = 0 if size == 5 else first & ((1 << shift) - 1)
    for index in range(1, size):
        value |= data[offset + index] << shift
        shift += 8
    return value, offset + size


def _encode_ump_varint(value: int) -> bytes:
    if not 0 <= value <= 0xffffffff:
        raise ValueError("UMP integer out of range")
    for size, bits in ((1, 7), (2, 14), (3, 21), (4, 28)):
        if value < 1 << bits:
            prefix = ((1 << (size - 1)) - 1) << (9 - size) if size > 1 else 0
            first_bits = 8 - size
            output = bytearray([prefix | (value & ((1 << first_bits) - 1))])
            value >>= first_bits
            for _ in range(1, size):
                output.append(value & 0xff)
                value >>= 8
            return bytes(output)
    return b"\xf0" + value.to_bytes(4, "little")


def _ump_parts(data: bytes) -> list[tuple[int, bytes]]:
    parts = []
    offset = 0
    while offset < len(data):
        part_type, offset = _ump_varint(data, offset)
        length, offset = _ump_varint(data, offset)
        if offset + length > len(data):
            raise ValueError("truncated UMP part")
        parts.append((part_type, data[offset:offset + length]))
        offset += length
    return parts


def _encode_ump_parts(parts: list[tuple[int, bytes]]) -> bytes:
    return b"".join(
        _encode_ump_varint(part_type) + _encode_ump_varint(len(payload)) + payload
        for part_type, payload in parts
    )


def _take_ump_frame(buffer: bytearray) -> tuple[int, bytes, bytes] | None:
    try:
        part_type, first_end = _ump_varint(buffer, 0)
        length, payload_start = _ump_varint(buffer, first_end)
    except ValueError:
        return None
    if length > 64 * 1024 * 1024:
        raise ValueError("UMP part exceeds safety limit")
    frame_end = payload_start + length
    if frame_end > len(buffer):
        return None
    raw = bytes(buffer[:frame_end])
    payload = bytes(buffer[payload_start:frame_end])
    del buffer[:frame_end]
    return part_type, payload, raw


def _header_crypto(header: bytes) -> tuple[int, bytes, bytes, int]:
    header_type = _first_varint(header, 1)
    crypto = _first_bytes(header, 4)
    if header_type is None or crypto is None:
        raise ValueError("incomplete Onesie header")
    signature = _first_bytes(crypto, 4)
    iv = _first_bytes(crypto, 5)
    compression = _first_varint(crypto, 6) or 0
    if signature is None or iv is None:
        raise ValueError("incomplete Onesie crypto params")
    return header_type, signature, iv, compression


def _filter_player_part(header: bytes, payload: bytes, key: bytes) -> tuple[bytes, bytes, int]:
    _, signature, iv, compression = _header_crypto(header)
    ciphertext = _decompress(payload, compression)
    plaintext = _decrypt(key, iv, ciphertext, signature)
    filtered, changes = _filter_player_envelope(plaintext)
    if not changes:
        return header, payload, 0
    new_ciphertext = _crypt(key, iv, filtered)
    new_signature = _signature(key, new_ciphertext, iv)
    crypto = _first_bytes(header, 4)
    assert crypto is not None
    new_crypto = _replace_bytes(crypto, {4: new_signature})
    return _replace_bytes(header, {4: new_crypto}), _compress(new_ciphertext, compression), changes


def _filter_encrypted_part(payload: bytes, key: bytes) -> tuple[bytes, int]:
    ciphertext = _first_bytes(payload, 1)
    signature = _first_bytes(payload, 2)
    iv = _first_bytes(payload, 3)
    compression = _first_varint(payload, 4) or 0
    if ciphertext is None or signature is None or iv is None:
        raise ValueError("incomplete encrypted response part")
    plaintext = _decompress(_decrypt(key, iv, ciphertext, signature), compression)
    planned = _count_wrapper_targets(plaintext)
    filtered, changes = _filter_encrypted_wrapper(plaintext)
    if planned != changes:
        raise ValueError("planned/applied encrypted response mismatch")
    if not changes:
        return payload, 0
    compressed = _compress(filtered, compression)
    new_ciphertext = _crypt(key, iv, compressed)
    replacements = {
        1: new_ciphertext,
        2: _signature(key, new_ciphertext, iv),
    }
    return _replace_bytes(payload, replacements), changes


def filter_ump_response(data: bytes, client_key: bytes) -> tuple[bytes, int]:
    """Filter exact ad decision fields or return the original bytes on failure."""
    try:
        parts = _ump_parts(data)
        output = list(parts)
        pending: tuple[int, int] | None = None
        changes = 0
        for index, (part_type, payload) in enumerate(parts):
            if part_type == ONESIE_HEADER:
                header_type = _first_varint(payload, 1)
                pending = (index, header_type) if header_type in {0, 25} else None
            elif part_type == ONESIE_DATA and pending is not None:
                header_index, header_type = pending
                if header_type == PLAYER_RESPONSE:
                    new_header, new_payload, count = _filter_player_part(
                        output[header_index][1], payload, client_key
                    )
                    output[header_index] = (ONESIE_HEADER, new_header)
                else:
                    new_payload, count = _filter_encrypted_part(payload, client_key)
                output[index] = (ONESIE_DATA, new_payload)
                changes += count
                pending = None
        if not changes:
            return data, 0
        rebuilt = _encode_ump_parts(output)
        # A complete parse of the rebuilt stream is the final structural guard.
        _ump_parts(rebuilt)
        return rebuilt, changes
    except Exception:
        return data, 0


class UmpStreamFilter:
    """Transform one authenticated Onesie pair while streaming media frames."""

    def __init__(self, client_key: bytes):
        self.client_key = client_key
        self.buffer = bytearray()
        self.pending_header: tuple[bytes, bytes, int] | None = None
        self.changes = 0
        self.failed = False

    def feed(self, chunk: bytes) -> bytes:
        if self.failed:
            return chunk
        if not chunk:
            output = bytearray()
            if self.pending_header is not None:
                output.extend(self.pending_header[0])
                self.pending_header = None
            output.extend(self.buffer)
            self.buffer.clear()
            return bytes(output)

        self.buffer.extend(chunk)
        output = bytearray()
        fallback = b""
        try:
            while True:
                frame = _take_ump_frame(self.buffer)
                if frame is None:
                    break
                part_type, payload, raw = frame
                fallback = raw
                if self.pending_header is not None:
                    header_raw, header_payload, header_type = self.pending_header
                    self.pending_header = None
                    if part_type == ONESIE_DATA:
                        fallback = header_raw + raw
                        if header_type == PLAYER_RESPONSE:
                            new_header, new_payload, count = _filter_player_part(
                                header_payload, payload, self.client_key
                            )
                        else:
                            new_header = header_payload
                            new_payload, count = _filter_encrypted_part(
                                payload, self.client_key
                            )
                        if count:
                            output.extend(_encode_ump_parts([
                                (ONESIE_HEADER, new_header),
                                (ONESIE_DATA, new_payload),
                            ]))
                            self.changes += count
                        else:
                            output.extend(header_raw)
                            output.extend(raw)
                        fallback = b""
                        continue
                    output.extend(header_raw)

                if part_type == ONESIE_HEADER and self.changes == 0:
                    header_type = _first_varint(payload, 1)
                    if header_type in {PLAYER_RESPONSE, ENCRYPTED_INNERTUBE_RESPONSE_PART}:
                        self.pending_header = (raw, payload, header_type)
                        fallback = b""
                        continue
                output.extend(raw)
                fallback = b""
        except Exception:
            self.failed = True
            if self.pending_header is not None:
                output.extend(self.pending_header[0])
                self.pending_header = None
            output.extend(fallback)
            output.extend(self.buffer)
            self.buffer.clear()
        return bytes(output)
