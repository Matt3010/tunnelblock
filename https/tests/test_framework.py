import unittest

from app.main import _safe_path
from app.models import HttpContext
from app.registry import StrategyRegistry


class FrameworkTest(unittest.TestCase):
    def test_path_sanitization(self):
        self.assertEqual(_safe_path("https://example.test/feed?q=secret"), "/feed")
        self.assertEqual(_safe_path("/api/abcdefghijklmnopqrstuvwxyz0123456789"), "/api/<redacted>")

    def test_streaming_defaults_and_no_mutation(self):
        strategy = StrategyRegistry("/app/integrations.json").get("instagram")
        self.assertEqual(strategy.request_body_mode, "stream")
        self.assertEqual(strategy.response_body_mode, "stream")
        context = HttpContext("instagram", "i.instagram.com", "GET", "/feed", "https", 443)
        self.assertIsNone(strategy.on_request_headers(context))
        self.assertIsNone(strategy.on_request(context))
        self.assertIsNone(strategy.on_response_headers(context))
        self.assertIsNone(strategy.on_response(context))
        self.assertEqual(context.path, "/feed")


if __name__ == "__main__":
    unittest.main()
