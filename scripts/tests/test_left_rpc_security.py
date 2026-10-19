# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: python -m unittest discover -s ~/.config/opencode/scripts/tests -p 'test_left_rpc*.py' -v
"""Registration trust boundaries and pre-POST fallback selection."""

from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from test_left_rpc_http import RPC, register, sandbox, service

COMMAND = ["opencode", "api", "post", "/api/rpc/go-codex-quota/read", "--data", '{"input":{}}']
RESULT = subprocess.CompletedProcess(COMMAND, 0, stdout="fixture-cli-output")


class RegistrationTests(unittest.TestCase):
    def test_sanitizes_os_error_without_http_or_cli(self) -> None:
        with sandbox(), service() as wire, patch.object(RPC.subprocess, "run") as cli:
            with patch.object(RPC.os, "open", side_effect=PermissionError("fixture-only-secret")):

                with self.assertRaises(RPC.RPCError) as failure:
                    RPC.read_usage()

                self.assertNotIn("fixture-only", str(failure.exception))
                self.assertEqual(wire.requests, [])
                cli.assert_not_called()

    def test_rejects_unsafe_urls_before_http_or_cli(self) -> None:
        urls = (
            "https://127.0.0.1:80/", "HTTP://127.0.0.1:80/", "http://localhost:80/",
            "http://127.0.0.2:80/", "http://127.1:80/", "http://2130706433:80/",
            "http://0x7f000001:80/", "http://127.000.000.001:80/", "http://[::ffff:127.0.0.1]:80/",
            "http://[::1%lo]:80/", "http://127.0.0.1/", "http://127.0.0.1:0/",
            "http://127.0.0.1:65536/", "http://127.0.0.1:-1/", "http://127.0.0.1:80.0/",
            "http://opencode:fixture@127.0.0.1:80/", "http://127.0.0.1:80/path",
            "http://127.0.0.1:80//", "http://127.0.0.1:80/?", "http://127.0.0.1:80/#",
            "http://127.0.0.1:80/\x00", "http://127.0.0.1:80/\x7f",
            "http://127.0.0.1:80/\n", "\thttp://127.0.0.1:80/", "http://127.0.0.1:80\\",
        )
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            target = register(root, wire)
            for url in urls:
                with self.subTest(url=url):
                    target.write_text(json.dumps({"url": url, "pid": 4242, "version": "2.0.22"}))

                    with self.assertRaises(RPC.RPCError):
                        RPC.read_usage()

                    self.assertEqual(wire.requests, [])
                    cli.assert_not_called()

    def test_rejects_untrusted_files_before_http_or_cli(self) -> None:
        for condition in ("mode400", "mode640", "mode1600", "owner", "symlink", "directory", "fifo"):
            with self.subTest(condition=condition), sandbox() as root, service() as wire:
                target = register(root, wire)
                uid = os.getuid()
                if condition.startswith("mode"):
                    target.chmod(int(condition[4:], 8))
                if condition in ("symlink", "directory", "fifo"):
                    original = root / "original.json"
                    target.rename(original)
                    if condition == "symlink":
                        target.symlink_to(original)
                    if condition == "directory":
                        target.mkdir(mode=0o700)
                    if condition == "fifo":
                        os.mkfifo(target, 0o600)
                with (patch.object(RPC.os, "getuid", return_value=uid + (condition == "owner")),
                      patch.object(RPC.subprocess, "run") as cli):

                    with self.assertRaises(RPC.RPCError):
                        RPC.read_usage()

                    self.assertEqual(wire.requests, [])
                    cli.assert_not_called()

    def test_rejects_invalid_registration_json_before_http_or_cli(self) -> None:
        bodies = (b"fixture-only-secret", b"\xff", b"{}" + b" " * 16383, b"[]",
                  b"[" * 2000 + b"]" * 2000)
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            target = register(root, wire)
            for body in bodies:
                with self.subTest(size=len(body)):
                    target.write_bytes(body)

                    with self.assertRaises(RPC.RPCError) as failure:
                        RPC.read_usage()

                    self.assertNotIn("fixture-only", str(failure.exception))
                    self.assertEqual(wire.requests, [])
                    cli.assert_not_called()

    def test_rejects_invalid_fields_before_http_or_cli(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            target = register(root, wire)
            for key, value in (("url", None), ("pid", True), ("pid", 0), ("pid", "4242"),
                                ("version", 22), ("version", ""), ("version", None),
                                ("password", None), ("password", 123)):
                with self.subTest(key=key, value=value):
                    data = {"url": wire.url, "pid": wire.pid, "version": wire.version}
                    data[key] = value
                    target.write_text(json.dumps(data))

                    with self.assertRaises(RPC.RPCError):
                        RPC.read_usage()

                    self.assertEqual(wire.requests, [])
                    cli.assert_not_called()

    def test_uses_opened_fd_when_registration_path_is_replaced(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            target = register(root, wire)
            original_open, original_fstat = os.open, os.fstat
            opened = []

            def replace_after_open(path: Path, flags: int) -> int:
                fd = original_open(path, flags)
                opened.append((fd, flags, os.get_inheritable(fd)))
                target.rename(root / "original.json")
                target.write_text("fixture-only-invalid-replacement")
                return fd

            with (patch.object(RPC.os, "open", side_effect=replace_after_open),
                  patch.object(RPC.os, "fstat", wraps=original_fstat) as fstat):

                raw = RPC.read_usage()

                fstat.assert_called_once_with(opened[0][0])
            self.assertEqual(json.loads(raw)["output"]["value"], 17)
            self.assertEqual(opened[0][1] & (os.O_NOFOLLOW | os.O_CLOEXEC), os.O_NOFOLLOW | os.O_CLOEXEC)
            self.assertFalse(opened[0][2])
            self.assertEqual(len(opened), 1)
            cli.assert_not_called()

    def test_fails_closed_when_live_identity_differs_even_for_unsupported_version(self) -> None:
        for version in ("2.0.22", "2.0.23"):
            for info in ({"pid": 4243, "version": version}, {"pid": 4242, "version": "2.0.21"},
                         {"pid": True, "version": version}, [], {}):
                with self.subTest(version=version, info=info), sandbox() as root, service() as wire:
                    wire.version, wire.info = version, json.dumps(info).encode()
                    register(root, wire)
                    with patch.object(RPC.subprocess, "run") as cli:

                        with self.assertRaises(RPC.RPCError):
                            RPC.read_usage()

                        self.assertEqual([row[0] for row in wire.requests], ["GET"])
                        cli.assert_not_called()


class FallbackTests(unittest.TestCase):
    def test_uses_cli_once_when_trusted_registration_omits_version(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run", return_value=RESULT) as cli:
            target = register(root, wire)
            data = json.loads(target.read_text())
            del data["version"]
            target.write_text(json.dumps(data))

            raw = RPC.read_usage()

            self.assertEqual(raw, "fixture-cli-output")
            cli.assert_called_once()
            self.assertEqual(cli.call_args.args, (COMMAND,))
            self.assertEqual(wire.requests, [])

    def test_preserves_exact_cli_when_default_registration_is_missing(self) -> None:
        with sandbox(), patch.object(RPC.subprocess, "run", return_value=RESULT) as cli:
            os.environ.pop("XDG_STATE_HOME")

            raw = RPC.read_usage()

            self.assertEqual(raw, "fixture-cli-output")
            self.assertEqual(cli.call_count, 1)
            self.assertEqual(cli.call_args.args, (COMMAND,))
            self.assertGreater(cli.call_args.kwargs["timeout"], 0)
            self.assertLessEqual(cli.call_args.kwargs["timeout"], 30)

    def test_uses_cli_once_when_verified_socket_refuses_connection(self) -> None:
        with sandbox() as root, patch.object(RPC.subprocess, "run", return_value=RESULT) as cli:
            with service() as wire:
                register(root, wire)

            raw = RPC.read_usage()

            self.assertEqual(raw, "fixture-cli-output")
            self.assertEqual(wire.requests, [])
            self.assertEqual(cli.call_count, 1)

    def test_uses_cli_before_post_when_verified_version_is_unsupported(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run", return_value=RESULT) as cli:
            wire.version = "2.0.23"
            register(root, wire)

            raw = RPC.read_usage()

            self.assertEqual(raw, "fixture-cli-output")
            self.assertEqual([row[0] for row in wire.requests], ["GET"])
            self.assertEqual(cli.call_count, 1)

    def test_preserves_explicit_cli_auth_without_bypassing_registration_checks(self) -> None:
        for name in ("OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"):
            for trusted in (True, False):
                with self.subTest(name=name, trusted=trusted), sandbox() as root, service() as wire:
                    target = register(root, wire)
                    if not trusted:
                        target.chmod(0o644)
                    with (patch.dict(os.environ, {name: "fixture-only-env"}),
                          patch.object(RPC.subprocess, "run", return_value=RESULT) as cli):

                        if trusted:
                            self.assertEqual(RPC.read_usage(), "fixture-cli-output")
                        else:
                            with self.assertRaises(RPC.RPCError):
                                RPC.read_usage()

                        self.assertEqual(wire.requests, [])
                        self.assertEqual(cli.call_count, int(trusted))


if __name__ == "__main__":
    unittest.main()
