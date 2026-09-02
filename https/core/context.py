from dataclasses import dataclass


@dataclass(frozen=True)
class HttpContext:
    integration_id: str
    host: str
    method: str
    path: str
    scheme: str
    port: int
    http_version: str
    status_code: int | None = None
    content_type: str | None = None
