import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from mitmproxy import http
from mitmproxy import tls

from protobuf_scan import DEFAULT_BACKTRACK_BYTES, ProtobufStreamScanner
from ump_diagnostics import (
    ByteCounter,
    inspect_onesie_config,
)
from ump_filter import disable_preroll_request

LOG_PATH = Path(
    os.environ.get(
        "OBSERVATION_LOG",
        "/home/mitmproxy/.mitmproxy/observations/metadata.jsonl",
    )
)
UMP_RESULT_PATH = Path(
    os.environ.get("YOUTUBE_UMP_RESULT", "/tmp/youtube-preroll-result")
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
PROTOBUF_BACKTRACK_BYTES = int(
    os.environ.get("PROTOBUF_BACKTRACK_BYTES", str(DEFAULT_BACKTRACK_BYTES))
)
_lock = threading.Lock()
LOGGING_ENABLED = (
    os.environ.get("OBSERVATION_LOG_ENABLED", "true").strip().lower()
    in {"1", "true", "yes", "on"}
)
UMP_DIAGNOSTICS_ENABLED = (
    os.environ.get("UMP_DIAGNOSTICS_ENABLED", "false")
    .strip().lower() in {"1", "true", "yes", "on"}
)
UMP_FILTER_ENABLED = (
    os.environ.get("YOUTUBE_UMP_FILTER_ENABLED", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)
OBSERVATION_SESSION = os.environ.get("OBSERVATION_SESSION", "").strip()
_filter_spent = False
_filter_reserved = False


def _set_filter_result(result: str) -> None:
    if result not in {"pending", "applied", "absent", "already_false", "rejected"}:
        result = "rejected"
    try:
        UMP_RESULT_PATH.write_text(result + "\n", encoding="ascii")
    except OSError:
        pass


if UMP_FILTER_ENABLED:
    _set_filter_result("pending")


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
            or (
                previous in {"vi", "vi_webp"}
                and bool(re.fullmatch(r"[A-Za-z0-9_-]{8,}", segment))
            )
        )
        safe_segments.append("<redacted>" if token_like else segment)

    sanitized = "/".join(safe_segments)
    return sanitized[:512] or "/"


def _is_inner_tube_request(host: str | None, path: str) -> bool:
    return (
        (host or "").rstrip(".").lower() == "youtubei.googleapis.com"
        and path.startswith("/youtubei/v1/")
    )


def _is_protobuf_content_type(content_type: str | None) -> bool:
    return "protobuf" in (content_type or "").lower()


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
    if not LOGGING_ENABLED:
        return
    record = {
        "ts": _now(),
        "event": event,
        **({"session": OBSERVATION_SESSION} if OBSERVATION_SESSION else {}),
        **{key: value for key, value in fields.items() if value is not None},
    }

    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    with _lock:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed()
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def _emit_protobuf_scan(
    host: str,
    path: str,
    scanner: ProtobufStreamScanner,
) -> None:
    result = scanner.result()
    _emit(
        "protobuf_response_scan",
        host=host,
        path=path,
        body_bytes=result["body_bytes"],
        markers=result["markers"],
        markers_without_candidate=result["markers_without_candidate"],
        candidate_fields=result["candidate_fields"],
        nearest_candidate_fields=result["nearest_candidate_fields"],
        nearest_candidate_distance_bytes=result[
            "nearest_candidate_distance_bytes"
        ],
        nearest_candidate_fields_by_marker=result[
            "nearest_candidate_fields_by_marker"
        ],
        nearest_candidate_distance_bytes_by_marker=result[
            "nearest_candidate_distance_bytes_by_marker"
        ],
        ancestor_chains_by_marker=result["ancestor_chains_by_marker"],
        shared_ancestor_candidates=result["shared_ancestor_candidates"],
        blocking_enabled=False,
    )


def _is_initplayback(host: str | None, path: str) -> bool:
    normalized = (host or "").rstrip(".").lower()
    return normalized.endswith(".googlevideo.com") and path == "/initplayback"


def _reserve_filter() -> bool:
    global _filter_reserved
    with _lock:
        if _filter_spent or _filter_reserved:
            return False
        _filter_reserved = True
        return True


def _finish_filter(success: bool) -> None:
    global _filter_reserved, _filter_spent
    with _lock:
        _filter_reserved = False
        if success:
            _filter_spent = True


def requestheaders(flow: http.HTTPFlow) -> None:
    request = flow.request
    request.stream = True
    if not _matches_host(request.pretty_host):
        return

    path = _safe_path(request.path)
    if UMP_FILTER_ENABLED and _is_initplayback(request.pretty_host, path):
        request.stream = False
        flow.metadata["phase2_ump_request_buffered"] = True
    if UMP_DIAGNOSTICS_ENABLED and _is_initplayback(request.pretty_host, path):
        try:
            query_parameter_count = len(
                parse_qsl(
                    urlsplit(request.path).query,
                    keep_blank_values=True,
                )
            )
        except ValueError:
            query_parameter_count = 0
        _emit(
            "ump_initplayback_request",
            host=request.pretty_host,
            path=path,
            method=request.method,
            query_parameter_count=query_parameter_count,
        )
    if _is_inner_tube_request(request.pretty_host, path):
        # Ask YouTube for an uncompressed InnerTube response so the streaming
        # scanner can inspect protobuf bytes without persisting the payload.
        request.anticomp()

    _emit(
        "http_request",
        host=request.pretty_host,
        method=request.method,
        path=path,
        scheme=request.scheme,
        port=request.port,
        http_version=request.http_version,
    )


def request(flow: http.HTTPFlow) -> None:
    if not flow.metadata.get("phase2_ump_request_buffered"):
        return
    body = flow.request.get_content(strict=False) or b""
    if not _reserve_filter():
        return
    filtered, changes, result = disable_preroll_request(body)
    _set_filter_result(result)
    if changes:
        flow.request.set_content(filtered)
        _finish_filter(True)
    else:
        _finish_filter(False)


def responseheaders(flow: http.HTTPFlow) -> None:
    request = flow.request
    response = flow.response
    if response is None:
        return

    if not _matches_host(request.pretty_host):
        response.stream = True
        return

    path = _safe_path(request.path)
    _emit(
        "http_response",
        host=request.pretty_host,
        method=request.method,
        path=path,
        status_code=response.status_code,
        http_version=response.http_version,
    )

    if UMP_DIAGNOSTICS_ENABLED and _is_initplayback(request.pretty_host, path):
        counter = ByteCounter()
        completed = False

        def count_stream(chunk: bytes) -> bytes:
            nonlocal completed
            if chunk:
                return counter.feed(chunk)
            if not completed:
                completed = True
                _emit(
                    "ump_initplayback_response",
                    host=request.pretty_host,
                    path=path,
                    status_code=response.status_code,
                    body_bytes=counter.body_bytes,
                    chunks=counter.chunks,
                    content_type=(
                        response.headers.get("content-type") or ""
                    ).split(";", 1)[0][:80],
                )
            return chunk

        response.stream = count_stream
        return

    if (
        not _is_inner_tube_request(request.pretty_host, path)
        or not _is_protobuf_content_type(response.headers.get("content-type"))
    ):
        response.stream = True
        return

    if response.headers.get("content-encoding", "identity").lower() not in {
        "",
        "identity",
    }:
        _emit(
            "protobuf_response_scan_skipped",
            host=request.pretty_host,
            path=path,
            reason="content_encoded",
        )
        response.stream = True
        return

    if (
        UMP_DIAGNOSTICS_ENABLED
        and path in {"/youtubei/v1/config", "/youtubei/v1/log_event"}
    ):
        # Config is bounded and buffered only during an explicit diagnostic
        # session. Secret key bytes are inspected in memory and never logged.
        flow.metadata["phase2_protobuf_buffered"] = True
        response.stream = False
        return


    if not LOGGING_ENABLED:
        response.stream = True
        return

    scanner = ProtobufStreamScanner(backtrack_bytes=PROTOBUF_BACKTRACK_BYTES)
    completed = False

    def scan_stream(chunk: bytes) -> bytes:
        nonlocal completed
        if chunk:
            scanner.feed(chunk)
        elif not completed:
            completed = True
            _emit_protobuf_scan(request.pretty_host, path, scanner)
        return chunk

    response.stream = scan_stream


def response(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        return

    if not flow.metadata.get("phase2_protobuf_buffered"):
        return

    request = flow.request
    response = flow.response
    path = _safe_path(request.path)
    body = response.get_content(strict=False) or b""

    if LOGGING_ENABLED:
        scanner = ProtobufStreamScanner(
            backtrack_bytes=PROTOBUF_BACKTRACK_BYTES
        )
        scanner.feed(body)
        _emit_protobuf_scan(request.pretty_host, path, scanner)

    if path in {"/youtubei/v1/config", "/youtubei/v1/log_event"}:
        _emit("onesie_config", host=request.pretty_host, path=path,
              body_bytes=len(body), **inspect_onesie_config(body))


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
    assert (
        _safe_path("/api/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF")
        == "/api/<redacted>"
    )
    assert (
        _safe_path("/vi/JdzAQSCbPN4/hq720.jpg")
        == "/vi/<redacted>/hq720.jpg"
    )
    assert _matches_host("youtubei.googleapis.com")
    assert _is_inner_tube_request(
        "youtubei.googleapis.com", "/youtubei/v1/browse"
    )
    assert not _is_inner_tube_request(
        "www.youtube.com", "/youtubei/v1/browse"
    )
    assert _is_protobuf_content_type("application/x-protobuf")
    assert _decode_alpn(b"h2") == "h2"
