import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("ump_diagnostics", ROOT / "ump_diagnostics.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def varint(value):
    out = bytearray()
    while value > 0x7f:
        out.append((value & 0x7f) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def field(number, value):
    return varint((number << 3) | 2) + varint(len(value)) + value


class UmpDiagnosticsTest(unittest.TestCase):
    def test_extracts_only_key_metadata_from_exact_path(self):
        config = field(1, b"client-secret") + field(2, b"encrypt-secret")
        config += varint(3 << 3) + varint(901) + varint(30 << 3) + b"\x01"
        body = config
        for number in reversed(MODULE.CONFIG_PATH):
            body = field(number, body)
        result = MODULE.inspect_onesie_config(body)
        self.assertTrue(result["parsed"])
        self.assertEqual(result["config_nodes"], 1)
        self.assertEqual(result["configs"][0]["client_key_bytes"], 13)
        self.assertEqual(result["configs"][0]["encrypt_key_bytes"], 14)
        self.assertEqual(result["configs"][0]["expiry_bucket_seconds"], 900)
        self.assertNotIn("client-secret", repr(result))

    def test_does_not_promote_similar_parent(self):
        result = MODULE.inspect_onesie_config(field(146311580, field(1, b"secret")))
        self.assertEqual(result["config_nodes"], 0)

    def test_byte_counter_never_retains_content(self):
        counter = MODULE.ByteCounter()
        self.assertEqual(counter.feed(b"secret"), b"secret")
        self.assertEqual((counter.body_bytes, counter.chunks), (6, 1))
        self.assertNotIn("secret", repr(counter))


if __name__ == "__main__":
    unittest.main()
