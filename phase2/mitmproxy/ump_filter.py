"""Fail-closed request-side control for YouTube Onesie preroll placement."""

from __future__ import annotations

from dataclasses import dataclass


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


def _disable_preroll(inner: bytes) -> tuple[bytes, int, int, int]:
    output = bytearray()
    planned = 0
    applied = 0
    already_false = 0
    for field in _proto_fields(inner):
        if field.number != 13:
            output.extend(field.raw)
            continue
        if field.wire != 0 or not isinstance(field.value, int):
            raise ValueError("preroll field has unexpected wire type")
        if field.value not in {0, 1}:
            raise ValueError("preroll field is not boolean")
        if field.value == 1:
            planned += 1
            replacement = (
                _encode_proto_varint((field.number << 3) | field.wire)
                + _encode_proto_varint(0)
            )
            if len(replacement) != len(field.raw):
                raise ValueError("preroll replacement changed size")
            output.extend(replacement)
            applied += 1
        else:
            output.extend(field.raw)
            already_false += 1
    return bytes(output), planned, applied, already_false


def disable_preroll_request(data: bytes) -> tuple[bytes, int, str]:
    """Set public-schema InnertubeRequest.enable_ad_placements_preroll false."""
    try:
        output = bytearray()
        planned = 0
        applied = 0
        already_false = 0
        innertube_requests = 0
        for field in _proto_fields(data):
            if field.number != 3:
                output.extend(field.raw)
                continue
            if field.wire != 2 or not isinstance(field.value, bytes):
                raise ValueError("InnertubeRequest has unexpected wire type")
            innertube_requests += 1
            inner, inner_planned, inner_applied, inner_false = _disable_preroll(
                field.value
            )
            output.extend(_length_field(field.number, inner))
            planned += inner_planned
            applied += inner_applied
            already_false += inner_false
        rebuilt = bytes(output)
        if planned != applied or len(rebuilt) != len(data):
            return data, 0, "rejected"
        if planned == 0:
            result = "already_false" if already_false else "absent"
            return data, 0, result
        _proto_fields(rebuilt)
        if innertube_requests == 0:
            return data, 0, "rejected"
        return rebuilt, applied, "applied"
    except ValueError:
        return data, 0, "rejected"
