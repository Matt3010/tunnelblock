from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http, tls

from core.context import HttpContext
from core.registry import IntegrationRegistry

CONFIG_PATH = Path(os.environ.get("HTTPS_INTEGRATIONS_CONFIG", "/opt/https/config/integrations.json"))
ACTIVE_INTEGRATION = os.environ.get("HTTPS_INTEGRATION", "instagram").strip()
DATA_DIR = Path(os.environ.get("HTTPS_DATA_DIR", "/https-data"))
MAX_BYTES = int(os.environ.get("HTTPS_OBSERVATION_MAX_BYTES", str(25 * 1024 * 1024)))

REGISTRY = IntegrationRegistry.from_file(CONFIG_PATH)
SPEC = REGISTRY.get(ACTIVE_INTEGRATION)
STRATEGY = REGISTRY.build_strategy(ACTIVE_INTEGRATION)
LOG_PATH = DATA_DIR / "observations" / f"{SPEC.id}.jsonl"
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_path(raw: str) -> str:
    if not raw:
        return "/"

    try:
        parsed = urlsplit(raw)
    except ValueError:
        return "/"

    path = parsed.path or "/"
    segments = path.split("/")
    safe_segments: list[str] = []
    for segment in segments:
        token_like = (
            len(segment) > 64
            or "=" in segment
            or bool(re.fullmatch(r"[A-Za-z0-9_-]{24,}", segment))
        )
        safe_segments.append("<redacted>" if token_like else segment)

    return ("/".join(safe_segments) or "/")[:512]


def _rotate_if_needed() -> None:
    if MAX_BYTES <= 0 or not LOG_PATH.exists():
        return
    try:
        if LOG_PATH.stat().st_size < MAX_BYTES:
            return
    except OSError:
        return

    backup = LOG_PATH.with_suffix(LOG_PATH.suffix + ".1")
    try:
        backup.unlink(missing_ok=True)
        LOG_PATH.replace(backup)
    except OSError:
        pass


def _emit(event: str, **fields: object) -> None:
    record = {
        "ts": _now(),
        "integration": SPEC.id,
        "event": event,
        **{key: value for key, value in fields.items() if value is not None},
    }
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    with _lock:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed()
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def _http_context(flow: http.HTTPFlow) -> HttpContext:
    response = flow.response
    return HttpContext(
        integration_id=SPEC.id,
        host=flow.request.pretty_host,
        method=flow.request.method,
        path=_safe_path(flow.request.path),
        scheme=flow.request.scheme,
        port=flow.request.port,
        http_version=flow.request.http_version,
        status_code=response.status_code if response is not None else None,
        content_type=(
            (response.headers.get("content-type") or "").split(";", 1)[0][:120]
            if response is not None
            else None
        ),
    )


def _decode_alpn(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace")
    return str(value)


def _tls_sni(data: tls.TlsData) -> str | None:
    direct = getattr(data.conn, "sni", None)
    if direct:
        return direct
    server = getattr(data.context, "server", None)
    return getattr(server, "sni", None)


def _tls_metadata(data: tls.TlsData) -> dict[str, object]:
    conn = data.conn
    return {
        "transport": getattr(conn, "transport_protocol", None),
        "tls_version": getattr(conn, "tls_version", None),
        "alpn": _decode_alpn(getattr(conn, "alpn", None)),
        "cipher": getattr(conn, "cipher", None),
    }


def _tls_error_category(data: tls.TlsData) -> str:
    error = str(getattr(data.conn, "error", "") or "").lower()
    if (
        "unknown ca" in error
        or "bad certificate" in error
        or "certificate unknown" in error
    ):
        return "certificate_rejected"
    if "closed" in error or "eof" in error:
        return "connection_closed_during_handshake"
    if "protocol" in error or "version" in error or "cipher" in error:
        return "tls_negotiation_failure"
    return "tls_handshake_failure"


def requestheaders(flow: http.HTTPFlow) -> None:
    if not STRATEGY.matches_host(flow.request.pretty_host):
        return

    flow.request.stream = STRATEGY.request_body_mode != "buffer"
    context = _http_context(flow)
    _emit(
        "http_request",
        host=context.host,
        method=context.method,
        path=context.path,
        scheme=context.scheme,
        port=context.port,
        http_version=context.http_version,
    )
    STRATEGY.on_request_headers(context, flow)


def request(flow: http.HTTPFlow) -> None:
    if STRATEGY.matches_host(flow.request.pretty_host):
        STRATEGY.on_request(_http_context(flow), flow)


def responseheaders(flow: http.HTTPFlow) -> None:
    if flow.response is None or not STRATEGY.matches_host(flow.request.pretty_host):
        return

    flow.response.stream = STRATEGY.response_body_mode != "buffer"
    context = _http_context(flow)
    _emit(
        "http_response",
        host=context.host,
        method=context.method,
        path=context.path,
        status_code=context.status_code,
        content_type=context.content_type,
        http_version=flow.response.http_version,
    )
    STRATEGY.on_response_headers(context, flow)


def response(flow: http.HTTPFlow) -> None:
    if flow.response is not None and STRATEGY.matches_host(flow.request.pretty_host):
        STRATEGY.on_response(_http_context(flow), flow)


def tls_clienthello(data: tls.ClientHelloData) -> None:
    sni = data.client_hello.sni
    if not STRATEGY.matches_host(sni):
        return

    alpn = [_decode_alpn(item) for item in data.client_hello.alpn_protocols]
    _emit(
        "tls_clienthello",
        sni=sni,
        alpn=[item for item in alpn if item is not None],
    )


def tls_established_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if STRATEGY.matches_host(sni):
        _emit("tls_established_client", sni=sni, **_tls_metadata(data))


def tls_established_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if STRATEGY.matches_host(sni):
        _emit("tls_established_server", sni=sni, **_tls_metadata(data))


def tls_failed_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if STRATEGY.matches_host(sni):
        _emit(
            "tls_failed_client",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_metadata(data),
        )


def tls_failed_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if STRATEGY.matches_host(sni):
        _emit(
            "tls_failed_server",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_metadata(data),
        )


_emit(
    "integration_loaded",
    name=SPEC.name,
    hosts=list(SPEC.hosts),
    request_body_mode=STRATEGY.request_body_mode,
    response_body_mode=STRATEGY.response_body_mode,
)


if __name__ == "__main__":
    assert _safe_path("/api/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG") == "/api/<redacted>"
    assert _safe_path("https://example.test/feed?q=private") == "/feed"
    assert STRATEGY.matches_host("i.instagram.com")
