from __future__ import annotations

import importlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from strategies.base import AppStrategy

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


@dataclass(frozen=True)
class IntegrationAction:
    id: str
    label: str
    kind: str


@dataclass(frozen=True)
class IntegrationSpec:
    id: str
    name: str
    description: str
    strategy: str
    hosts: tuple[str, ...]
    actions: tuple[IntegrationAction, ...]


class IntegrationRegistry:
    def __init__(self, integrations: tuple[IntegrationSpec, ...]) -> None:
        if not integrations:
            raise ValueError("at least one HTTPS integration is required")
        ids = [item.id for item in integrations]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate HTTPS integration id")
        self._integrations = integrations
        self._by_id = {item.id: item for item in integrations}

    @classmethod
    def from_file(cls, path: str | Path) -> "IntegrationRegistry":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        raw_items = payload.get("integrations")
        if not isinstance(raw_items, list):
            raise ValueError("integrations must be a list")

        integrations: list[IntegrationSpec] = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise ValueError("integration entries must be objects")

            integration_id = raw.get("id")
            if not isinstance(integration_id, str) or not _ID_RE.fullmatch(integration_id):
                raise ValueError("invalid integration id")

            name = raw.get("name")
            description = raw.get("description")
            strategy = raw.get("strategy")
            hosts = raw.get("hosts")
            raw_actions = raw.get("actions")

            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"{integration_id}: invalid name")
            if not isinstance(description, str):
                raise ValueError(f"{integration_id}: invalid description")
            if not isinstance(strategy, str) or ":" not in strategy:
                raise ValueError(f"{integration_id}: invalid strategy")
            if not isinstance(hosts, list) or not hosts:
                raise ValueError(f"{integration_id}: hosts must be a non-empty list")
            normalized_hosts = tuple(
                str(host).strip().lower().lstrip(".")
                for host in hosts
                if str(host).strip()
            )
            if not normalized_hosts:
                raise ValueError(f"{integration_id}: hosts must be non-empty")

            if not isinstance(raw_actions, list) or not raw_actions:
                raise ValueError(f"{integration_id}: actions must be a non-empty list")

            actions: list[IntegrationAction] = []
            action_ids: set[str] = set()
            for raw_action in raw_actions:
                if not isinstance(raw_action, dict):
                    raise ValueError(f"{integration_id}: invalid action")
                action_id = raw_action.get("id")
                label = raw_action.get("label")
                kind = raw_action.get("kind")
                if not isinstance(action_id, str) or not _ID_RE.fullmatch(action_id):
                    raise ValueError(f"{integration_id}: invalid action id")
                if action_id in action_ids:
                    raise ValueError(f"{integration_id}: duplicate action id")
                if not isinstance(label, str) or not label.strip():
                    raise ValueError(f"{integration_id}: invalid action label")
                if not isinstance(kind, str) or not _ID_RE.fullmatch(kind):
                    raise ValueError(f"{integration_id}: invalid action kind")
                action_ids.add(action_id)
                actions.append(IntegrationAction(action_id, label.strip(), kind))

            integrations.append(
                IntegrationSpec(
                    id=integration_id,
                    name=name.strip(),
                    description=description.strip(),
                    strategy=strategy,
                    hosts=normalized_hosts,
                    actions=tuple(actions),
                )
            )

        return cls(tuple(integrations))

    def list(self) -> tuple[IntegrationSpec, ...]:
        return self._integrations

    def get(self, integration_id: str) -> IntegrationSpec:
        try:
            return self._by_id[integration_id]
        except KeyError as exc:
            raise KeyError(f"unknown HTTPS integration: {integration_id}") from exc

    def build_strategy(self, integration_id: str) -> AppStrategy:
        spec = self.get(integration_id)
        module_name, class_name = spec.strategy.split(":", 1)
        module = importlib.import_module(module_name)
        strategy_type = getattr(module, class_name)
        if not isinstance(strategy_type, type) or not issubclass(strategy_type, AppStrategy):
            raise TypeError(f"{spec.strategy} is not an AppStrategy")
        return strategy_type(spec)
