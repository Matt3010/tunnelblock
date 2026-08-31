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


def enclosing_length_delimited_candidates(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> list[tuple[int, int, int]]:
    """Return plausible enclosing protobuf fields as (field, distance, tag_pos).

    A candidate is accepted only when its decoded length-delimited payload
    actually contains the complete marker. Results are nearest-first.
    """

    if marker_start < 0 or marker_length <= 0:
        return []

    marker_end = marker_start + marker_length
    start = max(0, marker_start - max(0, backtrack_bytes))
    candidates: list[tuple[int, int, int]] = []

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
                candidates.append((field_number, distance, pos))

    return sorted(candidates, key=lambda item: (item[1], item[0], item[2]))


def enclosing_length_delimited_fields(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> list[tuple[int, int]]:
    """Return nearest occurrence of each plausible enclosing field."""

    nearest: dict[int, int] = {}
    for field_number, distance, _pos in enclosing_length_delimited_candidates(
        data,
        marker_start,
        marker_length,
        backtrack_bytes,
    ):
        if field_number not in nearest:
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
        self._marker_without_candidate: Counter[str] = Counter()
        self._candidate_fields: Counter[int] = Counter()
        self._nearest_fields: Counter[int] = Counter()
        self._nearest_distance_total: Counter[int] = Counter()
        self._nearest_distance_min: dict[int, int] = {}
        self._nearest_distance_max: dict[int, int] = {}

    def _record_nearest(self, field_number: int, distance: int) -> None:
        self._nearest_fields[field_number] += 1
        self._nearest_distance_total[field_number] += distance
        previous_min = self._nearest_distance_min.get(field_number)
        previous_max = self._nearest_distance_max.get(field_number)
        if previous_min is None or distance < previous_min:
            self._nearest_distance_min[field_number] = distance
        if previous_max is None or distance > previous_max:
            self._nearest_distance_max[field_number] = distance

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
                    fields = enclosing_length_delimited_fields(
                        combined,
                        marker_pos,
                        len(marker),
                        self.backtrack_bytes,
                    )
                    for field_number, _distance in fields[:12]:
                        self._candidate_fields[field_number] += 1
                    if fields:
                        self._record_nearest(*fields[0])
                    else:
                        self._marker_without_candidate[marker_name] += 1
                search_from = marker_pos + 1

        self._bytes_seen += len(chunk)
        self._tail = combined[-self.tail_bytes :]

    def result(self, max_fields: int = 16) -> dict[str, object]:
        fields = sorted(
            self._candidate_fields.items(),
            key=lambda item: (-item[1], item[0]),
        )[:max_fields]
        nearest = sorted(
            self._nearest_fields.items(),
            key=lambda item: (-item[1], item[0]),
        )[:max_fields]
        distance_stats: dict[str, dict[str, int | float]] = {}
        for field, hits in nearest:
            total = self._nearest_distance_total[field]
            distance_stats[str(field)] = {
                "hits": hits,
                "min": self._nearest_distance_min[field],
                "max": self._nearest_distance_max[field],
                "avg": round(total / hits, 2),
            }

        return {
            "body_bytes": self._bytes_seen,
            "markers": dict(sorted(self._marker_counts.items())),
            "markers_without_candidate": dict(
                sorted(self._marker_without_candidate.items())
            ),
            "candidate_fields": {str(field): count for field, count in fields},
            "nearest_candidate_fields": {
                str(field): count for field, count in nearest
            },
            "nearest_candidate_distance_bytes": distance_stats,
        }


def denature_ad_fields(
    data: bytes,
    target_fields: tuple[int, ...] | list[int],
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> tuple[bytes, dict[int, int]]:
    """Denature validated protobuf fields that genuinely enclose ad markers.

    The replacement changes field_number to field_number - 1 while keeping wire
    type 2 and payload bytes untouched. Only explicitly configured target fields
    are eligible, and the decoded field length must contain the marker.
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

            for field, _distance, pos in enclosing_length_delimited_candidates(
                body,
                marker_pos,
                len(marker),
                backtrack_bytes,
            ):
                tags = target_tags.get(field)
                if tags is None or pos in mutated_positions:
                    continue
                old, new = tags
                if body[pos : pos + len(old)] != old:
                    continue
                body[pos : pos + len(old)] = new
                mutated_positions.add(pos)
                mutations[field] += 1
                break

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
    assert result["nearest_candidate_fields"][str(target)] == 1
    mutated, changes = denature_ad_fields(field, [target])
    assert changes == {target: 1}
    assert mutated != field and len(mutated) == len(field)
