# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: python -m unittest discover -s ~/.config/opencode/scripts/tests -p 'test_left_rpc*.py' -v
"""Wire-level quota transport tests and isolated loopback fixtures."""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

with patch.object(sys, "path", [str(Path(__file__).resolve().parents[1]), *sys.path]):
    import left_rpc as RPC

TMP = Path("/data/data/com.termux/files/usr/tmp/opencode")


class LocalService:
    """Mutable response controls and captured requests for a single test server."""

    def __init__(self) -> None:
        self.pid, self.version = 4242, "2.0.22"
        self.url = ""
        self.password: str | None = None
        self.info: bytes | None = None
        self.output = b'{"output":{"value":17}}'
        self.status = {"GET": 200, "POST": 200}
        self.length: dict[str, int] = {}
        self.unknown_length: set[str] = set()
        self.header_drip: set[str] = set()
        self.body_drip: set[str] = set()
        self.delay: dict[str, float] = {}
        self.requests: list[tuple[str, str, str | None, bytes]] = []
        self.arrived = {method: threading.Event() for method in ("GET", "POST")}
        self.stop = threading.Event()


@contextmanager
def sandbox() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="left-rpc-", dir=TMP) as directory:
        root = Path(directory)
        with patch.dict(os.environ, {"HOME": str(root), "XDG_STATE_HOME": str(root / "state")}):
            os.environ.pop("OPENCODE_PASSWORD", None)
            os.environ.pop("OPENCODE_SERVER_PASSWORD", None)
            yield root


def register(root: Path, service: LocalService) -> Path:
    target = root / "state/opencode/service.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    data = {"url": service.url, "pid": service.pid, "version": service.version, "id": "ignored"}
    if service.password is not None:
        data["password"] = service.password
    target.write_text(json.dumps(data), encoding="utf-8")
    target.chmod(0o600)
    return target


@contextmanager
def service(host: str = "127.0.0.1") -> Iterator[LocalService]:
    wire = LocalService()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: str) -> None:
            return None

        def handle(self) -> None:
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        def do_GET(self) -> None:
            self.reply()

        def do_POST(self) -> None:
            self.reply()

        def reply(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            wire.requests.append((self.command, self.path, self.headers.get("Authorization"), body))
            wire.arrived[self.command].set()
            try:
                if self.command in wire.header_drip:
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Drip: ")
                    while not wire.stop.wait(0.02):
                        self.wfile.write(b"x")
                    return
                wire.stop.wait(wire.delay.get(self.command, 0))
                info = wire.info if wire.info is not None else json.dumps({
                    "pid": wire.pid, "version": wire.version,
                }).encode()
                content = {"GET": info, "POST": wire.output}[self.command]
                self.send_response(wire.status[self.command])
                self.send_header("Location", "/redirect-must-not-be-followed")
                if self.command in wire.unknown_length:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                else:
                    length = 16000 if self.command in wire.body_drip else len(content)
                    self.send_header("Content-Length", str(wire.length.get(self.command, length)))
                self.end_headers()
                if self.command in wire.body_drip:
                    while not wire.stop.wait(0.02):
                        self.wfile.write(b" ")
                else:
                    self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    class IPv6Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6

    server_type = IPv6Server if host == "::1" else ThreadingHTTPServer
    with server_type((host, 0), Handler) as server:
        wire.url = f"http://{'[::1]' if host == '::1' else host}:{server.server_port}/"
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            yield wire
        finally:
            wire.stop.set()
            server.shutdown()
            thread.join(timeout=2)


class HTTPTests(unittest.TestCase):
    def test_posts_exact_input_once_when_identity_matches(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            register(root, wire)

            raw = RPC.read_usage()

            self.assertEqual(json.loads(raw), {"output": {"value": 17}})
            self.assertEqual(wire.requests, [
                ("GET", "/api/info", None, b""),
                ("POST", "/api/rpc/go-codex-quota/read", None, b'{"input":{}}'),
            ])
            cli.assert_not_called()

    def test_sends_basic_on_both_requests_when_password_is_present(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            wire.password = "fixture-only-password"
            wire.url = wire.url.rstrip("/")
            register(root, wire)

            raw = RPC.read_usage()

            expected = "Basic " + base64.b64encode(b"opencode:fixture-only-password").decode()
            self.assertEqual([row[2] for row in wire.requests], [expected, expected])
            self.assertEqual(json.loads(raw)["output"]["value"], 17)
            cli.assert_not_called()

    def test_connects_directly_when_ipv6_loopback_is_registered(self) -> None:
        with sandbox() as root, service("::1") as wire, patch.object(RPC.subprocess, "run") as cli:
            register(root, wire)

            raw = RPC.read_usage()

            self.assertEqual(json.loads(raw)["output"]["value"], 17)
            self.assertEqual([row[0] for row in wire.requests], ["GET", "POST"])
            cli.assert_not_called()

    def test_ignores_proxy_environment_when_loopback_is_verified(self) -> None:
        with sandbox() as root, service() as wire, patch.dict(os.environ, {
            "http_proxy": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1",
            "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": "",
        }):
            register(root, wire)

            raw = RPC.read_usage()

            self.assertEqual(json.loads(raw)["output"]["value"], 17)
            self.assertEqual(len(wire.requests), 2)

    def test_fails_closed_when_http_redirects_or_errors(self) -> None:
        for method in ("GET", "POST"):
            for status in (99, 301, 302, 307, 308, 401, 403, 500):
                with self.subTest(method=method, status=status), sandbox() as root, service() as wire:
                    wire.status[method] = status
                    register(root, wire)
                    with patch.object(RPC.subprocess, "run") as cli:

                        with self.assertRaises(RPC.RPCError):
                            RPC.read_usage()

                        self.assertEqual([row[0] for row in wire.requests],
                                         ["GET"] if method == "GET" else ["GET", "POST"])
                        cli.assert_not_called()

    def test_sanitizes_failure_when_json_or_encoding_is_invalid(self) -> None:
        for method in ("GET", "POST"):
            for body in (b"fixture-only-invalid-json", b"\xff", b"[" * 2000 + b"]" * 1999):
                with self.subTest(method=method, size=len(body)), sandbox() as root, service() as wire:
                    wire.info, wire.output = (body, wire.output) if method == "GET" else (None, body)
                    register(root, wire)
                    with patch.object(RPC.subprocess, "run") as cli:

                        with self.assertRaises(RPC.RPCError) as failure:
                            RPC.read_usage()

                        self.assertNotIn("fixture-only", str(failure.exception))
                        self.assertLessEqual(len(wire.requests), 2)
                        cli.assert_not_called()

    def test_rejects_large_responses_with_or_without_content_length(self) -> None:
        for method, limit in (("GET", 16384), ("POST", 1048576)):
            for declared in (True, False):
                with self.subTest(method=method, declared=declared), sandbox() as root, service() as wire:
                    if declared:
                        wire.length[method] = limit + 1
                    else:
                        wire.unknown_length.add(method)
                        wire.info, wire.output = ((b" " * (limit + 1), wire.output) if method == "GET"
                                                  else (None, b" " * (limit + 1)))
                    register(root, wire)
                    with patch.object(RPC.subprocess, "run") as cli:

                        with self.assertRaises(RPC.RPCError):
                            RPC.read_usage()

                        self.assertEqual(len(wire.requests), 1 if method == "GET" else 2)
                        cli.assert_not_called()


if __name__ == "__main__":
    unittest.main()
