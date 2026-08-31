#!/usr/bin/env python3
"""Compare minimized protobuf structures within the latest labeled session."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


def _timestamp(value: object) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def analyze(lines: list[str]) -> dict[str, object]:
    records = []
    for line in lines:
        try:
            record = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(record, dict) and record.get("session"):
            records.append(record)

    starts = [
        row for row in records
        if row.get("event") == "experiment_marker"
        and row.get("label") == "session-start"
    ]
    if not starts:
        return {"error": "no_labeled_session"}
    session = str(starts[-1]["session"])
    rows = [row for row in records if str(row.get("session")) == session]
    rows.sort(key=lambda row: str(row.get("ts", "")))
    origin = _timestamp(starts[-1].get("ts"))
    phase = "before-video"
    phases: dict[str, dict[str, Counter[str] | int]] = {}
    timeline = []

    for row in rows:
        stamp = _timestamp(row.get("ts"))
        relative_ms = (
            round((stamp - origin).total_seconds() * 1000)
            if stamp is not None and origin is not None
            else None
        )
        if row.get("event") == "experiment_marker":
            phase = str(row.get("label", "unknown"))
            timeline.append({"at_ms": relative_ms, "marker": phase})
            continue
        if row.get("event") != "protobuf_decision_fingerprint":
            continue
        fingerprint = row.get("fingerprint")
        if not isinstance(fingerprint, dict):
            continue
        path = str(row.get("path", "unknown"))
        state = phases.setdefault(
            phase,
            {
                "responses": 0,
                "paths": Counter(),
                "root_fingerprints": Counter(),
                "nested_paths": Counter(),
                "subtree_fingerprints": Counter(),
                "path_fingerprints": Counter(),
                "scalar_buckets": Counter(),
            },
        )
        state["responses"] = int(state["responses"]) + 1
        for key, source in (
            ("paths", {path: 1}),
            ("root_fingerprints", {str(fingerprint.get("root_fingerprint", "unparsed")): 1}),
            ("nested_paths", fingerprint.get("nested_paths", {})),
            ("subtree_fingerprints", fingerprint.get("subtree_fingerprints", {})),
            ("path_fingerprints", fingerprint.get("path_fingerprints", {})),
            ("scalar_buckets", fingerprint.get("scalar_buckets", {})),
        ):
            target = state[key]
            assert isinstance(target, Counter)
            if isinstance(source, dict):
                for name, count in source.items():
                    try:
                        target[str(name)] += int(count)
                    except (TypeError, ValueError):
                        pass
        timeline.append(
            {
                "at_ms": relative_ms,
                "phase": phase,
                "path": path,
                "body_bytes": row.get("body_bytes"),
                "root_fingerprint": fingerprint.get("root_fingerprint"),
                "parsed": fingerprint.get("parsed", False),
            }
        )

    finalized = {}
    for name, state in phases.items():
        finalized[name] = {
            key: (
                dict(value.most_common())
                if isinstance(value, Counter) else value
            )
            for key, value in state.items()
        }

    comparisons = {}
    ad = phases.get("ad-video-selected")
    control = phases.get("control-video-selected")
    if ad is not None and control is not None:
        for key in ("path_fingerprints", "scalar_buckets"):
            ad_values = ad[key]
            control_values = control[key]
            assert isinstance(ad_values, Counter)
            assert isinstance(control_values, Counter)
            comparisons[f"ad_only_{key}"] = dict(
                (ad_values - control_values).most_common()
            )
            comparisons[f"control_only_{key}"] = dict(
                (control_values - ad_values).most_common()
            )
    return {
        "session": session,
        "phases": finalized,
        "ad_control_differences": comparisons,
        "timeline": timeline,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "log", nargs="?",
        default="data/mitmproxy/observations/metadata.jsonl",
    )
    args = parser.parse_args()
    path = Path(args.log)
    if not path.is_file():
        print(f"Observation log not found: {path}", file=sys.stderr)
        return 1
    print(json.dumps(analyze(path.read_text(encoding="utf-8").splitlines()), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
