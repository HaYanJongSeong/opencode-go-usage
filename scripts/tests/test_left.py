#!/data/data/com.termux/files/usr/bin/python
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: python -m unittest discover -s ~/.config/opencode/scripts/tests -p test_left.py -v
from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from typing import Final
from unittest.mock import patch

SCRIPT: Final = Path(__file__).resolve().parents[1] / "left.py"
SPEC = importlib.util.spec_from_file_location("left_usage", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LEFT = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(SCRIPT.parent), *sys.path]):
    SPEC.loader.exec_module(LEFT)
TMP: Final = Path("/data/data/com.termux/files/usr/tmp/opencode")


def snapshot() -> str:
    return json.dumps({"output": {
        "checkedAt": "2026-10-19T00:00:00Z",
        "go": {"windows": [
            {"name": "5h", "remainingPercent": 0, "resetsAt": None},
            {"name": "주간", "remainingPercent": 55.25, "resetsAt": "2026-10-21T17:00:00Z"},
            {"name": "월간", "remainingPercent": 100.0, "resetsAt": "2026-10-22T21:00:00Z"},
        ]},
        "codex": {"windows": [{"name": "7d", "remainingPercent": 57, "resetsAt": "2026-10-25T22:00:00Z"}]},
    }}, ensure_ascii=False)


class FormatTests(unittest.TestCase):
    def test_live_percentages_when_snapshot_is_complete(self) -> None:
        raw = snapshot()

        output, status = LEFT.format_usage(raw)

        self.assertEqual(status, 0)
        self.assertEqual(output.splitlines(), [
            "확인: 10.19 09:00 GMT+9",
            "Go 남음: 5h 0% (리셋 시각 미제공) · 주간 55.25% (리셋 약 2일 17시간 후) · 월간 100% (리셋 약 3일 21시간 후)",
            "Codex 남음: 7d 57% (리셋 약 6일 22시간 후)",
        ])

    def test_formats_reset_boundaries_using_snapshot_time(self) -> None:
        cases = (
            (None, "리셋 시각 미제공"),
            ("2026-10-18T23:59:59Z", "리셋 시각 도달"),
            ("2026-10-19T00:00:00Z", "리셋 시각 도달"),
            ("2026-10-19T00:00:59Z", "리셋 1분 이내"),
            ("2026-10-19T00:01:00Z", "리셋 약 1분 후"),
            ("2026-10-19T00:01:01Z", "리셋 약 2분 후"),
            ("2026-10-19T09:01:01+09:00", "리셋 약 2분 후"),
            ("2026-10-19T01:01:01Z", "리셋 약 1시간 2분 후"),
            ("2026-10-20T00:00:00Z", "리셋 약 1일 후"),
            ("2026-10-20T01:00:01Z", "리셋 약 1일 1시간 후"),
        )
        for reset, expected in cases:
            with self.subTest(reset=reset):
                data = json.loads(snapshot())
                data["output"]["go"]["windows"][0]["resetsAt"] = reset

                output, _ = LEFT.format_usage(json.dumps(data))

                self.assertIn(f"5h 0% ({expected})", output)

    def test_rejects_reset_when_timestamp_is_invalid(self) -> None:
        for reset in (True, 123, "", "fixture-secret", "2026-10-20T00:00:00"):
            with self.subTest(reset=reset):
                data = json.loads(snapshot())
                data["output"]["go"]["windows"][0]["resetsAt"] = reset

                with self.assertRaises(ValueError):
                    LEFT.format_usage(json.dumps(data))

    def test_rejects_window_when_reset_field_is_missing(self) -> None:
        data = json.loads(snapshot())
        del data["output"]["go"]["windows"][0]["resetsAt"]

        with self.assertRaises(KeyError):
            LEFT.format_usage(json.dumps(data))

    def test_rejects_percentages_when_not_finite_numbers_in_range(self) -> None:
        for value in (None, True, "25", -1, 101, float("nan"), float("inf")):
            with self.subTest(value=value):
                data = json.loads(snapshot())
                data["output"]["go"]["windows"][0]["remainingPercent"] = value

                with self.assertRaises(LEFT.InvalidQuotaResponse):
                    LEFT.format_usage(json.dumps(data))

    def test_preserves_codex_when_go_authentication_fails(self) -> None:
        data = json.loads(snapshot())
        data["output"]["go"] = {"error": {"code": "unauthorized", "message": "fixture-secret"}}

        output, status = LEFT.format_usage(json.dumps(data))

        self.assertEqual(status, 1)
        self.assertIn("Codex 남음: 7d 57%", output)
        self.assertIn("401/403", output)
        self.assertNotIn("fixture-secret", output)
        self.assertNotIn("Go 남음", output)

    def test_rejects_empty_windows_when_quota_is_missing(self) -> None:
        data = json.loads(snapshot())
        data["output"]["go"]["windows"] = []

        with self.assertRaises(LEFT.InvalidQuotaResponse):
            LEFT.format_usage(json.dumps(data))

    def test_rejects_terminal_controls_when_window_name_is_unsafe(self) -> None:
        data = json.loads(snapshot())
        data["output"]["go"]["windows"][0]["name"] = "5h\x1b[31m"

        with self.assertRaises(LEFT.InvalidQuotaResponse):
            LEFT.format_usage(json.dumps(data))

    def test_rejects_timestamp_when_timezone_is_missing(self) -> None:
        data = json.loads(snapshot())
        data["output"]["checkedAt"] = "2026-10-19T00:00:00"

        with self.assertRaises(LEFT.InvalidQuotaResponse):
            LEFT.format_usage(json.dumps(data))

    def test_rejects_timestamp_when_it_is_not_text(self) -> None:
        data = json.loads(snapshot())
        data["output"]["checkedAt"] = None

        with self.assertRaises(LEFT.InvalidQuotaResponse):
            LEFT.format_usage(json.dumps(data))

    def test_sanitizes_timeout_when_cli_does_not_respond(self) -> None:
        error = io.StringIO()
        with (
            tempfile.TemporaryDirectory(prefix="left-timeout-", dir=TMP) as directory,
            patch.dict(os.environ, {"XDG_STATE_HOME": str(Path(directory) / "state")}),
            patch.object(LEFT, "SNAPSHOT", Path(directory) / "left-snapshot.md"),
            patch.object(sys, "argv", ["left"]),
            patch.object(LEFT.subprocess, "run", side_effect=subprocess.TimeoutExpired(["opencode"], 30)),
            redirect_stderr(error),
        ):
            status = LEFT.main()

        self.assertEqual(status, 1)
        self.assertTrue(error.getvalue())

    def test_invalidates_previous_quota_when_lookup_is_cancelled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="left-cancel-", dir=TMP) as directory:
            target = Path(directory) / "left-snapshot.md"
            target.write_text("previous quota 99%", encoding="utf-8")
            with (
                patch.dict(os.environ, {"XDG_STATE_HOME": str(Path(directory) / "state")}),
                patch.object(LEFT, "SNAPSHOT", target),
                patch.object(sys, "argv", ["left"]),
                patch.object(LEFT.subprocess, "run", side_effect=KeyboardInterrupt),
                redirect_stderr(io.StringIO()),
            ):
                status = LEFT.main()

            self.assertEqual(status, 130)
            self.assertNotIn("%", target.read_text(encoding="utf-8"))


class CommandTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="left-test-", dir=TMP)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.calls = self.root / "calls.jsonl"
        fake = self.root / "opencode"
        fake.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
with Path(os.environ["LEFT_TEST_CALLS"]).open("a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] != ["api", "post", "/api/rpc/go-codex-quota/read", "--data", '{"input":{}}']:
    raise SystemExit(97)
print(os.environ["LEFT_TEST_RESPONSE"])
if os.environ.get("LEFT_TEST_FAIL"):
    print("fixture-secret", file=sys.stderr)
    raise SystemExit(1)
''', encoding="utf-8")
        fake.chmod(0o700)

    def run_left(self, response: str, arguments: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "HOME": str(self.root),
            "XDG_STATE_HOME": str(self.root / "state"),
            "LEFT_TEST_CALLS": str(self.calls),
            "LEFT_TEST_RESPONSE": response,
        }
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments], env=env, cwd=self.root,
            capture_output=True, text=True, encoding="utf-8", timeout=5, check=False,
        )

    def test_prints_only_quota_when_read_only_rpc_succeeds(self) -> None:
        response = snapshot()

        result = self.run_left(response)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 3)
        self.assertIn("주간 55.25%", result.stdout)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)

    def test_calls_no_api_when_arguments_are_supplied(self) -> None:
        response = snapshot()

        result = self.run_left(response, ("unexpected",))

        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.calls.exists())
        self.assertFalse((self.root / "left-snapshot.md").exists())

    def test_refreshes_context_when_live_read_succeeds(self) -> None:
        target = self.root / "left-snapshot.md"
        target.write_text("previous snapshot", encoding="utf-8")

        result = self.run_left(snapshot())

        self.assertEqual(result.returncode, 0, result.stderr)
        content = target.read_text(encoding="utf-8")
        self.assertIn(result.stdout.strip(), content)
        self.assertNotIn("previous snapshot", content)
        self.assertEqual(list(self.root.glob(".left-snapshot-*")), [])

    def test_invalidates_old_context_when_lookup_fails(self) -> None:
        target = self.root / "left-snapshot.md"
        target.write_text("previous quota 99%", encoding="utf-8")

        result = self.run_left("fixture-secret invalid JSON")

        self.assertEqual(result.returncode, 1)
        content = target.read_text(encoding="utf-8")
        self.assertNotIn("%", content)
        self.assertNotIn("fixture-secret", content)
        self.assertIn(result.stderr.strip(), content)

    def test_preserves_shell_output_when_context_cannot_be_saved(self) -> None:
        (self.root / "left-snapshot.md").mkdir()

        result = self.run_left(snapshot())

        self.assertEqual(result.returncode, 1)
        self.assertIn("주간 55.25%", result.stdout)
        self.assertTrue(result.stderr)

    def test_reports_failure_when_rpc_json_is_invalid(self) -> None:
        response = "fixture-secret invalid JSON"

        result = self.run_left(response)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("fixture-secret", result.stderr)

    def test_reports_partial_failure_when_one_provider_is_unavailable(self) -> None:
        for code, label in (("auth", "Go 오류:"), ("expired", "Go: 구독기간 만료")):
            with self.subTest(code=code):
                data = json.loads(snapshot())
                data["output"]["go"] = {"error": {"code": code, "message": "fixture-secret"}}

                result = self.run_left(json.dumps(data))

                self.assertEqual(result.returncode, 0)
                self.assertIn("Codex 남음: 7d 57%", result.stdout)
                self.assertIn(label, result.stdout)
                self.assertNotIn("fixture-secret", result.stdout + result.stderr)
                self.assertIn("상태: 조회 실패 또는 일부 제공자 조회 불가",
                              (self.root / "left-snapshot.md").read_text(encoding="utf-8"))

    def test_reports_failure_when_both_providers_are_unavailable(self) -> None:
        data = json.loads(snapshot())
        for provider in ("go", "codex"):
            data["output"][provider] = {"error": {"code": "schema", "message": "fixture-secret"}}

        result = self.run_left(json.dumps(data))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stdout.splitlines()), 3)
        self.assertNotIn("남음:", result.stdout)
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)

    def test_sanitizes_output_when_opencode_fails(self) -> None:
        response = snapshot()
        with patch.dict(os.environ, {"LEFT_TEST_FAIL": "1"}):
            result = self.run_left(response)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("fixture-secret", result.stderr)


if __name__ == "__main__":
    unittest.main()
