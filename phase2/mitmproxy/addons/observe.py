import json
import os
import re
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
HOST_SUFFIXES = tuple(
    item.strip().lower().lstrip(".")
    for item in os.environ.get(
        "OBSERVATION_HOST_SUFFIXES",
        "youtube.com,googlevideo.com,googleapis.com,ytimg.com,ggpht.com,"
        "doubleclick.net,googlesyndication.com,googleadservices.com",
    ).split(",")
    if item.strip()
)
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _matches_host(host: str | None) -> bool:
    if not host:
        return False

    normalized = host.rstrip(".").lower()
    if "*" in HOST_SUFFIXES:
        return True

    return any(
        normalized == suffix or normalized.endswith("." + suffix)
        for suffix in HOST_SUFFIXES
    )


def _safe_path(raw: str) -> str:
    if not raw:
        return "/"

    try:
        parsed = urlsplit(raw)
    except ValueError:
        return "/"

    path = parsed.path or "/"
    safe_segments = []
    segments = path.split("/")
    for index, segment in enumerate(segments):
        previous = segments[index - 1] if index else ""
        token_like = (
            len(segment) > 48
            or "=" in segment
            or (segment.count(".") >= 2 and len(segment) > 20)
            or bool(re.fullmatch(r"[A-Za-z0-9_-]{16,}", segment))
            or (previous in {"vi", "vi_webp"} and bool(re.fullmatch(r"[A-Za-z0-9_-]{8,}", segment)))
        )
        safe_segments.append("<redacted>" if token_like else segment)

    sanitized = "/".join(safe_segments)
    return sanitized[:512] or "/"


def _decode_alpn(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace")
    return str(value)


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
    # Stream payloads through unchanged so the observation addon never buffers
    # complete request bodies in memory or writes them to persistent storage.
    request.stream = True
    if not _matches_host(request.pretty_host):
        return
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
    if response is not None:
        # The same guarantee applies to response bodies.
        response.stream = True
    if not _matches_host(request.pretty_host):
        return
    _emit(
        "http_response",
        host=request.pretty_host,
        method=request.method,
        path=_safe_path(request.path),
        status_code=response.status_code if response else None,
        http_version=response.http_version if response else None,
    )


def tls_clienthello(data: tls.ClientHelloData) -> None:
    if not _matches_host(data.client_hello.sni):
        return

    alpn = [_decode_alpn(item) for item in data.client_hello.alpn_protocols]

    _emit(
        "tls_clienthello",
        sni=data.client_hello.sni,
        alpn=[item for item in alpn if item is not None],
    )


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
    # Raw library error strings can contain endpoint details. Persist only a
    # stable category that is sufficient for the pinning go/no-go test.
    error = str(getattr(data.conn, "error", "") or "").lower()
    if "unknown ca" in error or "bad certificate" in error or "certificate unknown" in error:
        return "certificate_rejected"
    if "closed" in error or "eof" in error:
        return "connection_closed_during_handshake"
    if "protocol" in error or "version" in error or "cipher" in error:
        return "tls_negotiation_failure"
    return "tls_handshake_failure"


def tls_established_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit("tls_established_client", sni=sni, **_tls_metadata(data))


def tls_established_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit("tls_established_server", sni=sni, **_tls_metadata(data))


def tls_failed_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit(
            "tls_failed_client",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_metadata(data),
        )


def tls_failed_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit(
            "tls_failed_server",
            sni=sni,
            error_category=_tls_error_category(data),
            **_tls_metadata(data),
        )

if __name__ == "__main__":
    assert _safe_path("/watch?v=secret&token=hidden") == "/watch"
    assert _safe_path("https://example.test/a/b?q=private") == "/a/b"
    assert _safe_path("/api/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF") == "/api/<redacted>"
    assert _safe_path("/vi/JdzAQSCbPN4/hq720.jpg") == "/vi/<redacted>/hq720.jpg"
    assert _matches_host("youtubei.googleapis.com")
    assert not _matches_host("example.test")
    assert _decode_alpn(b"h2") == "h2"
