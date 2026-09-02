import sys
import unittest
from pathlib import Path

sys.path.insert(0, "/app")

from app.registry import StrategyRegistry


class StrategyRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = StrategyRegistry("/app/integrations.json")

    def test_instagram_is_registered(self) -> None:
        strategy = self.registry.get("instagram")
        self.assertEqual(strategy.id, "instagram")
        self.assertIn("observe", strategy.config.actions)
        self.assertNotIn("filter", strategy.config.actions)

    def test_host_matching_is_suffix_safe(self) -> None:
        strategy = self.registry.get("instagram")
        self.assertTrue(strategy.matches_host("i.instagram.com"))
        self.assertTrue(strategy.matches_host("scontent.cdninstagram.com"))
        self.assertFalse(strategy.matches_host("instagram.com.evil.example"))

    def test_unknown_integration_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            self.registry.get("unknown")


if __name__ == "__main__":
    unittest.main()
