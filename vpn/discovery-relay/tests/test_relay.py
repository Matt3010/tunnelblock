import base64
import json
import sys
import unittest

sys.path.insert(0, "/app")
import relay


class RelayTests(unittest.TestCase):
    def test_codec_accepts_valid_message_and_rejects_replay(self):
        codec = relay.Codec("secret")
        encoded = codec.encode("register")
        decoded = codec.decode(encoded)
        self.assertEqual(decoded["kind"], "register")
        with self.assertRaises(ValueError):
            codec.decode(encoded)

    def test_codec_rejects_tampering(self):
        codec = relay.Codec("secret")
        encoded = codec.encode("packet", proto="mdns", payload=relay.encode_payload(b"abc"))
        envelope = json.loads(encoded)
        envelope["proto"] = "ssdp"
        tampered = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaises(ValueError):
            codec.decode(tampered)

    def test_mdns_query_and_response_detection(self):
        query = b"\x00\x00\x00\x00" + b"\x00" * 8
        response = b"\x00\x00\x84\x00" + b"\x00" * 8
        self.assertTrue(relay.is_mdns_query(query))
        self.assertFalse(relay.is_mdns_response(query))
        self.assertTrue(relay.is_mdns_response(response))
        self.assertFalse(relay.is_mdns_query(response))

    def test_mdns_qu_bit_is_cleared_for_lan_forwarding(self):
        header = b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
        question = b"\x05_test\x04_tcp\x05local\x00" + b"\x00\x0c" + b"\x80\x01"
        rewritten = relay.force_mdns_multicast_response(header + question)
        self.assertEqual(rewritten[-2:], b"\x00\x01")

    def test_ssdp_detection(self):
        search = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n\r\n"
        response = b"HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n"
        self.assertTrue(relay.is_ssdp_search(search))
        self.assertTrue(relay.is_ssdp_response(response))
        self.assertFalse(relay.is_ssdp_response(search))

    def test_payload_round_trip_and_limit(self):
        payload = b"\x00\x01hello"
        self.assertEqual(relay.decode_payload(relay.encode_payload(payload)), payload)
        too_large = base64.b64encode(b"x" * 16385).decode()
        with self.assertRaises(ValueError):
            relay.decode_payload(too_large)

    def test_vpn_client_validation(self):
        subnet = relay.ipaddress.ip_network("10.66.66.0/24")
        self.assertTrue(relay.is_vpn_client("10.66.66.2", subnet, "10.66.66.1"))
        self.assertFalse(relay.is_vpn_client("10.66.66.1", subnet, "10.66.66.1"))
        self.assertFalse(relay.is_vpn_client("192.168.1.20", subnet, "10.66.66.1"))


if __name__ == "__main__":
    unittest.main()
