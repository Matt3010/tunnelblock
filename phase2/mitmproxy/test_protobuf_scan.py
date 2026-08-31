import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("protobuf_scan.py")
SPEC = importlib.util.spec_from_file_location("protobuf_scan", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ProtobufScanTest(unittest.TestCase):
    def _field(self, number: int, payload: bytes) -> bytes:
        return (
            MODULE.tag_bytes(number)
            + MODULE.encode_varint(len(payload))
            + payload
        )

    def test_stream_scan_finds_marker_and_nearest_field_across_chunks(self):
        target = 50195462
        body = self._field(target, b"abc/pagead/def")
        split = body.index(b"/pagead/") + 3
        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body[:split])
        scanner.feed(body[split:])

        result = scanner.result()
        self.assertEqual(result["body_bytes"], len(body))
        self.assertEqual(result["markers"]["pagead"], 1)
        self.assertEqual(result["candidate_fields"][str(target)], 1)
        self.assertEqual(
            result["nearest_candidate_fields"][str(target)],
            1,
        )
        self.assertEqual(
            result["nearest_candidate_fields_by_marker"]["pagead"][
                str(target)
            ],
            1,
        )
        stats = result["nearest_candidate_distance_bytes"][str(target)]
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["min"], stats["max"])
        self.assertGreater(stats["avg"], 0)

    def test_marker_specific_fields_and_ancestor_chains_are_separated(self):
        page_leaf = self._field(14, b"xx/pagead/yy")
        google_leaf = self._field(
            7,
            b"aa-googleadservices.com-bb",
        )
        page_branch = self._field(2, page_leaf)
        google_branch = self._field(3, google_leaf)
        body = self._field(100, page_branch + google_branch)

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        marker_split = body.index(b"/pagead/") + 4
        scanner.feed(body[:marker_split])
        scanner.feed(body[marker_split:])
        result = scanner.result()

        self.assertEqual(
            result["nearest_candidate_fields_by_marker"]["pagead"],
            {"14": 1},
        )
        self.assertEqual(
            result["nearest_candidate_fields_by_marker"][
                "googleadservices"
            ],
            {"7": 1},
        )
        self.assertEqual(
            result["ancestor_chains_by_marker"]["pagead"],
            {"14>2>100": 1},
        )
        self.assertEqual(
            result["ancestor_chains_by_marker"]["googleadservices"],
            {"7>3>100": 1},
        )

    def test_shared_ancestor_candidates_use_physical_nodes(self):
        page_leaf = self._field(14, b"x/pagead/y")
        google_leaf = self._field(
            7,
            b"xgoogleadservices.comy",
        )
        shared_payload = page_leaf + google_leaf
        shared_parent = self._field(14, shared_payload)
        body = self._field(214, shared_parent + b"tail")

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        split = body.index(b"/pagead/") + 4
        scanner.feed(body[:split])
        scanner.feed(body[split:])
        result = scanner.result()

        shared = result["shared_ancestor_candidates"]
        self.assertEqual(shared["14"]["nodes"], 1)
        self.assertEqual(
            shared["14"]["marker_hits"],
            {"googleadservices": 1, "pagead": 1},
        )
        self.assertEqual(
            shared["14"]["depths"]["pagead"],
            {"1": 1},
        )
        self.assertEqual(
            shared["14"]["depths"]["googleadservices"],
            {"1": 1},
        )
        self.assertEqual(
            shared["14"]["payload_bytes"]["avg"],
            len(shared_payload),
        )
        self.assertEqual(shared["214"]["nodes"], 1)
        self.assertEqual(
            shared["214"]["depths"]["pagead"],
            {"2": 1},
        )
        self.assertEqual(
            shared["214"]["depths"]["googleadservices"],
            {"2": 1},
        )

    def test_streaming_parent_can_finish_after_marker_chunk(self):
        leaf = self._field(14, b"xx/pagead/yy")
        padding = b"z" * 256
        body = self._field(100, leaf + padding)
        marker_end = body.index(b"/pagead/") + len(b"/pagead/")

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body[:marker_end])
        scanner.feed(body[marker_end:])
        result = scanner.result()

        self.assertEqual(
            result["ancestor_chains_by_marker"]["pagead"],
            {"14>100": 1},
        )

    def test_nearest_field_prefers_inner_enclosing_message(self):
        outer = 12
        inner = 50195462
        nested = self._field(inner, b"abc/pagead/def")
        body = self._field(outer, nested)

        marker_pos = body.index(b"/pagead/")
        fields = MODULE.enclosing_length_delimited_fields(
            body,
            marker_pos,
            len(b"/pagead/"),
            1024,
        )

        self.assertEqual(fields[0][0], inner)
        self.assertIn((outer, marker_pos), fields)

    def test_truncated_random_candidate_is_rejected(self):
        target = 50195462
        body = self._field(
            target,
            b"prefix-/pagead/-suffix",
        )
        marker_pos = body.index(b"/pagead/")

        fields = MODULE.enclosing_length_delimited_fields(
            body,
            marker_pos,
            len(b"/pagead/"),
            1024,
        )

        self.assertEqual(fields[0][0], target)
        self.assertNotIn(
            14,
            [field for field, _distance in fields],
        )

    def test_shared_structural_denature_mutates_parent_not_same_number_leaf(self):
        page_leaf = self._field(14, b"x/pagead/y")
        google_leaf = self._field(
            7,
            b"xgoogleadservices.comy",
        )
        shared_payload = page_leaf + google_leaf
        shared_parent = self._field(14, shared_payload)
        unrelated_page_leaf = self._field(14, b"z/pagead/z")
        body = (
            unrelated_page_leaf
            + self._field(214, shared_parent)
        )

        nodes = MODULE.shared_marker_field_nodes(
            body,
            [14],
            backtrack_bytes=1024,
        )
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0][0], 14)
        self.assertEqual(
            nodes[0][4] - nodes[0][3],
            len(shared_payload),
        )

        mutated, changes = MODULE.denature_shared_ad_fields(
            body,
            [14],
            backtrack_bytes=1024,
        )

        self.assertEqual(changes, {14: 1})
        self.assertEqual(len(mutated), len(body))
        self.assertEqual(
            mutated[: len(unrelated_page_leaf)],
            unrelated_page_leaf,
        )
        self.assertNotEqual(mutated, body)
        self.assertIn(b"/pagead/", mutated)
        self.assertIn(b"googleadservices.com", mutated)

    def test_diagnostic_plan_and_mutation_use_identical_nodes(self):
        page_leaf = self._field(14, b"x/pagead/y")
        google_leaf = self._field(
            7,
            b"xgoogleadservices.comy",
        )
        shared_payload = page_leaf + google_leaf
        shared_parent = self._field(14, shared_payload)
        unrelated = self._field(14, b"only/pagead/here")
        body = unrelated + self._field(214, shared_parent)

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body)
        diagnostic_nodes = [
            candidate
            for candidate, _marker_hits, _depths
            in scanner.shared_nodes([14])
        ]
        compatibility_nodes = MODULE.shared_marker_field_nodes(
            body,
            [14],
            backtrack_bytes=1024,
        )

        self.assertEqual(diagnostic_nodes, compatibility_nodes)
        planned = MODULE.planned_field_counts(diagnostic_nodes)
        mutated, changes = MODULE.denature_planned_nodes(
            body,
            diagnostic_nodes,
        )
        self.assertEqual(planned, {14: 1})
        self.assertEqual(changes, planned)
        self.assertNotEqual(mutated, body)

    def test_denature_planned_nodes_exposes_plan_mismatch(self):
        body = self._field(
            14,
            b"x/pagead/xgoogleadservices.comy",
        )
        bad_node = (14, 0, len(body) + 10, 0, len(body))

        planned = MODULE.planned_field_counts([bad_node])
        mutated, changes = MODULE.denature_planned_nodes(
            body,
            [bad_node],
        )

        self.assertEqual(planned, {14: 1})
        self.assertEqual(changes, {})
        self.assertEqual(mutated, body)

    def test_neutralize_planned_nodes_preserves_length_and_removes_markers(self):
        page_leaf = self._field(14, b"x/pagead/y")
        google_leaf = self._field(
            7,
            b"xgoogleadservices.comy",
        )
        shared_payload = page_leaf + google_leaf + (b"z" * 32)
        shared_parent = self._field(14, shared_payload)
        unrelated = self._field(14, b"only/pagead/here")
        body = unrelated + self._field(214, shared_parent)

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body)
        planned_nodes = [
            candidate
            for candidate, _marker_hits, _depths
            in scanner.shared_nodes([14])
        ]
        planned = MODULE.planned_field_counts(planned_nodes)

        neutralized, changes = MODULE.neutralize_planned_nodes(
            body,
            planned_nodes,
        )

        self.assertEqual(planned, {14: 1})
        self.assertEqual(changes, planned)
        self.assertEqual(len(neutralized), len(body))
        self.assertEqual(
            neutralized[: len(unrelated)],
            unrelated,
        )

        target = planned_nodes[0]
        payload = neutralized[target[3]:target[4]]
        self.assertNotIn(b"/pagead/", payload)
        self.assertNotIn(b"googleadservices.com", payload)

    def test_neutral_filler_is_valid_zero_length_protobuf_fields(self):
        filler = MODULE._neutral_filler(257)
        self.assertEqual(len(filler), 257)

        pos = 0
        while pos < len(filler):
            key_decoded = MODULE.decode_varint(filler, pos, max_bytes=5)
            self.assertIsNotNone(key_decoded)
            key, key_end = key_decoded
            self.assertEqual(key & 0x07, 2)
            self.assertGreaterEqual(key >> 3, 2047)

            length_decoded = MODULE.decode_varint(
                filler,
                key_end,
                max_bytes=10,
            )
            self.assertIsNotNone(length_decoded)
            length, payload_start = length_decoded
            self.assertEqual(length, 0)
            self.assertEqual(payload_start, key_end + 1)
            pos = payload_start

        self.assertEqual(pos, len(filler))

    def test_neutralization_exposes_plan_mismatch(self):
        body = self._field(
            14,
            b"x/pagead/xgoogleadservices.comy",
        )
        bad_node = (14, 0, len(body) + 10, 0, len(body))

        planned = MODULE.planned_field_counts([bad_node])
        neutralized, changes = MODULE.neutralize_planned_nodes(
            body,
            [bad_node],
        )

        self.assertEqual(planned, {14: 1})
        self.assertEqual(changes, {})
        self.assertEqual(neutralized, body)

    def test_shared_structural_denature_requires_both_marker_types(self):
        body = self._field(14, b"only/pagead/here")

        mutated, changes = MODULE.denature_shared_ad_fields(
            body,
            [14],
            backtrack_bytes=1024,
        )

        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_is_inert_without_validated_targets(self):
        body = self._field(
            50195462,
            b"abc/pagead/def",
        )
        mutated, changes = MODULE.denature_ad_fields(body, [])
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_changes_only_configured_enclosing_field(self):
        target = 50195462
        other = 49399797
        body = self._field(other, b"normal") + self._field(
            target,
            b"abc/pagead/def",
        )

        mutated, changes = MODULE.denature_ad_fields(
            body,
            [target],
            backtrack_bytes=1024,
        )

        self.assertEqual(changes, {target: 1})
        self.assertEqual(len(mutated), len(body))
        self.assertNotEqual(mutated, body)
        self.assertIn(MODULE.tag_bytes(other), mutated)
        self.assertIn(b"/pagead/", mutated)

    def test_denature_rejects_nearby_tag_that_does_not_enclose_marker(self):
        target = 50195462
        decoy = (
            MODULE.tag_bytes(target)
            + MODULE.encode_varint(1)
            + b"x"
        )
        body = decoy + self._field(
            12,
            b"abc/pagead/def",
        )

        mutated, changes = MODULE.denature_ad_fields(
            body,
            [target],
            backtrack_bytes=1024,
        )

        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_does_not_touch_target_without_marker(self):
        target = 50195462
        body = self._field(
            target,
            b"ordinary protobuf payload",
        )
        mutated, changes = MODULE.denature_ad_fields(
            body,
            [target],
        )
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})


if __name__ == "__main__":
    unittest.main()
