from __future__ import annotations

from collections import Counter


MAX_FIELD_NUMBER = (1 << 29) - 1
DEFAULT_BACKTRACK_BYTES = 8192
DEFAULT_TAIL_BYTES = DEFAULT_BACKTRACK_BYTES + 256
MAX_ANCESTOR_DEPTH = 8
MARKERS: dict[str, bytes] = {
    "pagead": b"/pagead/",
    "googleadservices": b"googleadservices.com",
}

CandidateDetail = tuple[int, int, int, int, int]


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


def _length_delimited_candidate_details(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int,
    require_complete_payload: bool,
) -> list[CandidateDetail]:
    if marker_start < 0 or marker_length <= 0:
        return []

    marker_end = marker_start + marker_length
    start = max(0, marker_start - max(0, backtrack_bytes))
    candidates: list[CandidateDetail] = []

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
        if (
            payload_start <= marker_start
            and marker_end <= payload_end
            and (
                not require_complete_payload
                or payload_end <= len(data)
            )
        ):
            distance = marker_start - pos
            if distance <= backtrack_bytes:
                candidates.append(
                    (
                        field_number,
                        distance,
                        pos,
                        payload_start,
                        payload_end,
                    )
                )

    return sorted(candidates, key=lambda item: (item[1], item[0], item[2]))


def enclosing_length_delimited_candidates(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> list[tuple[int, int, int]]:
    """Return complete enclosing protobuf fields as (field, distance, tag_pos)."""

    return [
        (field, distance, tag_pos)
        for field, distance, tag_pos, _payload_start, _payload_end
        in _length_delimited_candidate_details(
            data,
            marker_start,
            marker_length,
            backtrack_bytes,
            require_complete_payload=True,
        )
    ]


def enclosing_length_delimited_fields(
    data: bytes | bytearray | memoryview,
    marker_start: int,
    marker_length: int,
    backtrack_bytes: int = DEFAULT_BACKTRACK_BYTES,
) -> list[tuple[int, int]]:
    """Return nearest complete occurrence of each plausible enclosing field."""

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


def _ancestor_chain_details(
    candidates: list[CandidateDetail],
    max_depth: int = MAX_ANCESTOR_DEPTH,
) -> tuple[CandidateDetail, ...]:
    """Return the nearest properly nested candidate chain, leaf first."""

    if not candidates or max_depth <= 0:
        return ()

    ordered = sorted(candidates, key=lambda item: (item[1], item[0], item[2]))
    current = ordered[0]
    chain = [current]

    while len(chain) < max_depth:
        outer = [
            candidate
            for candidate in ordered
            if (
                candidate[2] < current[2]
                and candidate[3] <= current[2]
                and candidate[4] >= current[4]
            )
        ]
        if not outer:
            break
        parent = min(outer, key=lambda item: (item[1], item[0], item[2]))
        chain.append(parent)
        current = parent

    return tuple(chain)


def _ancestor_chain(
    candidates: list[CandidateDetail],
    max_depth: int = MAX_ANCESTOR_DEPTH,
) -> tuple[int, ...]:
    """Return the nearest properly nested field-number chain, leaf first."""

    return tuple(
        candidate[0]
        for candidate in _ancestor_chain_details(candidates, max_depth)
    )


def _distance_stats(
    hits: Counter[int],
    totals: Counter[int],
    minimums: dict[int, int],
    maximums: dict[int, int],
    max_fields: int,
) -> dict[str, dict[str, int | float]]:
    rows = sorted(
        hits.items(),
        key=lambda item: (-item[1], minimums[item[0]], item[0]),
    )[:max_fields]
    return {
        str(field): {
            "hits": count,
            "min": minimums[field],
            "max": maximums[field],
            "avg": round(totals[field] / count, 2),
        }
        for field, count in rows
    }


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
        self._observations: list[tuple[str, list[CandidateDetail]]] = []

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
                    local_candidates = _length_delimited_candidate_details(
                        combined,
                        marker_pos,
                        len(marker),
                        self.backtrack_bytes,
                        require_complete_payload=False,
                    )
                    absolute_candidates = [
                        (
                            field,
                            distance,
                            absolute_base + tag_pos,
                            absolute_base + payload_start,
                            absolute_base + payload_end,
                        )
                        for (
                            field,
                            distance,
                            tag_pos,
                            payload_start,
                            payload_end,
                        ) in local_candidates
                    ]
                    self._observations.append(
                        (marker_name, absolute_candidates)
                    )

                search_from = marker_pos + 1

        self._bytes_seen += len(chunk)
        self._tail = combined[-self.tail_bytes :]

    def result(self, max_fields: int = 16) -> dict[str, object]:
        candidate_fields: Counter[int] = Counter()
        nearest_fields: Counter[int] = Counter()
        nearest_distance_total: Counter[int] = Counter()
        nearest_distance_min: dict[int, int] = {}
        nearest_distance_max: dict[int, int] = {}
        markers_without_candidate: Counter[str] = Counter()

        nearest_by_marker: dict[str, Counter[int]] = {}
        marker_distance_hits: dict[str, Counter[int]] = {}
        marker_distance_total: dict[str, Counter[int]] = {}
        marker_distance_min: dict[str, dict[int, int]] = {}
        marker_distance_max: dict[str, dict[int, int]] = {}
        ancestor_chains: dict[str, Counter[str]] = {}
        chain_observations: list[
            tuple[str, tuple[CandidateDetail, ...]]
        ] = []

        def record_distance(
            marker_name: str,
            field_number: int,
            distance: int,
        ) -> None:
            nearest_fields[field_number] += 1
            nearest_distance_total[field_number] += distance
            nearest_distance_min[field_number] = min(
                distance,
                nearest_distance_min.get(field_number, distance),
            )
            nearest_distance_max[field_number] = max(
                distance,
                nearest_distance_max.get(field_number, distance),
            )

            nearest_by_marker.setdefault(marker_name, Counter())[
                field_number
            ] += 1
            marker_distance_hits.setdefault(marker_name, Counter())[
                field_number
            ] += 1
            marker_distance_total.setdefault(marker_name, Counter())[
                field_number
            ] += distance

            marker_min = marker_distance_min.setdefault(marker_name, {})
            marker_max = marker_distance_max.setdefault(marker_name, {})
            marker_min[field_number] = min(
                distance,
                marker_min.get(field_number, distance),
            )
            marker_max[field_number] = max(
                distance,
                marker_max.get(field_number, distance),
            )

        for marker_name, observed_candidates in self._observations:
            valid = [
                candidate
                for candidate in observed_candidates
                if candidate[4] <= self._bytes_seen
            ]
            valid.sort(key=lambda item: (item[1], item[0], item[2]))

            nearest_per_field: dict[int, int] = {}
            for field_number, distance, *_rest in valid:
                if field_number not in nearest_per_field:
                    nearest_per_field[field_number] = distance
            fields = sorted(
                nearest_per_field.items(),
                key=lambda item: (item[1], item[0]),
            )
            for field_number, _distance in fields[:12]:
                candidate_fields[field_number] += 1

            if not fields:
                markers_without_candidate[marker_name] += 1
                continue

            field_number, distance = fields[0]
            record_distance(marker_name, field_number, distance)

            chain_details = _ancestor_chain_details(valid)
            if chain_details:
                chain_observations.append((marker_name, chain_details))
                chain_key = ">".join(
                    str(candidate[0])
                    for candidate in chain_details
                )
                ancestor_chains.setdefault(marker_name, Counter())[
                    chain_key
                ] += 1

        fields = sorted(
            candidate_fields.items(),
            key=lambda item: (-item[1], item[0]),
        )[:max_fields]
        nearest = sorted(
            nearest_fields.items(),
            key=lambda item: (-item[1], item[0]),
        )[:max_fields]

        nearest_by_marker_result = {
            marker: {
                str(field): count
                for field, count in sorted(
                    counts.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:max_fields]
            }
            for marker, counts in sorted(nearest_by_marker.items())
        }

        marker_distance_result: dict[
            str, dict[str, dict[str, int | float]]
        ] = {}
        for marker, hits in sorted(marker_distance_hits.items()):
            marker_distance_result[marker] = _distance_stats(
                hits,
                marker_distance_total[marker],
                marker_distance_min[marker],
                marker_distance_max[marker],
                max_fields,
            )

        ancestor_chain_result = {
            marker: {
                chain: count
                for chain, count in sorted(
                    chains.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:max_fields]
            }
            for marker, chains in sorted(ancestor_chains.items())
        }

        node_markers: dict[
            tuple[int, int, int, int],
            Counter[str],
        ] = {}
        node_depths: dict[
            tuple[int, int, int, int],
            dict[str, Counter[int]],
        ] = {}
        for marker_name, chain_details in chain_observations:
            for depth, candidate in enumerate(chain_details):
                field, _distance, tag_pos, payload_start, payload_end = (
                    candidate
                )
                node_id = (
                    field,
                    tag_pos,
                    payload_start,
                    payload_end,
                )
                node_markers.setdefault(node_id, Counter())[
                    marker_name
                ] += 1
                node_depths.setdefault(node_id, {}).setdefault(
                    marker_name,
                    Counter(),
                )[depth] += 1

        shared_fields: dict[int, dict[str, object]] = {}
        for node_id, marker_hits in node_markers.items():
            if len(marker_hits) < 2:
                continue

            field, _tag_pos, payload_start, payload_end = node_id
            payload_bytes = max(0, payload_end - payload_start)
            state = shared_fields.setdefault(
                field,
                {
                    "nodes": 0,
                    "marker_hits": Counter(),
                    "depths": {},
                    "payload_total": 0,
                    "payload_min": None,
                    "payload_max": None,
                },
            )
            state["nodes"] = int(state["nodes"]) + 1
            state["payload_total"] = int(
                state["payload_total"]
            ) + payload_bytes
            previous_min = state["payload_min"]
            previous_max = state["payload_max"]
            state["payload_min"] = (
                payload_bytes
                if previous_min is None
                else min(int(previous_min), payload_bytes)
            )
            state["payload_max"] = (
                payload_bytes
                if previous_max is None
                else max(int(previous_max), payload_bytes)
            )

            aggregate_hits = state["marker_hits"]
            assert isinstance(aggregate_hits, Counter)
            aggregate_hits.update(marker_hits)

            aggregate_depths = state["depths"]
            assert isinstance(aggregate_depths, dict)
            for marker_name, depths in node_depths[node_id].items():
                target_depths = aggregate_depths.setdefault(
                    marker_name,
                    Counter(),
                )
                target_depths.update(depths)

        shared_ancestor_candidates: dict[str, object] = {}
        for field, state in sorted(
            shared_fields.items(),
            key=lambda item: (
                -int(item[1]["nodes"]),
                item[0],
            ),
        )[:max_fields]:
            nodes = int(state["nodes"])
            marker_hits = state["marker_hits"]
            depths = state["depths"]
            assert isinstance(marker_hits, Counter)
            assert isinstance(depths, dict)
            shared_ancestor_candidates[str(field)] = {
                "nodes": nodes,
                "marker_hits": dict(sorted(marker_hits.items())),
                "depths": {
                    marker: {
                        str(depth): count
                        for depth, count in sorted(
                            marker_depths.items()
                        )
                    }
                    for marker, marker_depths in sorted(
                        depths.items()
                    )
                },
                "payload_bytes": {
                    "min": int(state["payload_min"] or 0),
                    "max": int(state["payload_max"] or 0),
                    "avg": round(
                        int(state["payload_total"]) / nodes,
                        2,
                    ),
                },
            }

        return {
            "body_bytes": self._bytes_seen,
            "markers": dict(sorted(self._marker_counts.items())),
            "markers_without_candidate": dict(
                sorted(markers_without_candidate.items())
            ),
            "candidate_fields": {
                str(field): count for field, count in fields
            },
            "nearest_candidate_fields": {
                str(field): count for field, count in nearest
            },
            "nearest_candidate_distance_bytes": _distance_stats(
                nearest_fields,
                nearest_distance_total,
                nearest_distance_min,
                nearest_distance_max,
                max_fields,
            ),
            "nearest_candidate_fields_by_marker": nearest_by_marker_result,
            "nearest_candidate_distance_bytes_by_marker": (
                marker_distance_result
            ),
            "ancestor_chains_by_marker": ancestor_chain_result,
            "shared_ancestor_candidates": shared_ancestor_candidates,
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
    assert (
        result["nearest_candidate_fields_by_marker"]["pagead"][str(target)]
        == 1
    )
    assert result["ancestor_chains_by_marker"]["pagead"][str(target)] == 1
    assert result["shared_ancestor_candidates"] == {}
    mutated, changes = denature_ad_fields(field, [target])
    assert changes == {target: 1}
    assert mutated != field and len(mutated) == len(field)
