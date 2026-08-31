#!/usr/bin/env python3
"""Summarize minimized YouTube/mitmproxy metadata without exposing payloads."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


def _counter_from_mapping(counter: Counter[str], value: object) -> None:
    if not isinstance(value, dict):
        return
    for key, count in value.items():
        try:
            counter[str(key)] += int(count)
        except (TypeError, ValueError):
            continue


def _merge_nested_counters(
    aggregate: dict[str, Counter[str]],
    value: object,
) -> None:
    if not isinstance(value, dict):
        return
    for group, mapping in value.items():
        if not isinstance(mapping, dict):
            continue
        counter = aggregate.setdefault(str(group), Counter())
        _counter_from_mapping(counter, mapping)


def _finalize_nested_counters(
    aggregate: dict[str, Counter[str]],
) -> dict[str, dict[str, int]]:
    return {
        group: {
            key: count
            for key, count in sorted(
                counter.items(),
                key=lambda item: (-item[1], item[0]),
            )
        }
        for group, counter in sorted(aggregate.items())
    }


def _merge_distance_stats(
    aggregate: dict[str, dict[str, float | int | None]],
    value: object,
) -> None:
    if not isinstance(value, dict):
        return

    for field, raw_stats in value.items():
        if not isinstance(raw_stats, dict):
            continue
        try:
            hits = int(raw_stats.get("hits", 0))
            minimum = int(raw_stats.get("min"))
            maximum = int(raw_stats.get("max"))
            average = float(raw_stats.get("avg"))
        except (TypeError, ValueError):
            continue
        if hits <= 0:
            continue

        key = str(field)
        state = aggregate.setdefault(
            key,
            {
                "hits": 0,
                "weighted_total": 0.0,
                "min": None,
                "max": None,
            },
        )
        state["hits"] = int(state["hits"] or 0) + hits
        state["weighted_total"] = float(
            state["weighted_total"] or 0.0
        ) + (average * hits)
        current_min = state["min"]
        current_max = state["max"]
        state["min"] = (
            minimum
            if current_min is None
            else min(int(current_min), minimum)
        )
        state["max"] = (
            maximum
            if current_max is None
            else max(int(current_max), maximum)
        )


def _finalize_distance_stats(
    aggregate: dict[str, dict[str, float | int | None]],
) -> dict[str, dict[str, int | float]]:
    rows = sorted(
        aggregate.items(),
        key=lambda item: (-int(item[1]["hits"] or 0), item[0]),
    )
    result: dict[str, dict[str, int | float]] = {}
    for field, state in rows:
        hits = int(state["hits"] or 0)
        if hits <= 0:
            continue
        result[field] = {
            "hits": hits,
            "min": int(state["min"] or 0),
            "max": int(state["max"] or 0),
            "avg": round(
                float(state["weighted_total"] or 0.0) / hits,
                2,
            ),
        }
    return result


def _merge_nested_distance_stats(
    aggregate: dict[
        str, dict[str, dict[str, float | int | None]]
    ],
    value: object,
) -> None:
    if not isinstance(value, dict):
        return
    for marker, fields in value.items():
        if not isinstance(fields, dict):
            continue
        target = aggregate.setdefault(str(marker), {})
        _merge_distance_stats(target, fields)


def _finalize_nested_distance_stats(
    aggregate: dict[
        str, dict[str, dict[str, float | int | None]]
    ],
) -> dict[str, dict[str, dict[str, int | float]]]:
    return {
        marker: _finalize_distance_stats(fields)
        for marker, fields in sorted(aggregate.items())
    }


def _merge_shared_ancestor_candidates(
    aggregate: dict[str, dict[str, object]],
    value: object,
) -> None:
    if not isinstance(value, dict):
        return

    for raw_field, raw_state in value.items():
        if not isinstance(raw_state, dict):
            continue
        try:
            nodes = int(raw_state.get("nodes", 0))
        except (TypeError, ValueError):
            continue
        if nodes <= 0:
            continue

        field = str(raw_field)
        state = aggregate.setdefault(
            field,
            {
                "nodes": 0,
                "marker_hits": Counter(),
                "depths": {},
                "payload_total": 0.0,
                "payload_min": None,
                "payload_max": None,
            },
        )
        state["nodes"] = int(state["nodes"]) + nodes

        marker_hits = state["marker_hits"]
        assert isinstance(marker_hits, Counter)
        _counter_from_mapping(
            marker_hits,
            raw_state.get("marker_hits"),
        )

        raw_depths = raw_state.get("depths")
        depths = state["depths"]
        assert isinstance(depths, dict)
        if isinstance(raw_depths, dict):
            for marker, raw_counts in raw_depths.items():
                if not isinstance(raw_counts, dict):
                    continue
                target = depths.setdefault(str(marker), Counter())
                _counter_from_mapping(target, raw_counts)

        raw_payload = raw_state.get("payload_bytes")
        if isinstance(raw_payload, dict):
            try:
                minimum = int(raw_payload.get("min"))
                maximum = int(raw_payload.get("max"))
                average = float(raw_payload.get("avg"))
            except (TypeError, ValueError):
                continue
            state["payload_total"] = float(
                state["payload_total"]
            ) + (average * nodes)
            current_min = state["payload_min"]
            current_max = state["payload_max"]
            state["payload_min"] = (
                minimum
                if current_min is None
                else min(int(current_min), minimum)
            )
            state["payload_max"] = (
                maximum
                if current_max is None
                else max(int(current_max), maximum)
            )


def _finalize_shared_ancestor_candidates(
    aggregate: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    rows = sorted(
        aggregate.items(),
        key=lambda item: (-int(item[1]["nodes"]), item[0]),
    )
    result: dict[str, dict[str, object]] = {}
    for field, state in rows:
        nodes = int(state["nodes"])
        marker_hits = state["marker_hits"]
        depths = state["depths"]
        assert isinstance(marker_hits, Counter)
        assert isinstance(depths, dict)

        result[field] = {
            "nodes": nodes,
            "marker_hits": dict(sorted(marker_hits.items())),
            "depths": {
                marker: {
                    depth: count
                    for depth, count in sorted(
                        marker_depths.items(),
                        key=lambda item: int(item[0]),
                    )
                }
                for marker, marker_depths in sorted(depths.items())
            },
            "payload_bytes": {
                "min": int(state["payload_min"] or 0),
                "max": int(state["payload_max"] or 0),
                "avg": round(
                    float(state["payload_total"]) / nodes,
                    2,
                ),
            },
        }
    return result


def summarize(lines: list[str]) -> dict[str, object]:
    events: Counter[str] = Counter()
    transports: Counter[str] = Counter()
    http_versions: Counter[str] = Counter()
    tls_failures: Counter[str] = Counter()
    protobuf_markers: Counter[str] = Counter()
    protobuf_markers_without_candidate: Counter[str] = Counter()
    protobuf_fields: Counter[str] = Counter()
    protobuf_nearest_fields: Counter[str] = Counter()
    protobuf_nearest_distances: dict[
        str, dict[str, float | int | None]
    ] = {}
    protobuf_nearest_by_marker: dict[str, Counter[str]] = {}
    protobuf_marker_distances: dict[
        str, dict[str, dict[str, float | int | None]]
    ] = {}
    protobuf_ancestor_chains: dict[str, Counter[str]] = {}
    protobuf_shared_ancestors: dict[str, dict[str, object]] = {}
    protobuf_planned_fields: Counter[str] = Counter()
    protobuf_mutated_fields: Counter[str] = Counter()
    protobuf_neutralized_fields: Counter[str] = Counter()
    protobuf_mutation_rejections = 0
    protobuf_neutralization_rejections = 0
    protobuf_responses_scanned = 0
    protobuf_responses_skipped = 0
    protobuf_bytes_scanned = 0
    protobuf_mutations = 0
    protobuf_neutralizations = 0
    invalid_lines = 0

    for line in lines:
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            invalid_lines += 1
            continue
        if not isinstance(record, dict):
            invalid_lines += 1
            continue

        event = str(record.get("event", "unknown"))
        events[event] += 1
        if record.get("transport"):
            transports[str(record["transport"])] += 1
        if record.get("http_version"):
            http_versions[str(record["http_version"])] += 1
        if event.startswith("tls_failed"):
            tls_failures[
                str(record.get("error_category", "unknown"))
            ] += 1

        if event == "protobuf_response_scan":
            protobuf_responses_scanned += 1
            try:
                protobuf_bytes_scanned += int(
                    record.get("body_bytes", 0)
                )
            except (TypeError, ValueError):
                pass
            _counter_from_mapping(
                protobuf_markers,
                record.get("markers"),
            )
            _counter_from_mapping(
                protobuf_markers_without_candidate,
                record.get("markers_without_candidate"),
            )
            _counter_from_mapping(
                protobuf_fields,
                record.get("candidate_fields"),
            )
            _counter_from_mapping(
                protobuf_nearest_fields,
                record.get("nearest_candidate_fields"),
            )
            _merge_distance_stats(
                protobuf_nearest_distances,
                record.get("nearest_candidate_distance_bytes"),
            )
            _merge_nested_counters(
                protobuf_nearest_by_marker,
                record.get("nearest_candidate_fields_by_marker"),
            )
            _merge_nested_distance_stats(
                protobuf_marker_distances,
                record.get(
                    "nearest_candidate_distance_bytes_by_marker"
                ),
            )
            _merge_nested_counters(
                protobuf_ancestor_chains,
                record.get("ancestor_chains_by_marker"),
            )
            _merge_shared_ancestor_candidates(
                protobuf_shared_ancestors,
                record.get("shared_ancestor_candidates"),
            )
        elif event == "protobuf_response_scan_skipped":
            protobuf_responses_skipped += 1
        elif event == "protobuf_response_mutation":
            try:
                protobuf_mutations += int(
                    record.get("mutation_count", 0)
                )
            except (TypeError, ValueError):
                pass
            _counter_from_mapping(
                protobuf_planned_fields,
                record.get("planned_fields"),
            )
            _counter_from_mapping(
                protobuf_mutated_fields,
                record.get("mutated_fields"),
            )
        elif event == "protobuf_response_mutation_rejected":
            protobuf_mutation_rejections += 1
            _counter_from_mapping(
                protobuf_planned_fields,
                record.get("planned_fields"),
            )
        elif event == "protobuf_response_neutralization":
            try:
                protobuf_neutralizations += int(
                    record.get("neutralization_count", 0)
                )
            except (TypeError, ValueError):
                pass
            _counter_from_mapping(
                protobuf_planned_fields,
                record.get("planned_fields"),
            )
            _counter_from_mapping(
                protobuf_neutralized_fields,
                record.get("neutralized_fields"),
            )
        elif event == "protobuf_response_neutralization_rejected":
            protobuf_neutralization_rejections += 1
            _counter_from_mapping(
                protobuf_planned_fields,
                record.get("planned_fields"),
            )

    return {
        "classification": "protobuf_discovery_only",
        "blocking_observed": (
            protobuf_mutations > 0 or protobuf_neutralizations > 0
        ),
        "records": sum(events.values()),
        "invalid_lines": invalid_lines,
        "events": dict(sorted(events.items())),
        "http_versions": dict(sorted(http_versions.items())),
        "tls_transports": dict(sorted(transports.items())),
        "tls_failures": dict(sorted(tls_failures.items())),
        "protobuf": {
            "responses_scanned": protobuf_responses_scanned,
            "responses_skipped": protobuf_responses_skipped,
            "bytes_scanned": protobuf_bytes_scanned,
            "marker_occurrences": dict(
                sorted(protobuf_markers.items())
            ),
            "markers_without_candidate": dict(
                sorted(
                    protobuf_markers_without_candidate.items()
                )
            ),
            "candidate_field_hits": dict(
                sorted(
                    protobuf_fields.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ),
            "nearest_candidate_field_hits": dict(
                sorted(
                    protobuf_nearest_fields.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ),
            "nearest_candidate_distance_bytes": (
                _finalize_distance_stats(
                    protobuf_nearest_distances
                )
            ),
            "nearest_candidate_fields_by_marker": (
                _finalize_nested_counters(
                    protobuf_nearest_by_marker
                )
            ),
            "nearest_candidate_distance_bytes_by_marker": (
                _finalize_nested_distance_stats(
                    protobuf_marker_distances
                )
            ),
            "ancestor_chains_by_marker": (
                _finalize_nested_counters(
                    protobuf_ancestor_chains
                )
            ),
            "shared_ancestor_candidates": (
                _finalize_shared_ancestor_candidates(
                    protobuf_shared_ancestors
                )
            ),
            "mutations": protobuf_mutations,
            "mutation_rejections": protobuf_mutation_rejections,
            "neutralizations": protobuf_neutralizations,
            "neutralization_rejections": (
                protobuf_neutralization_rejections
            ),
            "planned_field_hits": dict(
                sorted(
                    protobuf_planned_fields.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ),
            "mutated_field_hits": dict(
                sorted(
                    protobuf_mutated_fields.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ),
            "neutralized_field_hits": dict(
                sorted(
                    protobuf_neutralized_fields.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "log",
        nargs="?",
        default="data/mitmproxy/observations/metadata.jsonl",
        help="metadata JSONL path",
    )
    args = parser.parse_args()
    path = Path(args.log)
    if not path.is_file():
        print(
            f"Observation log not found: {path}",
            file=sys.stderr,
        )
        return 1
    result = summarize(
        path.read_text(encoding="utf-8").splitlines()
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
