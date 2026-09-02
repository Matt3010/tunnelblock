from __future__ import annotations

from typing import TYPE_CHECKING, Any

from core.context import HttpContext

if TYPE_CHECKING:
    from core.registry import IntegrationSpec


class AppStrategy:
    """Base contract for application-specific HTTPS strategies.

    The framework streams request/response bodies by default. A future strategy
    that genuinely needs payload access must opt in explicitly by setting the
    corresponding body mode to "buffer".
    """

    request_body_mode = "stream"
    response_body_mode = "stream"

    def __init__(self, spec: "IntegrationSpec") -> None:
        self.spec = spec

    def matches_host(self, host: str | None) -> bool:
        if not host:
            return False

        normalized = host.rstrip(".").lower()
        for suffix in self.spec.hosts:
            if suffix == "*":
                return True
            if normalized == suffix or normalized.endswith("." + suffix):
                return True
        return False

    def on_request_headers(self, context: HttpContext, flow: Any) -> None:
        pass

    def on_request(self, context: HttpContext, flow: Any) -> None:
        pass

    def on_response_headers(self, context: HttpContext, flow: Any) -> None:
        pass

    def on_response(self, context: HttpContext, flow: Any) -> None:
        pass
