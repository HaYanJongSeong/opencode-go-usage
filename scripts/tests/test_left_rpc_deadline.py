# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: python -m unittest discover -s ~/.config/opencode/scripts/tests -p 'test_left_rpc*.py' -v
"""Main-thread hard deadline, fallback budget, and alarm restoration."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

from test_left_rpc_http import RPC, register, sandbox, service


class DeadlineTests(unittest.TestCase):
    def test_interrupts_slow_drip_headers_and_bodies_before_fallback(self) -> None:
        for method in ("GET", "POST"):
            for headers in (True, False):
                with self.subTest(method=method, headers=headers), sandbox() as root, service() as wire:
                    (wire.header_drip if headers else wire.body_drip).add(method)
                    register(root, wire)
                    with patch.object(RPC, "_SECONDS", 0.2), patch.object(RPC.subprocess, "run") as cli:
                        started = time.monotonic()

                        with self.assertRaises(RPC.RPCError):
                            RPC.read_usage()

                        self.assertLess(time.monotonic() - started, 1)
                        self.assertEqual(wire.requests[-1][0], method)
                        cli.assert_not_called()

    def test_enforces_default_thirty_second_limit_despite_continuous_body_bytes(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            wire.body_drip.add("GET")
            register(root, wire)
            started = time.monotonic()

            with self.assertRaises(RPC.RPCError):
                RPC.read_usage()

            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 29.5)
            self.assertLess(elapsed, 31.5)
            self.assertEqual([row[0] for row in wire.requests], ["GET"])
            cli.assert_not_called()

    def test_gives_fallback_only_the_budget_left_after_metadata(self) -> None:
        with sandbox() as root, service() as wire:
            wire.version, wire.delay["GET"] = "2.0.23", 0.25
            register(root, wire)
            fake = root / "opencode"
            invoked = root / "invoked"
            fake.write_text(f"#!{sys.executable}\nimport signal\nfrom pathlib import Path\n"
                            f"Path({str(invoked)!r}).write_text('1')\nsignal.pause()\n")
            fake.chmod(0o700)
            with (patch.dict(os.environ, {"PATH": str(root) + os.pathsep + os.environ["PATH"]}),
                  patch.object(RPC, "_SECONDS", 0.6),
                  patch.object(RPC.subprocess, "run", wraps=subprocess.run) as cli):
                started = time.monotonic()

                with self.assertRaises(RPC.RPCError):
                    RPC.read_usage()

                self.assertLess(time.monotonic() - started, 1.5)
                self.assertLess(cli.call_args.kwargs["timeout"], 0.4)
                self.assertEqual(cli.call_count, 1)
                self.assertEqual(invoked.read_text(), "1")
                self.assertEqual([row[0] for row in wire.requests], ["GET"])

    def test_restores_handler_and_periodic_timer_on_success_failure_and_cancel(self) -> None:
        for outcome in ("success", "failure", "cancel", "deadline"):
            with self.subTest(outcome=outcome), sandbox() as root, service() as wire:
                register(root, wire)
                if outcome == "failure":
                    wire.status["POST"] = 500
                if outcome == "deadline":
                    wire.header_drip.add("POST")
                old_timer = signal.setitimer(signal.ITIMER_REAL, 0)
                old_handler = signal.getsignal(signal.SIGALRM)

                def previous_alarm(_signum, _frame) -> None:
                    self.fail("The preserved alarm fired early")

                try:
                    signal.signal(signal.SIGALRM, previous_alarm)
                    signal.setitimer(signal.ITIMER_REAL, 5, 7)
                    started = time.monotonic()
                    with patch.object(RPC, "_SECONDS", 0.2):

                        if outcome == "cancel":
                            with patch.object(RPC.http.client.HTTPConnection, "connect", side_effect=KeyboardInterrupt):
                                with self.assertRaises(KeyboardInterrupt):
                                    RPC.read_usage()
                        elif outcome in ("failure", "deadline"):
                            with self.assertRaises(RPC.RPCError):
                                RPC.read_usage()
                        else:
                            self.assertEqual(RPC.read_usage(), wire.output.decode())

                    remaining, interval = signal.getitimer(signal.ITIMER_REAL)
                    self.assertIs(signal.getsignal(signal.SIGALRM), previous_alarm)
                    self.assertAlmostEqual(remaining, 5 - (time.monotonic() - started), delta=0.05)
                    self.assertEqual(interval, 7)
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, old_handler)
                    signal.setitimer(signal.ITIMER_REAL, *old_timer)

    def test_refuses_fallback_when_metadata_exhausts_budget(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            wire.version, wire.delay["GET"] = "2.0.23", 0.4
            register(root, wire)
            with patch.object(RPC, "_SECONDS", 0.2):

                with self.assertRaises(RPC.RPCError):
                    RPC.read_usage()

                self.assertEqual([row[0] for row in wire.requests], ["GET"])
                cli.assert_not_called()

    def test_honors_earlier_existing_alarm_without_post_or_cli(self) -> None:
        with sandbox() as root, service() as wire, patch.object(RPC.subprocess, "run") as cli:
            wire.header_drip.add("GET")
            register(root, wire)
            fired = threading.Event()
            old_handler = signal.getsignal(signal.SIGALRM)
            old_timer = signal.setitimer(signal.ITIMER_REAL, 0)

            def previous_alarm(_signum, _frame) -> None:
                fired.set()

            try:
                signal.signal(signal.SIGALRM, previous_alarm)
                signal.setitimer(signal.ITIMER_REAL, 0.2)
                started = time.monotonic()

                with self.assertRaises(RPC.RPCError):
                    RPC.read_usage()

                self.assertTrue(fired.wait(0.5))
                self.assertLess(time.monotonic() - started, 1)
                self.assertIs(signal.getsignal(signal.SIGALRM), previous_alarm)
                self.assertEqual([row[0] for row in wire.requests], ["GET"])
                cli.assert_not_called()
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old_handler)
                signal.setitimer(signal.ITIMER_REAL, *old_timer)


if __name__ == "__main__":
    unittest.main()
