from __future__ import annotations

from dataclasses import dataclass

from app.models import HttpContext


@dataclass(frozen=True)
class StrategyConfig:
    id: str
    name: str
    description: str
    status: str
    actions: tuple[str, ...]
    host_suffixes: tuple[str, ...]


class AppStrategy:
    def __init__(self, config: StrategyConfig) -> None:
        self.config = config

    @property
    def id(self) -> str:
        return self.config.id

    def matches_host(self, host: str | None) -> bool:
        if not host:
            return False
        normalized = host.rstrip(".").lower()
        return any(
            normalized == suffix or normalized.endswith("." + suffix)
            for suffix in self.config.host_suffixes
        )

    def on_request(self, context: HttpContext) -> dict[str, object]:
        return {}

    def on_response(self, context: HttpContext) -> dict[str, object]:
        return {}
