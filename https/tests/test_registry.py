import json
import tempfile
import unittest
from pathlib import Path

from core.registry import IntegrationRegistry
from strategies.instagram import InstagramStrategy


class RegistryTests(unittest.TestCase):
    def test_loads_instagram_and_matches_subdomains(self) -> None:
        registry = IntegrationRegistry.from_file("/opt/https/config/integrations.json")
        strategy = registry.build_strategy("instagram")

        self.assertIsInstance(strategy, InstagramStrategy)
        self.assertTrue(strategy.matches_host("i.instagram.com"))
        self.assertTrue(strategy.matches_host("scontent.cdninstagram.com"))
        self.assertTrue(strategy.matches_host("graph.facebook.com"))
        self.assertFalse(strategy.matches_host("example.com"))

    def test_rejects_duplicate_ids(self) -> None:
        payload = {
            "integrations": [
                {
                    "id": "same",
                    "name": "A",
                    "description": "",
                    "strategy": "strategies.instagram:InstagramStrategy",
                    "hosts": ["example.com"],
                    "actions": [{"id": "start", "label": "Start", "kind": "start"}],
                },
                {
                    "id": "same",
                    "name": "B",
                    "description": "",
                    "strategy": "strategies.instagram:InstagramStrategy",
                    "hosts": ["example.org"],
                    "actions": [{"id": "start", "label": "Start", "kind": "start"}],
                },
            ]
        }

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                IntegrationRegistry.from_file(path)


if __name__ == "__main__":
    unittest.main()
