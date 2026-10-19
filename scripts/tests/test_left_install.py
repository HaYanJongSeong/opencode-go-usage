# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: python -m unittest discover -s scripts/tests -p test_left_install.py -v
"""Exercise installation and installed aliases in an isolated Termux prefix."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Final
from unittest.mock import patch

from test_left import SCRIPT, snapshot
from test_left_rpc_http import register, sandbox, service

INSTALLER: Final = SCRIPT.with_name("install-left.sh")
NAMES: Final = ("left", "Left", "사용량")


class InstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = self.enterContext(sandbox())
        self.prefix = self.root / "prefix"
        self.bin = self.prefix / "bin"
        self.context = self.root / "left-snapshot.md"
        self.calls = self.root / "cli-calls"
        fake = self.root / "opencode"
        fake.write_text(f"#!{sys.executable}\nfrom pathlib import Path\n"
                        f"Path({str(self.calls)!r}).write_text('1')\nraise SystemExit(97)\n")
        fake.chmod(0o700)
        self.enterContext(patch.dict(os.environ, {
            "HOME": str(self.root),
            "PREFIX": str(self.prefix),
            "PATH": os.pathsep.join((str(self.bin), str(self.root), os.environ["PATH"])),
            "XDG_STATE_HOME": str(self.root / "state"),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_RUNTIME_DIR": str(self.root / "runtime"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }, clear=True))

    def install(self, script: Path = INSTALLER) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(script)], cwd=self.root, capture_output=True,
                              text=True, encoding="utf-8", check=False, timeout=5)

    def run_left(self, name: str, arguments: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        return subprocess.run([name, *arguments], cwd=self.root, capture_output=True,
                              text=True, encoding="utf-8", check=False, timeout=5)

    def test_reads_once_without_cli_or_model_when_each_alias_is_installed(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        for name in NAMES:
            with self.subTest(name=name), service() as wire:
                wire.output = snapshot().encode("utf-8")
                register(self.root, wire)

                result = self.run_left(name)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.bin / name).readlink(), SCRIPT)
                self.assertEqual(len(result.stdout.splitlines()), 3)
                self.assertEqual(result.stderr, "")
                self.assertEqual(self.context.stat().st_mode & 0o777, 0o600)
                self.assertEqual(wire.requests, [
                    ("GET", "/api/info", None, b""),
                    ("POST", "/api/rpc/go-codex-quota/read", None, b'{"input":{}}'),
                ])
                self.assertFalse(self.calls.exists())

    def test_invalidates_snapshot_when_each_alias_gets_a_failed_post(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        for name in NAMES:
            with self.subTest(name=name), service() as wire:
                wire.status["POST"] = 500
                register(self.root, wire)
                self.context.write_bytes(b"previous")

                result = self.run_left(name)

                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertTrue(result.stderr)
                self.assertNotEqual(self.context.read_bytes(), b"previous")
                self.assertEqual([row[0] for row in wire.requests], ["GET", "POST"])
                self.assertFalse(self.calls.exists())

    def test_calls_nothing_when_each_alias_receives_arguments(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        for name in NAMES:
            with self.subTest(name=name), service() as wire:
                register(self.root, wire)

                result = self.run_left(name, ("unexpected",))

                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertTrue(result.stderr)
                self.assertEqual(wire.requests, [])
                self.assertFalse(self.calls.exists())
                self.assertFalse(self.context.exists())

    def test_keeps_same_links_when_installer_runs_again(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        inodes = [(self.bin / name).lstat().st_ino for name in NAMES]

        result = self.install()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([(self.bin / name).lstat().st_ino for name in NAMES], inodes)

    def test_preserves_existing_entries_when_any_alias_name_is_taken(self) -> None:
        for name in NAMES:
            regular = self.prefix / f"file-{name}" / "bin" / name
            link = self.prefix / f"link-{name}" / "bin" / name
            directory = self.prefix / f"directory-{name}" / "bin" / name
            for target in (regular, link, directory):
                target.parent.mkdir(parents=True)
            regular.write_bytes(b"fixture")
            link.symlink_to(self.root / "missing")
            directory.mkdir()
            for target in (regular, link, directory):
                with self.subTest(name=name, prefix=target.parent.parent.name):
                    before = target.lstat()
                    with patch.dict(os.environ, {"PREFIX": str(target.parent.parent)}):

                        result = self.install()

                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue(result.stderr)
                    after = target.lstat()
                    self.assertEqual(after.st_ino, before.st_ino)
                    self.assertEqual(after.st_mode, before.st_mode)
            self.assertEqual(regular.read_bytes(), b"fixture")
            self.assertEqual(link.readlink(), self.root / "missing")
            self.assertEqual(list(directory.iterdir()), [])

    def test_uses_executable_sibling_when_installer_directory_is_a_symlink(self) -> None:
        physical = self.root / "physical scripts"
        physical.mkdir()
        for source in (SCRIPT, INSTALLER):
            shutil.copyfile(source, physical / source.name)
        source = physical / SCRIPT.name
        source.chmod(0o600)
        logical = self.root / "logical"
        logical.symlink_to(physical, target_is_directory=True)

        result = self.install(logical / INSTALLER.name)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(source.stat().st_mode & 0o100)
        for name in NAMES:
            self.assertEqual((self.bin / name).readlink(), source)


if __name__ == "__main__":
    unittest.main()
