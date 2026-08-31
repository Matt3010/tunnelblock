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
        state["weighted_total"] = float(state["weighted_total"] or 0.0) + (
            average * hits
        )
        current_min = state["min"]
        current_max = state["max"]
        state["min"] = minimum if current_min is None else min(int(current_min), minimum)
        state["max"] = maximum if current_max is None else max(int(current_max), maximum)


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
            "avg": round(float(state["weighted_total"] or 0.0) / hits, 2),
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
    protobuf_mutated_fields: Counter[str] = Counter()
    protobuf_responses_scanned = 0
    protobuf_responses_skipped = 0
    protobuf_bytes_scanned = 0
    protobuf_mutations = 0
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
            tls_failures[str(record.get("error_category", "unknown"))] += 1

        if event == "protobuf_response_scan":
            protobuf_responses_scanned += 1
            try:
                protobuf_bytes_scanned += int(record.get("body_bytes", 0))
            except (TypeError, ValueError):
                pass
            _counter_from_mapping(protobuf_markers, record.get("markers"))
            _counter_from_mapping(
                protobuf_markers_without_candidate,
                record.get("markers_without_candidate"),
            )
            _counter_from_mapping(
                protobuf_fields, record.get("candidate_fields")
            )
            _counter_from_mapping(
                protobuf_nearest_fields,
                record.get("nearest_candidate_fields"),
            )
            _merge_distance_stats(
                protobuf_nearest_distances,
                record.get("nearest_candidate_distance_bytes"),
            )
        elif event == "protobuf_response_scan_skipped":
            protobuf_responses_skipped += 1
        elif event == "protobuf_response_mutation":
            try:
                protobuf_mutations += int(record.get("mutation_count", 0))
            except (TypeError, ValueError):
                pass
            _counter_from_mapping(
                protobuf_mutated_fields, record.get("mutated_fields")
            )

    return {
        "classification": "protobuf_discovery_only",
        "blocking_observed": protobuf_mutations > 0,
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
            "marker_occurrences": dict(sorted(protobuf_markers.items())),
            "markers_without_candidate": dict(
                sorted(protobuf_markers_without_candidate.items())
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
            "nearest_candidate_distance_bytes": _finalize_distance_stats(
                protobuf_nearest_distances
            ),
            "mutations": protobuf_mutations,
            "mutated_field_hits": dict(
                sorted(
                    protobuf_mutated_fields.items(),
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
        print(f"Observation log not found: {path}", file=sys.stderr)
        return 1
    result = summarize(path.read_text(encoding="utf-8").splitlines())
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
