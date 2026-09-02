from __future__ import annotations

import json
import importlib
import re
from pathlib import Path

from app.strategies.base import AppStrategy, StrategyConfig

_ID_RE = re.compile(r"^[a-z0-9_-]{1,24}$")
_ACTION_KINDS = {"certificate", "start", "stop", "summary", "clear"}
_VISIBILITY = {"always", "active", "inactive"}


class StrategyRegistry:
    def __init__(self, config_path: str | Path) -> None:
        payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
        if payload.get("version") != 1:
            raise ValueError("unsupported integration registry version")

        integrations = payload.get("integrations")
        if not isinstance(integrations, list):
            raise ValueError("integrations must be a list")

        self._strategies: dict[str, AppStrategy] = {}
        for item in integrations:
            strategy = self._build(item)
            if strategy.id in self._strategies:
                raise ValueError(f"duplicate integration id: {strategy.id}")
            self._strategies[strategy.id] = strategy

    def _build(self, item: object) -> AppStrategy:
        if not isinstance(item, dict):
            raise ValueError("integration entry must be an object")

        integration_id = item.get("id")
        strategy_name = item.get("strategy")
        if not isinstance(integration_id, str) or not _ID_RE.fullmatch(integration_id):
            raise ValueError("invalid integration id")
        if not isinstance(strategy_name, str) or ":" not in strategy_name:
            raise ValueError(f"invalid strategy: {strategy_name}")

        host_suffixes_raw = item.get("hostSuffixes")
        actions_raw = item.get("actions")
        if not isinstance(host_suffixes_raw, list) or not host_suffixes_raw:
            raise ValueError(f"{integration_id}: hostSuffixes must not be empty")
        if not isinstance(actions_raw, list):
            raise ValueError(f"{integration_id}: actions must be a list")

        host_suffixes = tuple(
            value.strip().lower().lstrip(".")
            for value in host_suffixes_raw
            if isinstance(value, str) and value.strip()
        )
        actions: list[dict[str, str]] = []
        action_ids: set[str] = set()
        for action in actions_raw:
            if not isinstance(action, dict):
                raise ValueError(f"{integration_id}: invalid action")
            action_id = action.get("id")
            kind = action.get("kind")
            label = action.get("label")
            visibility = action.get("visibleWhen", "always")
            if not isinstance(action_id, str) or not _ID_RE.fullmatch(action_id) or action_id in action_ids:
                raise ValueError(f"{integration_id}: invalid or duplicate action id")
            if kind not in _ACTION_KINDS or not isinstance(label, str) or not label.strip() or visibility not in _VISIBILITY:
                raise ValueError(f"{integration_id}: invalid action metadata")
            action_ids.add(action_id)
            actions.append({"id": action_id, "kind": kind, "label": label.strip(), "visibleWhen": visibility})
        if not host_suffixes:
            raise ValueError(f"{integration_id}: no valid host suffix")

        config = StrategyConfig(
            id=integration_id,
            name=str(item.get("name") or integration_id),
            description=str(item.get("description") or ""),
            status=str(item.get("status") or "experimental"),
            actions=tuple(actions),
            host_suffixes=host_suffixes,
        )
        module_name, class_name = strategy_name.split(":", 1)
        try:
            strategy_type = getattr(importlib.import_module(module_name), class_name)
        except (ImportError, AttributeError) as error:
            raise ValueError(f"invalid strategy: {strategy_name}") from error
        if not isinstance(strategy_type, type) or not issubclass(strategy_type, AppStrategy):
            raise ValueError(f"strategy is not an AppStrategy: {strategy_name}")
        return strategy_type(config)

    def get(self, integration_id: str) -> AppStrategy:
        try:
            return self._strategies[integration_id]
        except KeyError as error:
            raise KeyError(f"unknown integration: {integration_id}") from error

    def all(self) -> tuple[AppStrategy, ...]:
        return tuple(self._strategies.values())
