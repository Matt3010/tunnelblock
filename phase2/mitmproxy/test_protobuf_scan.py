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

    def test_stream_scan_reports_nearest_field_and_distance_across_chunks(self):
        target = 50195462
        marker = b"/pagead/"
        body = self._field(target, b"abc" + marker + b"def")
        split = body.index(marker) + 3
        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body[:split])
        scanner.feed(body[split:])

        result = scanner.result()
        stats = result["nearest_fields"][str(target)]
        self.assertEqual(result["body_bytes"], len(body))
        self.assertEqual(result["markers"]["pagead"], 1)
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["min_distance"], body.index(marker))
        self.assertEqual(stats["max_distance"], body.index(marker))
        self.assertEqual(stats["avg_distance"], body.index(marker))

    def test_stream_scan_discards_outer_candidates_when_nested_field_is_nearer(self):
        outer = 49399797
        inner = 50195462
        marker = b"/pagead/"
        inner_field = self._field(inner, b"x" + marker + b"y")
        body = self._field(outer, inner_field)

        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(body)
        result = scanner.result()

        self.assertEqual(result["markers"]["pagead"], 1)
        self.assertIn(str(inner), result["nearest_fields"])
        self.assertNotIn(str(outer), result["nearest_fields"])

    def test_repeated_markers_aggregate_distance_stats(self):
        target = 50195462
        first = self._field(target, b"a/pagead/")
        second = self._field(target, b"abcdef/pagead/")
        scanner = MODULE.ProtobufStreamScanner(backtrack_bytes=1024)
        scanner.feed(first + second)

        stats = scanner.result()["nearest_fields"][str(target)]
        self.assertEqual(stats["hits"], 2)
        self.assertLessEqual(stats["min_distance"], stats["avg_distance"])
        self.assertGreaterEqual(stats["max_distance"], stats["avg_distance"])

    def test_denature_is_inert_without_validated_targets(self):
        body = self._field(50195462, b"abc/pagead/def")
        mutated, changes = MODULE.denature_ad_fields(body, [])
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})

    def test_denature_changes_only_configured_field_near_marker(self):
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

    def test_denature_does_not_touch_target_without_marker(self):
        target = 50195462
        body = self._field(target, b"ordinary protobuf payload")
        mutated, changes = MODULE.denature_ad_fields(body, [target])
        self.assertEqual(mutated, body)
        self.assertEqual(changes, {})


if __name__ == "__main__":
    unittest.main()
