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
                '{"event":"protobuf_response_scan","host":"youtubei.googleapis.com","path":"/youtubei/v1/next","body_bytes":1800000,"markers":{"pagead":2,"googleadservices":2},"markers_without_candidate":{},"candidate_fields":{"14":2,"7":2,"2":4},"nearest_candidate_fields":{"14":2,"7":2},"nearest_candidate_distance_bytes":{"14":{"hits":2,"min":10,"max":10,"avg":10.0},"7":{"hits":2,"min":7,"max":7,"avg":7.0}},"nearest_candidate_fields_by_marker":{"pagead":{"14":2},"googleadservices":{"7":2}},"nearest_candidate_distance_bytes_by_marker":{"pagead":{"14":{"hits":2,"min":10,"max":10,"avg":10.0}},"googleadservices":{"7":{"hits":2,"min":7,"max":7,"avg":7.0}}},"ancestor_chains_by_marker":{"pagead":{"14>2>100":2},"googleadservices":{"7>3>100":2}},"shared_ancestor_candidates":{"100":{"nodes":2,"marker_hits":{"pagead":2,"googleadservices":2},"depths":{"pagead":{"2":2},"googleadservices":{"2":2}},"payload_bytes":{"min":120,"max":180,"avg":150.0}}}}',
                '{"event":"protobuf_response_scan","host":"youtubei.googleapis.com","path":"/youtubei/v1/player","body_bytes":1000,"markers":{"pagead":1},"markers_without_candidate":{"pagead":1},"candidate_fields":{},"nearest_candidate_fields":{},"nearest_candidate_distance_bytes":{},"nearest_candidate_fields_by_marker":{},"nearest_candidate_distance_bytes_by_marker":{},"ancestor_chains_by_marker":{}}',
                '{"event":"tls_failed_client","sni":"private.example","error_category":"certificate_rejected","transport":"tcp"}',
            ]
        )
        self.assertEqual(result["protobuf"]["responses_scanned"], 2)
        self.assertEqual(result["protobuf"]["bytes_scanned"], 1801000)
        self.assertEqual(
            result["protobuf"]["marker_occurrences"]["pagead"],
            3,
        )
        self.assertEqual(
            result["protobuf"]["markers_without_candidate"]["pagead"],
            1,
        )
        self.assertEqual(
            result["protobuf"]["nearest_candidate_fields_by_marker"][
                "pagead"
            ],
            {"14": 2},
        )
        self.assertEqual(
            result["protobuf"]["nearest_candidate_fields_by_marker"][
                "googleadservices"
            ],
            {"7": 2},
        )
        self.assertEqual(
            result["protobuf"]["ancestor_chains_by_marker"]["pagead"],
            {"14>2>100": 2},
        )
        self.assertEqual(
            result["protobuf"]["ancestor_chains_by_marker"][
                "googleadservices"
            ],
            {"7>3>100": 2},
        )
        stats = result["protobuf"][
            "nearest_candidate_distance_bytes_by_marker"
        ]["pagead"]["14"]
        self.assertEqual(stats["hits"], 2)
        self.assertEqual(stats["min"], 10)
        self.assertEqual(stats["max"], 10)
        self.assertEqual(stats["avg"], 10.0)
        shared = result["protobuf"]["shared_ancestor_candidates"]["100"]
        self.assertEqual(shared["nodes"], 2)
        self.assertEqual(
            shared["marker_hits"],
            {"googleadservices": 2, "pagead": 2},
        )
        self.assertEqual(
            shared["depths"]["pagead"],
            {"2": 2},
        )
        self.assertEqual(shared["payload_bytes"]["avg"], 150.0)
        self.assertEqual(
            result["tls_failures"]["certificate_rejected"],
            1,
        )
        self.assertNotIn("host", result)
        self.assertNotIn("path", result)
        self.assertFalse(result["blocking_observed"])

    def test_marker_specific_distance_stats_merge_weighted_averages(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_scan","body_bytes":1,"nearest_candidate_distance_bytes_by_marker":{"pagead":{"14":{"hits":2,"min":8,"max":12,"avg":10.0}}}}',
                '{"event":"protobuf_response_scan","body_bytes":1,"nearest_candidate_distance_bytes_by_marker":{"pagead":{"14":{"hits":1,"min":16,"max":16,"avg":16.0}}}}',
            ]
        )
        stats = result["protobuf"][
            "nearest_candidate_distance_bytes_by_marker"
        ]["pagead"]["14"]
        self.assertEqual(stats["hits"], 3)
        self.assertEqual(stats["min"], 8)
        self.assertEqual(stats["max"], 16)
        self.assertEqual(stats["avg"], 12.0)

    def test_shared_ancestor_candidates_merge_across_responses(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_scan","body_bytes":1,"shared_ancestor_candidates":{"14":{"nodes":2,"marker_hits":{"pagead":2,"googleadservices":2},"depths":{"pagead":{"1":2},"googleadservices":{"1":2}},"payload_bytes":{"min":100,"max":120,"avg":110.0}}}}',
                '{"event":"protobuf_response_scan","body_bytes":1,"shared_ancestor_candidates":{"14":{"nodes":1,"marker_hits":{"pagead":1,"googleadservices":1},"depths":{"pagead":{"1":1},"googleadservices":{"1":1}},"payload_bytes":{"min":140,"max":140,"avg":140.0}}}}',
            ]
        )
        shared = result["protobuf"]["shared_ancestor_candidates"]["14"]
        self.assertEqual(shared["nodes"], 3)
        self.assertEqual(
            shared["marker_hits"],
            {"googleadservices": 3, "pagead": 3},
        )
        self.assertEqual(
            shared["depths"]["googleadservices"],
            {"1": 3},
        )
        self.assertEqual(shared["payload_bytes"]["min"], 100)
        self.assertEqual(shared["payload_bytes"]["max"], 140)
        self.assertEqual(shared["payload_bytes"]["avg"], 120.0)

    def test_mutations_are_reported_explicitly(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_mutation","mutation_count":2,"planned_fields":{"50195462":2},"mutated_fields":{"50195462":2}}'
            ]
        )
        self.assertTrue(result["blocking_observed"])
        self.assertEqual(result["protobuf"]["mutations"], 2)
        self.assertEqual(
            result["protobuf"]["planned_field_hits"]["50195462"],
            2,
        )
        self.assertEqual(
            result["protobuf"]["mutated_field_hits"]["50195462"],
            2,
        )
        self.assertEqual(
            result["protobuf"]["mutation_rejections"],
            0,
        )

    def test_mutation_plan_rejection_is_reported(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_mutation_rejected","reason":"planned_mutated_mismatch","planned_fields":{"14":6},"mutated_fields":{"14":5}}'
            ]
        )
        self.assertEqual(
            result["protobuf"]["mutation_rejections"],
            1,
        )
        self.assertEqual(
            result["protobuf"]["planned_field_hits"]["14"],
            6,
        )
        self.assertEqual(
            result["protobuf"]["mutations"],
            0,
        )
        self.assertFalse(result["blocking_observed"])

    def test_neutralization_is_reported_as_blocking(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_neutralization","neutralization_count":3,"planned_fields":{"14":3},"neutralized_fields":{"14":3}}'
            ]
        )
        self.assertTrue(result["blocking_observed"])
        self.assertEqual(result["protobuf"]["neutralizations"], 3)
        self.assertEqual(
            result["protobuf"]["neutralized_field_hits"]["14"],
            3,
        )
        self.assertEqual(
            result["protobuf"]["planned_field_hits"]["14"],
            3,
        )
        self.assertEqual(
            result["protobuf"]["neutralization_rejections"],
            0,
        )

    def test_neutralization_rejection_is_reported(self):
        result = MODULE.summarize(
            [
                '{"event":"protobuf_response_neutralization_rejected","reason":"planned_neutralized_mismatch","planned_fields":{"14":4},"neutralized_fields":{"14":3}}'
            ]
        )
        self.assertFalse(result["blocking_observed"])
        self.assertEqual(
            result["protobuf"]["neutralization_rejections"],
            1,
        )
        self.assertEqual(
            result["protobuf"]["planned_field_hits"]["14"],
            4,
        )
        self.assertEqual(result["protobuf"]["neutralizations"], 0)

    def test_invalid_json_is_counted(self):
        result = MODULE.summarize(["not-json", "[]"])
        self.assertEqual(result["invalid_lines"], 2)
        self.assertEqual(result["records"], 0)


if __name__ == "__main__":
    unittest.main()
