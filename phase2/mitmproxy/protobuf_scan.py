from __future__ import annotations

from collections import Counter


MAX_FIELD_NUMBER = (1 << 29) - 1
DEFAULT_BACKTRACK_BYTES = 8192
DEFAULT_TAIL_BYTES = DEFAULT_BACKTRACK_BYTES + 256
MARKERS: dict[str, bytes] = {
    "pagead": b"/pagead/",
    "googleadservices": b"googleadservices.com",
}


def decode_varint(
    data: bytes | bytearray | memoryview,
    pos: int,
    max_bytes: int = 10,
) -> tuple[int, int] | None:
    value = 0
    shift = 0
    for offset in range(max_bytes):
        index = pos + offset
        if index >= len(data):
            return None
        byte = data[index]
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, index + 1
        shift += 7
    return None


def encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varint value must be non-negative")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def tag_bytes(field_number: int, wire_type: int = 2) -> bytes:
    if not 1 <= field_number <= MAX_FIELD_NUMBER:
        raise ValueError("field number out of range")
    if not 0 <= wire_type <= 5:
        raise ValueError("wire type out of range")
    return encode_varint((field_number << 3) | wire_type)


def enclosing_length_delimited_fields(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> list[tuple[int, int]]:
    """Return plausible length-delimited fields enclosing a marker.

    This is schema-free discovery. Each tuple is (field_number, distance) and
    results are nearest-first. Random bytes can look like protobuf tags, so callers
    must treat these as candidates and validate repeated observations.
    """

    if marker_start < 0 or marker_length <= 0:
        return []

    marker_end = marker_start + marker_length
    start = max(0, marker_start - max(0, backtrack_bytes))
    nearest: dict[int, int] = {}

    for pos in range(start, marker_start):
        key_decoded = decode_varint(data, pos, max_bytes=5)
        if key_decoded is None:
            continue
        key, key_end = key_decoded
        wire_type = key & 0x07
        field_number = key >> 3
        if wire_type != 2 or not 1 <= field_number <= MAX_FIELD_NUMBER:
            continue

        length_decoded = decode_varint(data, key_end, max_bytes=10)
        if length_decoded is None:
            continue
        payload_length, payload_start = length_decoded
        payload_end = payload_start + payload_length
        if payload_start <= marker_start and marker_end <= payload_end:
            distance = marker_start - pos
            if distance <= backtrack_bytes:
                previous = nearest.get(field_number)
                if previous is None or distance < previous:
                    nearest[field_number] = distance

    return sorted(nearest.items(), key=lambda item: (item[1], item[0]))


class ProtobufStreamScanner:
    """Scan uncompressed protobuf bytes in-flight without persisting payloads."""

    def __init__(
        self,
        backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
        tail_bytes: int = DEFAULT_TAIL_BYTES,
    ) -> None:
        self.backtrack_bytes = max(256, backtrack_bytes)
        self.tail_bytes = max(self.backtrack_bytes + 64, tail_bytes)
        self._tail = b""
        self._bytes_seen = 0
        self._marker_counts: Counter[str] = Counter()
        self._nearest_field_hits: Counter[int] = Counter()
        self._nearest_field_distance_sum: Counter[int] = Counter()
        self._nearest_field_min_distance: dict[int, int] = {}
        self._nearest_field_max_distance: dict[int, int] = {}

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return

        previous_total = self._bytes_seen
        combined = self._tail + chunk
        absolute_base = previous_total - len(self._tail)

        for marker_name, marker in MARKERS.items():
            search_from = 0
            while True:
                marker_pos = combined.find(marker, search_from)
                if marker_pos < 0:
                    break
                absolute_end = absolute_base + marker_pos + len(marker)
                if absolute_end > previous_total:
                    self._marker_counts[marker_name] += 1
                    candidates = enclosing_length_delimited_fields(
                        combined,
                        marker_pos,
                        len(marker),
                        self.backtrack_bytes,
                    )
                    if candidates:
                        field_number, distance = candidates[0]
                        self._nearest_field_hits[field_number] += 1
                        self._nearest_field_distance_sum[field_number] += distance
                        self._nearest_field_min_distance[field_number] = min(
                            distance,
                            self._nearest_field_min_distance.get(
                                field_number, distance
                            ),
                        )
                        self._nearest_field_max_distance[field_number] = max(
                            distance,
                            self._nearest_field_max_distance.get(
                                field_number, distance
                            ),
                        )
                search_from = marker_pos + 1

        self._bytes_seen += len(chunk)
        self._tail = combined[-self.tail_bytes :]

    def result(self, max_fields: int = 16) -> dict[str, object]:
        fields = sorted(
            self._nearest_field_hits.items(),
            key=lambda item: (
                -item[1],
                self._nearest_field_min_distance[item[0]],
                item[0],
            ),
        )[:max_fields]
        nearest_fields = {}
        for field, hits in fields:
            nearest_fields[str(field)] = {
                "hits": hits,
                "min_distance": self._nearest_field_min_distance[field],
                "max_distance": self._nearest_field_max_distance[field],
                "avg_distance": round(
                    self._nearest_field_distance_sum[field] / hits, 2
                ),
            }
        return {
            "body_bytes": self._bytes_seen,
            "markers": dict(sorted(self._marker_counts.items())),
            "nearest_fields": nearest_fields,
        }


def denature_ad_fields(
    data: bytes,
    target_fields: tuple[int, ...] | list[int],
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> tuple[bytes, dict[int, int]]:
    """Denature validated protobuf fields located immediately before ad markers.

    The replacement changes field_number to field_number - 1 while keeping wire
    type 2 and payload bytes untouched. Only explicitly configured target fields
    are eligible. This function is inert for an empty target list.
    """

    targets = tuple(
        dict.fromkeys(int(field) for field in target_fields if int(field) > 1)
    )
    if not data or not targets:
        return data, {}

    body = bytearray(data)
    mutations: Counter[int] = Counter()
    mutated_positions: set[int] = set()

    target_tags: dict[int, tuple[bytes, bytes]] = {}
    for field in targets:
        old = tag_bytes(field, 2)
        new = tag_bytes(field - 1, 2)
        if len(old) != len(new):
            continue
        target_tags[field] = (old, new)

    if not target_tags:
        return data, {}

    for marker in MARKERS.values():
        search_from = 0
        while True:
            marker_pos = body.find(marker, search_from)
            if marker_pos < 0:
                break
            start = max(0, marker_pos - max(0, backtrack_bytes))
            nearest: tuple[int, int, bytes, bytes] | None = None
            for field, (old, new) in target_tags.items():
                pos = body.rfind(old, start, marker_pos)
                if pos < 0:
                    continue
                candidate = (pos, field, old, new)
                if nearest is None or pos > nearest[0]:
                    nearest = candidate

            if nearest is not None:
                pos, field, old, new = nearest
                if (
                    pos not in mutated_positions
                    and body[pos : pos + len(old)] == old
                ):
                    body[pos : pos + len(old)] = new
                    mutated_positions.add(pos)
                    mutations[field] += 1
            search_from = marker_pos + 1

    return bytes(body), dict(sorted(mutations.items()))


if __name__ == "__main__":
    target = 50195462
    payload = b"prefix-/pagead/-suffix"
    field = tag_bytes(target) + encode_varint(len(payload)) + payload
    scanner = ProtobufStreamScanner()
    scanner.feed(field[:12])
    scanner.feed(field[12:])
    result = scanner.result()
    assert result["markers"]["pagead"] == 1
    assert result["nearest_fields"][str(target)]["hits"] == 1
    mutated, changes = denature_ad_fields(field, [target])
    assert changes == {target: 1}
    assert mutated != field and len(mutated) == len(field)
