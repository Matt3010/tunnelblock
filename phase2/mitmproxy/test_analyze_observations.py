import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "analyze-youtube-observations.py"
SPEC = importlib.util.spec_from_file_location("youtube_observations", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ObservationAnalysisTest(unittest.TestCase):
    def test_protobuf_discovery_is_aggregated_without_hosts_or_paths(self):
        result = MODULE.summarize(
            [
                '{"event":"http_request","host":"www.youtube.com","path":"/pagead/adview","http_version":"HTTP/2.0"}',
                '{"event":"protobuf_response_scan","host":"youtubei.googleapis.com","path":"/youtubei/v1/browse","body_bytes":1800000,"markers":{"pagead":2},"candidate_fields":{"50195462":2,"49399797":1}}',
                '{"event":"tls_failed_client","sni":"private.example","error_category":"certificate_rejected","transport":"tcp"}',
            ]
        )
        self.assertEqual(result["protobuf"]["responses_scanned"], 1)
        self.assertEqual(result["protobuf"]["bytes_scanned"], 1800000)
        self.assertEqual(
            result["protobuf"]["marker_occurrences"]["pagead"], 2
        )
        self.assertEqual(
            result["protobuf"]["candidate_field_hits"]["50195462"], 2
        )
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
