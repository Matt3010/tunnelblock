#!/usr/bin/env python3
"""Summarize minimized mitmproxy metadata without inspecting payloads."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


AD_PATH_PREFIXES = (
    "/api/stats/ads",
    "/pagead/",
    "/pcs/activeview",
    "/ptracking",
    "/youtubei/v1/player/ad_break",
)
PLAYBACK_PATH_PREFIXES = (
    "/initplayback",
    "/videogoodput",
    "/videoplayback",
    "/youtubei/v1/player",
)


def classify(record: dict[str, object]) -> str | None:
    if record.get("event") != "http_request":
        return None
    path = str(record.get("path", ""))
    if path.startswith(AD_PATH_PREFIXES):
        return "ad_related_candidate"
    if path.startswith(PLAYBACK_PATH_PREFIXES):
        return "playback_related"
    return "other_observed"


def summarize(lines: list[str]) -> dict[str, object]:
    events: Counter[str] = Counter()
    candidates: Counter[str] = Counter()
    transports: Counter[str] = Counter()
    http_versions: Counter[str] = Counter()
    tls_failures: Counter[str] = Counter()
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
        category = classify(record)
        if category:
            candidates[category] += 1
        if record.get("transport"):
            transports[str(record["transport"])] += 1
        if record.get("http_version"):
            http_versions[str(record["http_version"])] += 1
        if event.startswith("tls_failed"):
            tls_failures[str(record.get("error_category", "unknown"))] += 1

    return {
        "classification": "candidate_signals_only",
        "blocking_enabled": False,
        "records": sum(events.values()),
        "invalid_lines": invalid_lines,
        "events": dict(sorted(events.items())),
        "request_categories": dict(sorted(candidates.items())),
        "http_versions": dict(sorted(http_versions.items())),
        "tls_transports": dict(sorted(transports.items())),
        "tls_failures": dict(sorted(tls_failures.items())),
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
