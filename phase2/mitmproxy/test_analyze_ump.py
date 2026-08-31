import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[2] / "scripts" / "analyze-youtube-ump.py"
SPEC = importlib.util.spec_from_file_location("analyze_ump", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class AnalyzeUmpTest(unittest.TestCase):
    def test_latest_session_and_relative_timeline(self):
        lines = [
            '{"ts":"2026-01-01T00:00:00+00:00","event":"experiment_marker","session":"old","label":"session-start"}',
            '{"ts":"2026-01-02T00:00:00+00:00","event":"experiment_marker","session":"new","label":"session-start"}',
            '{"ts":"2026-01-02T00:00:01+00:00","event":"onesie_config","session":"new","parsed":true,"config_nodes":1,"configs":[{"client_key_present":true,"client_key_bytes":16}]}',
            '{"ts":"2026-01-02T00:00:02+00:00","event":"experiment_marker","session":"new","label":"ad-start"}',
            '{"ts":"2026-01-02T00:00:03+00:00","event":"ump_initplayback_response","session":"new","body_bytes":100,"chunks":2}',
        ]
        result = MODULE.analyze(lines)
        self.assertEqual(result["session"], "new")
        self.assertEqual(result["phases"]["ad-start"]["ump_bytes"], 100)
        self.assertEqual(result["timeline"][-1]["at_ms"], 3000)
        self.assertNotIn("secret", repr(result))


if __name__ == "__main__":
    unittest.main()
