import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "analyze-youtube-observations.py"
SPEC = importlib.util.spec_from_file_location("youtube_observations", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ObservationAnalysisTest(unittest.TestCase):
    def test_candidate_categories_are_aggregated_without_paths_or_hosts(self):
        result = MODULE.summarize(
            [
                '{"event":"http_request","host":"www.youtube.com","path":"/pagead/adview","http_version":"HTTP/2.0"}',
                '{"event":"http_request","host":"rr.googlevideo.com","path":"/videoplayback","http_version":"HTTP/1.1"}',
                '{"event":"tls_failed_client","sni":"private.example","error_category":"certificate_rejected","transport":"tcp"}',
            ]
        )
        self.assertEqual(result["request_categories"]["ad_related_candidate"], 1)
        self.assertEqual(result["request_categories"]["playback_related"], 1)
        self.assertEqual(result["tls_failures"]["certificate_rejected"], 1)
        self.assertNotIn("host", result)
        self.assertNotIn("path", result)
        self.assertFalse(result["blocking_enabled"])

    def test_invalid_json_is_counted(self):
        result = MODULE.summarize(["not-json", "[]"])
        self.assertEqual(result["invalid_lines"], 2)
        self.assertEqual(result["records"], 0)


if __name__ == "__main__":
    unittest.main()
