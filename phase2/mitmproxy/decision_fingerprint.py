from __future__ import annotations

import hashlib
import json
from collections import Counter

from protobuf_scan import MAX_FIELD_NUMBER, decode_varint


MAX_DEPTH = 7
MAX_FIELDS = 12000
MAX_CANDIDATES = 96


def _size_bucket(value: int) -> str:
    if value == 0:
        return "0"
    return str(1 << (value.bit_length() - 1))


def _scalar_bucket(value: int) -> str:
    if value <= 1:
        return str(value)
    lower = 1 << (value.bit_length() - 1)
    return f"{lower}-{(lower << 1) - 1}"


def _digest(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:20]


def _parse_message(
    data: memoryview,
    start: int,
    end: int,
    budget: list[int],
) -> list[tuple[int, int, int, int]] | None:
    fields: list[tuple[int, int, int, int]] = []
    pos = start
    while pos < end:
        if budget[0] <= 0:
            return None
        budget[0] -= 1
        decoded = decode_varint(data, pos, max_bytes=5)
        if decoded is None:
            return None
        key, value_start = decoded
        field, wire = key >> 3, key & 7
        if not 1 <= field <= MAX_FIELD_NUMBER or wire in {3, 4, 6, 7}:
            return None
        payload_start = value_start
        if wire == 0:
            value = decode_varint(data, value_start)
            if value is None:
                return None
            payload_end = value[1]
        elif wire == 1:
            payload_end = value_start + 8
        elif wire == 2:
            length = decode_varint(data, value_start)
            if length is None:
                return None
            payload_start = length[1]
            payload_end = payload_start + length[0]
        else:
            payload_end = value_start + 4
        if payload_end > end:
            return None
        fields.append((field, wire, payload_start, payload_end))
        pos = payload_end
    return fields if pos == end else None


def structural_fingerprint(body: bytes) -> dict[str, object]:
    """Describe protobuf structure without retaining scalar or byte values."""
    view = memoryview(body)
    budget = [MAX_FIELDS]
    root = _parse_message(view, 0, len(view), budget)
    if root is None:
        return {"parsed": False}

    paths: Counter[str] = Counter()
    fingerprints: Counter[str] = Counter()
    path_fingerprints: Counter[str] = Counter()
    wire_fields: Counter[str] = Counter()
    scalar_buckets: Counter[str] = Counter()
    candidates = 0

    def visit(
        fields: list[tuple[int, int, int, int]],
        path: tuple[int, ...],
        depth: int,
    ) -> list[object]:
        nonlocal candidates
        shape: list[object] = []
        for field, wire, payload_start, payload_end in fields:
            wire_fields[f"{field}:{wire}"] += 1
            node_path = path + (field,)
            path_key = ">".join(map(str, node_path))
            child = None
            if wire == 2 and depth < MAX_DEPTH and payload_end > payload_start:
                speculative_budget = [budget[0]]
                child = _parse_message(
                    view, payload_start, payload_end, speculative_budget
                )
                if child:
                    budget[0] = speculative_budget[0]
            if child:
                child_shape = visit(child, node_path, depth + 1)
                token: object = [field, wire, child_shape]
                if candidates < MAX_CANDIDATES:
                    child_digest = _digest(child_shape)
                    paths[path_key] += 1
                    fingerprints[child_digest] += 1
                    path_fingerprints[f"{path_key}#{child_digest}"] += 1
                    candidates += 1
            else:
                if wire == 0:
                    decoded = decode_varint(view, payload_start)
                    bucket = _scalar_bucket(decoded[0]) if decoded else "invalid"
                    scalar_buckets[f"{path_key}#{bucket}"] += 1
                else:
                    bucket = _size_bucket(payload_end - payload_start)
                token = [field, wire, bucket]
            shape.append(token)
        return shape

    shape = visit(root, (), 0)
    return {
        "parsed": True,
        "root_fingerprint": _digest(shape),
        "root_fields": dict(
            sorted(Counter(str(field) for field, *_ in root).items())
        ),
        "wire_fields": dict(wire_fields.most_common(64)),
        "scalar_buckets": dict(scalar_buckets.most_common(64)),
        "nested_paths": dict(paths.most_common(48)),
        "subtree_fingerprints": dict(fingerprints.most_common(48)),
        "path_fingerprints": dict(path_fingerprints.most_common(64)),
        "field_count": MAX_FIELDS - budget[0],
        "candidate_count": candidates,
    }
