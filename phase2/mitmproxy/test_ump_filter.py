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
    key = bytes(range(32))
    iv = bytes(range(16))

    def test_ump_varints_round_trip_boundaries(self):
        for value in (0, 127, 128, 16383, 16384, 0x1fffff, 0x200000, 0x0fffffff, 0x10000000, 0xffffffff):
            encoded = MODULE._encode_ump_varint(value)
            decoded, end = MODULE._ump_varint(encoded, 0)
            self.assertEqual((decoded, end), (value, len(encoded)))

    def test_filters_plain_player_response_exact_fields(self):
        tracking = ld(1, b"playback") + ld(18, b"pagead")
        body = ld(9, tracking) + ld(11, b"video") + ld(45, b"placement") + ld(68, b"slot")
        filtered, changes = MODULE.filter_player_response(body)
        self.assertEqual(changes, 3)
        self.assertEqual(filtered, ld(9, ld(1, b"playback")) + ld(11, b"video"))

    def test_filters_encrypted_get_watch_content(self):
        player = ld(4, b"normal") + ld(45, b"ad-placement") + ld(68, b"ad-slot")
        next_response = ld(7, b"normal") + ld(53, b"next-ad-slot")
        plaintext = ld(4, ld(2, player) + ld(3, next_response))
        compressed = MODULE._compress(plaintext, 1)
        ciphertext = MODULE._crypt(self.key, self.iv, compressed)
        encrypted = ld(1, ciphertext) + ld(2, MODULE._signature(self.key, ciphertext, self.iv)) + ld(3, self.iv) + vi(4, 1)
        stream = MODULE._encode_ump_parts([(10, vi(1, 25)), (11, encrypted), (21, b"media")])

        filtered, changes = MODULE.filter_ump_response(stream, self.key)

        self.assertEqual(changes, 3)
        parts = MODULE._ump_parts(filtered)
        payload = parts[1][1]
        new_cipher = MODULE._first_bytes(payload, 1)
        new_hmac = MODULE._first_bytes(payload, 2)
        decoded = MODULE._decompress(MODULE._decrypt(self.key, self.iv, new_cipher, new_hmac), 1)
        self.assertNotIn(b"ad-placement", decoded)
        self.assertNotIn(b"ad-slot", decoded)
        self.assertTrue(filtered.endswith(b"media"))

    def test_filters_encrypted_player_envelope_and_updates_header_hmac(self):
        player = ld(11, b"video") + ld(45, b"ad") + ld(68, b"slot")
        envelope = vi(1, 1) + vi(2, 200) + ld(4, player)
        ciphertext = MODULE._crypt(self.key, self.iv, envelope)
        signature = MODULE._signature(self.key, ciphertext, self.iv)
        crypto = ld(4, signature) + ld(5, self.iv) + vi(6, 1)
        header = vi(1, 0) + ld(4, crypto)
        stream = MODULE._encode_ump_parts([(10, header), (11, MODULE._compress(ciphertext, 1))])

        filtered, changes = MODULE.filter_ump_response(stream, self.key)

        self.assertEqual(changes, 2)
        parts = MODULE._ump_parts(filtered)
        new_crypto = MODULE._first_bytes(parts[0][1], 4)
        new_signature = MODULE._first_bytes(new_crypto, 4)
        new_cipher = MODULE._decompress(parts[1][1], 1)
        decoded = MODULE._decrypt(self.key, self.iv, new_cipher, new_signature)
        self.assertNotIn(b"ad", decoded)
        self.assertIn(b"video", decoded)

    def test_hmac_mismatch_forwards_original(self):
        encrypted = ld(1, b"cipher") + ld(2, b"bad") + ld(3, self.iv)
        stream = MODULE._encode_ump_parts([(10, vi(1, 25)), (11, encrypted)])
        filtered, changes = MODULE.filter_ump_response(stream, self.key)
        self.assertEqual((filtered, changes), (stream, 0))

    def test_stream_filter_handles_every_chunk_boundary(self):
        player = ld(11, b"video") + ld(45, b"placement")
        plaintext = ld(4, ld(2, player))
        ciphertext = MODULE._crypt(self.key, self.iv, plaintext)
        encrypted = ld(1, ciphertext) + ld(2, MODULE._signature(self.key, ciphertext, self.iv)) + ld(3, self.iv)
        stream = MODULE._encode_ump_parts([(10, vi(1, 25)), (11, encrypted), (21, b"media")])

        transformer = MODULE.UmpStreamFilter(self.key)
        output = b"".join(transformer.feed(bytes([byte])) for byte in stream)
        output += transformer.feed(b"")

        self.assertEqual(transformer.changes, 1)
        self.assertNotEqual(output, stream)
        self.assertEqual(MODULE._ump_parts(output)[-1], (21, b"media"))

    def test_stream_filter_forwards_bad_pair_exactly(self):
        encrypted = ld(1, b"cipher") + ld(2, b"bad") + ld(3, self.iv)
        stream = MODULE._encode_ump_parts([(10, vi(1, 25)), (11, encrypted), (21, b"media")])
        transformer = MODULE.UmpStreamFilter(self.key)
        output = transformer.feed(stream) + transformer.feed(b"")
        self.assertEqual(output, stream)
        self.assertEqual(transformer.changes, 0)

    @unittest.skipIf(MODULE.brotli is None, "brotli unavailable on host")
    def test_brotli_round_trip(self):
        payload = b"protobuf payload" * 100
        self.assertEqual(
            MODULE._decompress(MODULE._compress(payload, 2), 2),
            payload,
        )


if __name__ == "__main__":
    unittest.main()
