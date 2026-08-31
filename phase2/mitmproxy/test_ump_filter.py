import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("ump_filter", ROOT / "ump_filter.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def pv(value):
    return MODULE._encode_proto_varint(value)


def vi(number, value):
    return pv(number << 3) + pv(value)


def ld(number, value):
    return MODULE._length_field(number, value)


class UmpFilterTest(unittest.TestCase):
    def test_disables_exact_preroll_flag_without_changing_size(self):
        inner = ld(2, b"encrypted") + ld(5, b"key") + vi(13, 1) + vi(14, 1)
        request = ld(1, b"url") + ld(3, inner) + ld(4, b"config")

        filtered, changes, result = MODULE.disable_preroll_request(request)

        self.assertEqual(changes, 1)
        self.assertEqual(result, "applied")
        self.assertEqual(len(filtered), len(request))
        parsed_inner = next(
            field.value for field in MODULE._proto_fields(filtered)
            if field.number == 3
        )
        fields = MODULE._proto_fields(parsed_inner)
        self.assertIn((13, 0), [(field.number, field.value) for field in fields])
        self.assertIn((14, 1), [(field.number, field.value) for field in fields])
        self.assertIn(b"encrypted", filtered)

    def test_absent_or_already_false_is_unchanged(self):
        for inner in (ld(2, b"encrypted"), vi(13, 0)):
            request = ld(3, inner)
            expected = "absent" if inner != vi(13, 0) else "already_false"
            self.assertEqual(
                MODULE.disable_preroll_request(request),
                (request, 0, expected),
            )

    def test_wrong_wire_or_non_boolean_fails_closed(self):
        for inner in (ld(13, b"true"), vi(13, 2)):
            request = ld(3, inner)
            self.assertEqual(
                MODULE.disable_preroll_request(request),
                (request, 0, "rejected"),
            )

    def test_malformed_request_fails_closed(self):
        request = b"\x1a\x05bad"
        self.assertEqual(
            MODULE.disable_preroll_request(request),
            (request, 0, "rejected"),
        )

    def test_all_duplicate_true_flags_are_planned_and_applied(self):
        request = ld(3, vi(13, 1) + vi(13, 1))
        filtered, changes, result = MODULE.disable_preroll_request(request)
        self.assertEqual(changes, 2)
        self.assertEqual(result, "applied")
        self.assertEqual(len(filtered), len(request))


if __name__ == "__main__":
    unittest.main()
