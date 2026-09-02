import json
import tempfile
import unittest
from pathlib import Path

from app.registry import StrategyRegistry


class StrategyRegistryTest(unittest.TestCase):
    def write_registry(self, integrations):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "integrations.json"
        path.write_text(json.dumps({"version": 1, "integrations": integrations}), encoding="utf-8")
        self.addCleanup(directory.cleanup)
        return path

    def entry(self, **changes):
        value = {
            "id": "example", "name": "Example", "description": "test",
            "strategy": "app.strategies.generic:GenericStrategy", "status": "experimental",
            "hostSuffixes": ["example.com"],
            "actions": [{"id": "start", "label": "Start", "kind": "start", "visibleWhen": "inactive"}],
        }
        value.update(changes)
        return value

    def test_empty_project_registry_loads(self):
        self.assertEqual(StrategyRegistry("/app/integrations.json").all(), ())

    def test_instagram_strategy_remains_available_but_unregistered(self):
        registry = StrategyRegistry(self.write_registry([self.entry(
            id="instagram",
            strategy="app.strategies.instagram:InstagramStrategy",
            hostSuffixes=["instagram.com", "cdninstagram.com", "facebook.com", "facebook.net", "fbcdn.net", "fbsbx.com"],
        )]))
        strategy = registry.get("instagram")
        for host in ("i.instagram.com", "cdninstagram.com", "graph.facebook.com", "connect.facebook.net", "x.fbcdn.net", "fbsbx.com"):
            self.assertTrue(strategy.matches_host(host), host)
        self.assertFalse(strategy.matches_host("example.com"))

    def test_duplicate_ids_rejected(self):
        entry = self.entry()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            StrategyRegistry(self.write_registry([entry, entry]))

    def test_invalid_strategy_rejected(self):
        with self.assertRaisesRegex(ValueError, "strategy"):
            StrategyRegistry(self.write_registry([self.entry(strategy="missing.module:Nope")]))

    def test_invalid_actions_rejected(self):
        with self.assertRaisesRegex(ValueError, "action"):
            StrategyRegistry(self.write_registry([self.entry(actions=[{"id": "oops", "label": "Oops", "kind": "shell"}])]))


if __name__ == "__main__":
    unittest.main()
