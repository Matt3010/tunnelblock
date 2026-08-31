import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location(
    "decision_fingerprint", ROOT / "decision_fingerprint.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

from protobuf_scan import encode_varint, tag_bytes  # noqa: E402


def field(number: int, payload: bytes) -> bytes:
    return tag_bytes(number) + encode_varint(len(payload)) + payload


class DecisionFingerprintTest(unittest.TestCase):
    def test_values_are_not_exposed_and_equal_shapes_match(self):
        first = field(1, field(7, b"secret-one")) + tag_bytes(2, 0) + b"\x01"
        second = field(1, field(7, b"secret-two")) + tag_bytes(2, 0) + b"\x01"
        a = MODULE.structural_fingerprint(first)
        b = MODULE.structural_fingerprint(second)
        self.assertTrue(a["parsed"])
        self.assertEqual(a["root_fingerprint"], b["root_fingerprint"])
        self.assertEqual(a["nested_paths"], {"1": 1})
        self.assertEqual(len(a["path_fingerprints"]), 1)
        self.assertNotIn("secret", repr(a))
        self.assertEqual(a["scalar_buckets"], {"2#1": 1})

    def test_varints_use_coarse_buckets(self):
        body = tag_bytes(3, 0) + encode_varint(300)
        result = MODULE.structural_fingerprint(body)
        self.assertEqual(result["scalar_buckets"], {"3#256-511": 1})

    def test_different_nested_structure_changes_fingerprint(self):
        first = field(1, field(7, b"abcdefgh"))
        second = field(1, field(8, b"abcdefgh"))
        self.assertNotEqual(
            MODULE.structural_fingerprint(first)["root_fingerprint"],
            MODULE.structural_fingerprint(second)["root_fingerprint"],
        )

    def test_invalid_payload_is_reported_without_content(self):
        self.assertEqual(MODULE.structural_fingerprint(b"private"), {"parsed": False})


if __name__ == "__main__":
    unittest.main()
