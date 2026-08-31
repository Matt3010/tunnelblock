import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "analyze-youtube-decisions.py"
SPEC = importlib.util.spec_from_file_location("decision_analysis", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class DecisionAnalysisTest(unittest.TestCase):
    def test_latest_session_is_grouped_by_manual_phase(self):
        result = MODULE.analyze([
            '{"ts":"2026-01-01T00:00:00+00:00","event":"experiment_marker","session":"old","label":"session-start"}',
            '{"ts":"2026-01-02T00:00:00+00:00","event":"experiment_marker","session":"new","label":"session-start"}',
            '{"ts":"2026-01-02T00:00:01+00:00","event":"experiment_marker","session":"new","label":"ad-video-selected"}',
            '{"ts":"2026-01-02T00:00:02+00:00","event":"protobuf_decision_fingerprint","session":"new","path":"/youtubei/v1/player","body_bytes":42,"fingerprint":{"parsed":true,"root_fingerprint":"abc","nested_paths":{"1>2":2},"subtree_fingerprints":{"def":1},"path_fingerprints":{"1>2#def":1}}}',
            '{"ts":"2026-01-02T00:00:03+00:00","event":"experiment_marker","session":"new","label":"ad-start"}',
            '{"ts":"2026-01-02T00:00:04+00:00","event":"experiment_marker","session":"new","label":"control-video-selected"}',
            '{"ts":"2026-01-02T00:00:05+00:00","event":"protobuf_decision_fingerprint","session":"new","path":"/youtubei/v1/player","body_bytes":40,"fingerprint":{"parsed":true,"root_fingerprint":"xyz","nested_paths":{},"subtree_fingerprints":{},"path_fingerprints":{}}}',
        ])
        self.assertEqual(result["session"], "new")
        phase = result["phases"]["ad-video-selected"]
        self.assertEqual(phase["responses"], 1)
        self.assertEqual(phase["paths"], {"/youtubei/v1/player": 1})
        self.assertEqual(phase["nested_paths"], {"1>2": 2})
        self.assertEqual(result["timeline"][2]["at_ms"], 2000)
        self.assertEqual(
            result["ad_control_differences"]["ad_only_path_fingerprints"],
            {"1>2#def": 1},
        )


if __name__ == "__main__":
    unittest.main()
