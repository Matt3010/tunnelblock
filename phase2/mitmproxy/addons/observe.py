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
        return parsed.path or "/"
    except ValueError:
        return "/"


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

    alpn = []
    for item in data.client_hello.alpn_protocols:
        try:
            alpn.append(item.decode("ascii", errors="replace"))
        except AttributeError:
            alpn.append(str(item))

    _emit(
        "tls_clienthello",
        sni=data.client_hello.sni,
        alpn=alpn,
    )



def _tls_sni(data: tls.TlsData) -> str | None:
    direct = getattr(data.conn, "sni", None)
    if direct:
        return direct

    server = getattr(data.context, "server", None)
    return getattr(server, "sni", None)


def tls_established_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit("tls_established_client", sni=sni)


def tls_failed_client(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit("tls_failed_client", sni=sni)


def tls_failed_server(data: tls.TlsData) -> None:
    sni = _tls_sni(data)
    if _matches_host(sni):
        _emit("tls_failed_server", sni=sni)

if __name__ == "__main__":
    assert _safe_path("/watch?v=secret&token=hidden") == "/watch"
    assert _safe_path("https://example.test/a/b?q=private") == "/a/b"
    assert _matches_host("youtubei.googleapis.com")
    assert not _matches_host("example.test")
