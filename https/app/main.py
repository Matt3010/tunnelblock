from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http, tls

from app.models import HttpContext
from app.registry import StrategyRegistry

REGISTRY_PATH = os.environ.get("HTTPS_INTEGRATION_REGISTRY", "/app/integrations.json")
ACTIVE_STRATEGY = os.environ.get("HTTPS_ACTIVE_STRATEGY", "").strip()
MODE = os.environ.get("HTTPS_MODE", "disabled").strip().lower()
LOG_DIR = Path(
    os.environ.get(
        "HTTPS_OBSERVATION_DIR",
        "/home/mitmproxy/.mitmproxy/observations",
    )
)
MAX_BYTES = int(os.environ.get("HTTPS_OBSERVATION_MAX_BYTES", str(25 * 1024 * 1024)))

_registry = StrategyRegistry(REGISTRY_PATH)
_strategy = _registry.get(ACTIVE_STRATEGY) if ACTIVE_STRATEGY else None
_lock = threading.Lock()

if MODE not in {"disabled", "observe"}:
    raise ValueError("HTTPS_MODE must be disabled or observe")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_path(raw: str) -> str:
    if not raw:
        return "/"
    try:
        path = urlsplit(raw).path or "/"
    except ValueError:
        return "/"

    safe: list[str] = []
    for segment in path.split("/"):
        token_like = (
            len(segment) > 48
            or "=" in segment
            or bool(re.fullmatch(r"[A-Za-z0-9_-]{16,}", segment))
        )
        safe.append("<redacted>" if token_like else segment)
    return ("/".join(safe) or "/")[:512]


def _log_path() -> Path:
    name = _strategy.id if _strategy else "inactive"
    return LOG_DIR / f"{name}.jsonl"


def _rotate_if_needed(path: Path) -> None:
    if MAX_BYTES <= 0 or not path.exists():
        return
    try:
        if path.stat().st_size < MAX_BYTES:
            return
        backup = path.with_suffix(path.suffix + ".1")
        backup.unlink(missing_ok=True)
        path.replace(backup)
    except OSError:
        return


def _emit(event: str, **fields: object) -> None:
    if MODE == "disabled" or _strategy is None:
        return

    path = _log_path()
    record = {
        "ts": _now(),
        "integration": _strategy.id,
        "mode": MODE,
        "event": event,
        **{key: value for key, value in fields.items() if value is not None},
    }
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def _matches(host: str | None) -> bool:
    return MODE != "disabled" and _strategy is not None and _strategy.matches_host(host)


def _context(flow: http.HTTPFlow, include_response: bool = False) -> HttpContext:
    response = flow.response if include_response else None
    return HttpContext(
        integration_id=_strategy.id if _strategy else "inactive",
        host=flow.request.pretty_host,
        method=flow.request.method,
        path=_safe_path(flow.request.path),
        scheme=flow.request.scheme,
        port=flow.request.port,
        status_code=response.status_code if response else None,
        content_type=(
            (response.headers.get("content-type") or "").split(";", 1)[0][:96]
            if response else None
        ),
        http_version=(
            response.http_version if response else flow.request.http_version
        ),
    )


def requestheaders(flow: http.HTTPFlow) -> None:
    flow.request.stream = True
    if not _matches(flow.request.pretty_host):
        return

    context = _context(flow)
    if _strategy:
        _strategy.on_request_headers(context)
    _emit(
        "http_request",
        host=context.host,
        method=context.method,
        path=context.path,
        http_version=context.http_version,
    )


def responseheaders(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        return
    flow.response.stream = True
    if not _matches(flow.request.pretty_host):
        return

    context = _context(flow, include_response=True)
    if _strategy:
        _strategy.on_response_headers(context)
    _emit(
        "http_response",
        host=context.host,
        method=context.method,
        path=context.path,
        status_code=context.status_code,
        content_type=context.content_type,
        http_version=context.http_version,
    )


def request(flow: http.HTTPFlow) -> None:
    if _matches(flow.request.pretty_host) and _strategy:
        _strategy.on_request(_context(flow))


def response(flow: http.HTTPFlow) -> None:
    if flow.response is not None and _matches(flow.request.pretty_host) and _strategy:
        _strategy.on_response(_context(flow, include_response=True))


def _decode_alpn(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace")
    return str(value)


def tls_clienthello(data: tls.ClientHelloData) -> None:
    sni = data.client_hello.sni
    if not _matches(sni):
        # Traffic outside the selected integration passes through without TLS
        # interception, keeping the application scope declarative.
        data.ignore_connection = True
        return
    _emit(
        "tls_clienthello",
        sni=sni,
        alpn=[
            value
            for value in (_decode_alpn(item) for item in data.client_hello.alpn_protocols)
            if value is not None
        ],
    )


def _tls_sni(data: tls.TlsData) -> str | None:
    direct = getattr(data.conn, "sni", None)
    if direct:
        return direct
    server = getattr(data.context, "server", None)
    return getattr(server, "sni", None)


def _tls_meta(data: tls.TlsData) -> dict[str, object]:
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


def tls_established_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches(sni):
        _emit("tls_established_client", sni=sni, **_tls_meta(data))


def tls_established_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches(sni):
        _emit("tls_established_server", sni=sni, **_tls_meta(data))


def tls_failed_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches(sni):
        _emit(
            "tls_failed_client",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_meta(data),
        )


def tls_failed_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches(sni):
        _emit(
            "tls_failed_server",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_meta(data),
        )
