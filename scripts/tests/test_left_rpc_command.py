# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: python -m unittest discover -s ~/.config/opencode/scripts/tests -p 'test_left_rpc*.py' -v
"""Exercise left's real command surface using only a synthetic local service."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import unittest

from test_left import SCRIPT, snapshot
from test_left_rpc_http import register, sandbox, service


class CommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = self.enterContext(sandbox())
        self.calls = self.root / "cli-calls"
        fake = self.root / "opencode"
        fake.write_text(f"#!{sys.executable}\nfrom pathlib import Path\n"
                        f"Path({str(self.calls)!r}).write_text('unexpected CLI')\nraise SystemExit(97)\n")
        fake.chmod(0o700)
        os.environ["PATH"] = str(self.root) + os.pathsep + os.environ["PATH"]
        self.context = self.root / "left-snapshot.md"

    def run_left(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                              encoding="utf-8", check=False, timeout=5)

    def test_prints_three_lines_and_refreshes_context_without_cli_or_model(self) -> None:
        with service() as wire:
            wire.output, wire.password = snapshot().encode(), "fixture-only-password"
            register(self.root, wire)

            result = self.run_left()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(result.stdout.splitlines()), 3)
            self.assertIn("주간 55.25%", result.stdout)
            self.assertEqual(result.stderr, "")
            self.assertIn(result.stdout.strip(), self.context.read_text())
            self.assertEqual(self.context.stat().st_mode & 0o777, 0o600)
            self.assertEqual([(row[0], row[1]) for row in wire.requests],
                             [("GET", "/api/info"), ("POST", "/api/rpc/go-codex-quota/read")])
            self.assertNotIn("fixture-only-password", result.stdout + self.context.read_text())
            self.assertFalse(self.calls.exists())

    def test_invalidates_snapshot_without_cli_retry_when_post_fails(self) -> None:
        with service() as wire:
            wire.status["POST"], wire.output = 500, b"fixture-only-secret"
            register(self.root, wire)
            self.context.write_text("previous quota 99%")

            result = self.run_left()

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertTrue(result.stderr)
            self.assertNotIn("%", self.context.read_text())
            self.assertNotIn("fixture-only", result.stderr + self.context.read_text())
            self.assertEqual([row[0] for row in wire.requests], ["GET", "POST"])
            self.assertFalse(self.calls.exists())

    def test_preserves_codex_without_shell_failure_when_go_has_a_partial_error(self) -> None:
        with service() as wire:
            data = json.loads(snapshot())
            data["output"]["go"] = {"error": {"code": "unauthorized", "message": "fixture-only-secret"}}
            wire.output = json.dumps(data).encode()
            register(self.root, wire)

            result = self.run_left()

            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(result.stdout.splitlines()), 3)
            self.assertIn("401/403", result.stdout)
            self.assertIn("Codex 남음: 7d 57%", result.stdout)
            self.assertNotIn("fixture-only", result.stdout + result.stderr + self.context.read_text())
            self.assertFalse(self.calls.exists())

    def test_returns_130_and_invalidates_context_when_sigint_interrupts_http(self) -> None:
        with service() as wire:
            wire.header_drip.add("POST")
            register(self.root, wire)
            self.context.write_text("previous quota 99%")
            with subprocess.Popen([sys.executable, str(SCRIPT)], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8") as process:
                arrived = wire.arrived["POST"].wait(5)

                process.send_signal(signal.SIGINT)
                output, error = process.communicate(timeout=5)

            self.assertTrue(arrived)
            self.assertEqual(process.returncode, 130)
            self.assertEqual(output, "")
            self.assertTrue(error)
            self.assertNotIn("%", self.context.read_text())
            self.assertFalse(self.calls.exists())


if __name__ == "__main__":
    unittest.main()
