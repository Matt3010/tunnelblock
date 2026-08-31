#!/usr/bin/env python3
"""Summarize the latest labeled Onesie/UMP session without payload data."""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


def _time(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def analyze(lines):
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(row, dict) and row.get("session"):
            rows.append(row)
    starts = [r for r in rows if r.get("event") == "experiment_marker" and r.get("label") == "session-start"]
    if not starts:
        return {"error": "no_labeled_session"}
    session = str(starts[-1]["session"])
    rows = sorted((r for r in rows if str(r.get("session")) == session), key=lambda r: str(r.get("ts", "")))
    origin = _time(starts[-1].get("ts"))
    phase = "before-video"
    phases = {}
    timeline = []
    for row in rows:
        stamp = _time(row.get("ts"))
        at_ms = round((stamp - origin).total_seconds() * 1000) if stamp and origin else None
        event = str(row.get("event", ""))
        if event == "experiment_marker":
            phase = str(row.get("label", "unknown"))
            timeline.append({"at_ms": at_ms, "marker": phase})
            continue
        if event not in {"onesie_config", "ump_initplayback_request", "ump_initplayback_response"}:
            continue
        state = phases.setdefault(phase, {"events": Counter(), "ump_bytes": 0, "ump_chunks": 0})
        state["events"][event] += 1
        if event == "ump_initplayback_response":
            state["ump_bytes"] += int(row.get("body_bytes", 0) or 0)
            state["ump_chunks"] += int(row.get("chunks", 0) or 0)
        item = {"at_ms": at_ms, "phase": phase, "event": event}
        for key in ("status_code", "body_bytes", "chunks", "content_type", "query_parameter_count", "parsed", "config_nodes", "configs"):
            if key in row:
                item[key] = row[key]
        timeline.append(item)
    return {"session": session, "phases": {name: {**state, "events": dict(state["events"])} for name, state in phases.items()}, "timeline": timeline}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", default="data/mitmproxy/observations/metadata.jsonl")
    args = parser.parse_args()
    path = Path(args.log)
    if not path.is_file():
        print(f"Observation log not found: {path}", file=sys.stderr)
        return 1
    print(json.dumps(analyze(path.read_text(encoding="utf-8").splitlines()), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
