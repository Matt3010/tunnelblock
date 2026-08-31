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
        return MODULE.tag_bytes(number) + MODULE.encode_varint(len(payload)) + payload

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
        self.assertEqual(result["nearest_candidate_fields"][str(target)], 1)
        stats = result["nearest_candidate_distance_bytes"][str(target)]
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["min"], stats["max"])
        self.assertGreater(stats["avg"], 0)

    def test_nearest_field_prefers_inner_enclosing_message(self):
        outer = 12
        inner = 50195462
        nested = self._field(inner, b"abc/pagead/def")
        body = self._field(outer, nested)

        marker_pos = body.index(b"/pagead/")
        fields = MODULE.enclosing_length_delimited_fields(
            body, marker_pos, len(b"/pagead/"), 1024
        )

        self.assertEqual(fields[0][0], inner)
        self.assertIn((outer, marker_pos), fields)

    def test_denature_is_inert_without_validated_targets(self):
        body = self._field(50195462, b"abc/pagead/def")
        mutated, changes = MODULE.denature_ad_fields(body, [])
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_changes_only_configured_enclosing_field(self):
        target = 50195462
        other = 49399797
        body = self._field(other, b"normal") + self._field(target, b"abc/pagead/def")

        mutated, changes = MODULE.denature_ad_fields(
            body, [target], backtrack_bytes=1024
        )

        self.assertEqual(changes, {target: 1})
        self.assertEqual(len(mutated), len(body))
        self.assertNotEqual(mutated, body)
        self.assertIn(MODULE.tag_bytes(other), mutated)
        self.assertIn(b"/pagead/", mutated)

    def test_denature_rejects_nearby_tag_that_does_not_enclose_marker(self):
        target = 50195462
        decoy = MODULE.tag_bytes(target) + MODULE.encode_varint(1) + b"x"
        body = decoy + self._field(12, b"abc/pagead/def")

        mutated, changes = MODULE.denature_ad_fields(
            body, [target], backtrack_bytes=1024
        )

        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_does_not_touch_target_without_marker(self):
        target = 50195462
        body = self._field(target, b"ordinary protobuf payload")
        mutated, changes = MODULE.denature_ad_fields(body, [target])
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})


if __name__ == "__main__":
    unittest.main()
