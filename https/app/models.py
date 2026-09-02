from dataclasses import dataclass


@dataclass(frozen=True)
class HttpContext:
    host: str
    method: str
    path: str
    status_code: int | None = None
    content_type: str | None = None
    http_version: str | None = None
