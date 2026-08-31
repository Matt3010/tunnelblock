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


def _merge_nearest_fields(
    hits: Counter[str],
    distance_sum: Counter[str],
    min_distance: dict[str, int],
    max_distance: dict[str, int],
    value: object,
) -> None:
    if not isinstance(value, dict):
        return

    for raw_field, raw_stats in value.items():
        if not isinstance(raw_stats, dict):
            continue
        field = str(raw_field)
        try:
            field_hits = int(raw_stats.get("hits", 0))
            field_min = int(raw_stats.get("min_distance", 0))
            field_max = int(raw_stats.get("max_distance", 0))
            field_avg = float(raw_stats.get("avg_distance", 0))
        except (TypeError, ValueError):
            continue
        if field_hits <= 0:
            continue

        hits[field] += field_hits
        distance_sum[field] += field_avg * field_hits
        min_distance[field] = min(
            field_min, min_distance.get(field, field_min)
        )
        max_distance[field] = max(
            field_max, max_distance.get(field, field_max)
        )


def summarize(lines: list[str]) -> dict[str, object]:
    events: Counter[str] = Counter()
    transports: Counter[str] = Counter()
    http_versions: Counter[str] = Counter()
    tls_failures: Counter[str] = Counter()
    protobuf_markers: Counter[str] = Counter()
    protobuf_nearest_hits: Counter[str] = Counter()
    protobuf_nearest_distance_sum: Counter[str] = Counter()
    protobuf_nearest_min_distance: dict[str, int] = {}
    protobuf_nearest_max_distance: dict[str, int] = {}
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
            _merge_nearest_fields(
                protobuf_nearest_hits,
                protobuf_nearest_distance_sum,
                protobuf_nearest_min_distance,
                protobuf_nearest_max_distance,
                record.get("nearest_fields"),
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

    nearest_stats = {}
    for field, field_hits in sorted(
        protobuf_nearest_hits.items(),
        key=lambda item: (
            -item[1],
            protobuf_nearest_min_distance[item[0]],
            item[0],
        ),
    ):
        nearest_stats[field] = {
            "hits": field_hits,
            "min_distance": protobuf_nearest_min_distance[field],
            "max_distance": protobuf_nearest_max_distance[field],
            "avg_distance": round(
                protobuf_nearest_distance_sum[field] / field_hits, 2
            ),
        }

    return {
        "classification": "protobuf_nearest_field_discovery",
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
            "nearest_field_stats": nearest_stats,
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
