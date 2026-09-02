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

    def test_registry_can_construct_generic_strategy(self) -> None:
        import json
        import tempfile

        payload = {
            "version": 1,
            "integrations": [{
                "id": "example",
                "name": "Example",
                "description": "Generic",
                "strategy": "generic",
                "status": "experimental",
                "actions": ["observe"],
                "hostSuffixes": ["example.com"],
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "integrations.json"
            config.write_text(json.dumps(payload), encoding="utf-8")
            registry = StrategyRegistry(config)
            self.assertTrue(registry.get("example").matches_host("api.example.com"))

    def test_unknown_integration_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            self.registry.get("unknown")


if __name__ == "__main__":
    unittest.main()
