import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "analyze-youtube-observations.py"
SPEC = importlib.util.spec_from_file_location("youtube_observations", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ObservationAnalysisTest(unittest.TestCase):
    def test_nearest_field_discovery_is_aggregated_without_hosts_or_paths(self):
        result = MODULE.summarize(
            [
                '{"event":"http_request","host":"www.youtube.com","path":"/pagead/adview","http_version":"HTTP/2.0"}',
                '{"event":"protobuf_response_scan","host":"youtubei.googleapis.com","path":"/youtubei/v1/browse","body_bytes":1800000,"markers":{"pagead":2},"nearest_fields":{"50195462":{"hits":2,"min_distance":11,"max_distance":17,"avg_distance":14.0}}}',
                '{"event":"protobuf_response_scan","host":"youtubei.googleapis.com","path":"/youtubei/v1/player","body_bytes":200000,"markers":{"pagead":1},"nearest_fields":{"50195462":{"hits":1,"min_distance":9,"max_distance":9,"avg_distance":9.0}}}',
                '{"event":"tls_failed_client","sni":"private.example","error_category":"certificate_rejected","transport":"tcp"}',
            ]
        )
        self.assertEqual(result["protobuf"]["responses_scanned"], 2)
        self.assertEqual(result["protobuf"]["bytes_scanned"], 2000000)
        self.assertEqual(
            result["protobuf"]["marker_occurrences"]["pagead"], 3
        )
        stats = result["protobuf"]["nearest_field_stats"]["50195462"]
        self.assertEqual(stats["hits"], 3)
        self.assertEqual(stats["min_distance"], 9)
        self.assertEqual(stats["max_distance"], 17)
        self.assertEqual(stats["avg_distance"], 12.33)
        self.assertEqual(
            result["tls_failures"]["certificate_rejected"], 1
        )
        self.assertNotIn("host", result)
        self.assertNotIn("path", result)
        self.assertFalse(result["blocking_observed"])

    def test_mutations_are_reported_explicitly(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_mutation","mutation_count":2,"mutated_fields":{"50195462":2}}'
            ]
        )
        self.assertTrue(result["blocking_observed"])
        self.assertEqual(result["protobuf"]["mutations"], 2)
        self.assertEqual(
            result["protobuf"]["mutated_field_hits"]["50195462"], 2
        )

    def test_invalid_json_is_counted(self):
        result = MODULE.summarize(["not-json", "[]"])
        self.assertEqual(result["invalid_lines"], 2)
        self.assertEqual(result["records"], 0)


if __name__ == "__main__":
    unittest.main()
