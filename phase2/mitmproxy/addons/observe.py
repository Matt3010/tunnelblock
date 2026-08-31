import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http
from mitmproxy import tls

LOG_PATH = Path(
    os.environ.get(
        "OBSERVATION_LOG",
        "/home/mitmproxy/.mitmproxy/observations/metadata.jsonl",
    )
)
MAX_BYTES = int(os.environ.get("OBSERVATION_MAX_BYTES", str(25 * 1024 * 1024)))
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_path(raw: str) -> str:
    if not raw:
        return "/"

    try:
        parsed = urlsplit(raw)
        return parsed.path or "/"
    except ValueError:
        return "/"


def _server_address(data: tls.TlsData) -> str | None:
    server = getattr(data.context, "server", None)
    address = getattr(server, "address", None)
    if not address:
        return None

    try:
        host, port = address[0], address[1]
        return f"{host}:{port}"
    except (IndexError, TypeError):
        return str(address)


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
        "event": event,
        **{key: value for key, value in fields.items() if value is not None},
    }

    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    with _lock:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed()
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def requestheaders(flow: http.HTTPFlow) -> None:
    request = flow.request
    _emit(
        "http_request",
        host=request.pretty_host,
        method=request.method,
        path=_safe_path(request.path),
        scheme=request.scheme,
        port=request.port,
        http_version=request.http_version,
    )


def responseheaders(flow: http.HTTPFlow) -> None:
    request = flow.request
    response = flow.response
    _emit(
        "http_response",
        host=request.pretty_host,
        method=request.method,
        path=_safe_path(request.path),
        status_code=response.status_code if response else None,
        http_version=response.http_version if response else None,
    )


def tls_established_client(data: tls.TlsData) -> None:
    _emit(
        "tls_client_established",
        sni=getattr(data.conn, "sni", None),
        server=_server_address(data),
        tls_version=getattr(data.conn, "tls_version", None),
    )


def tls_failed_client(data: tls.TlsData) -> None:
    error = getattr(data.conn, "error", None)
    if error:
        error = str(error)[:400]

    _emit(
        "tls_client_failed",
        sni=getattr(data.conn, "sni", None),
        server=_server_address(data),
        error=error,
    )


if __name__ == "__main__":
    assert _safe_path("/watch?v=secret&token=hidden") == "/watch"
    assert _safe_path("https://example.test/a/b?q=private") == "/a/b"
