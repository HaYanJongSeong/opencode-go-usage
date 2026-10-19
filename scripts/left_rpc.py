# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
# How to run: imported by left.py; tested with unittest discover -p 'test_left_rpc*.py'.
"""Read the quota RPC through a verified local service, without starting the CLI."""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import signal
import stat
import subprocess
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import Final, NoReturn

_SECONDS: Final = 30.0
_METADATA_LIMIT: Final = 16 * 1024
_USAGE_LIMIT: Final = 1024 * 1024
_VERSION: Final = "2.0.22"
_RPC: Final = "/api/rpc/go-codex-quota/read"
_INPUT: Final = '{"input":{}}'


class RPCError(ValueError):
    """A local lookup failed without exposing credentials or response details."""

    def __str__(self) -> str:
        return "Local quota request failed"


@dataclass(frozen=True, slots=True)
class _Registration:
    host: str
    port: int
    pid: int
    version: str
    password: str | None = field(repr=False)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RPCError
    return remaining


def _expire(_signum: int, _frame: FrameType | None) -> NoReturn:
    raise RPCError


@contextmanager
def _budget() -> Iterator[float]:
    """Interrupt even slow headers/bodies; restore the caller's alarm schedule."""
    started = time.monotonic()
    previous = signal.getitimer(signal.ITIMER_REAL)
    duration = min(_SECONDS, previous[0]) if previous[0] else _SECONDS
    deadline = started + duration
    handler = signal.signal(signal.SIGALRM, _expire)
    try:
        signal.setitimer(signal.ITIMER_REAL, _remaining(deadline))
        yield deadline
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            remaining = max(previous[0] - (time.monotonic() - started), 0.000001)
            signal.setitimer(signal.ITIMER_REAL, remaining, previous[1])


def _registration() -> _Registration | None:
    root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    path = root / "opencode/service.json"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > _METADATA_LIMIT):
            raise RPCError
        raw = stream.read(_METADATA_LIMIT + 1)
    if len(raw) > _METADATA_LIMIT:
        raise RPCError
    data = json.loads(raw)
    if type(data) is not dict:
        raise RPCError
    url, pid, version = data.get("url"), data.get("pid"), data.get("version")
    password = data.get("password")
    if (type(url) is not str or type(pid) is not int or pid <= 0
            or ("version" in data and (type(version) is not str or not version))
            or ("password" in data and type(password) is not str)):
        raise RPCError
    address = re.fullmatch(r"http://(127\.0\.0\.1|\[::1\]):([0-9]{1,5})/?", url)
    if address is None or not 1 <= int(address[2]) <= 65535:
        raise RPCError
    if "version" not in data:
        return None
    return _Registration(address[1].strip("[]"), int(address[2]), pid, version, password)


def _response(connection: http.client.HTTPConnection, limit: int) -> str:
    with connection.getresponse() as response:
        if response.status != 200 or (response.length is not None and response.length > limit):
            raise RPCError
        raw = response.read(limit + 1)
        if len(raw) > limit or response.length not in (None, 0):
            raise RPCError
    return raw.decode("utf-8")


def _direct(registration: _Registration, deadline: float) -> str | None:
    headers = {}
    if registration.password is not None:
        value = base64.b64encode(f"opencode:{registration.password}".encode("utf-8"))
        headers["Authorization"] = "Basic " + value.decode("ascii")
    with closing(http.client.HTTPConnection(
        registration.host, registration.port, timeout=_remaining(deadline),
    )) as connection:
        try:
            connection.connect()
        except ConnectionRefusedError:
            return None
        connection.request("GET", "/api/info", headers=headers)
        info = json.loads(_response(connection, _METADATA_LIMIT))
        if (type(info) is not dict or type(info.get("pid")) is not int
                or info["pid"] != registration.pid or info.get("version") != registration.version):
            raise RPCError
        if registration.version != _VERSION:
            return None
        _remaining(deadline)
        connection.request("POST", _RPC, _INPUT, {**headers, "Content-Type": "application/json"})
        raw = _response(connection, _USAGE_LIMIT)
        json.loads(raw)
        _remaining(deadline)
        return raw


def read_usage() -> str:
    """Read once, allowing CLI fallback only before an unambiguous local POST."""
    try:
        with _budget() as deadline:
            registration = _registration()
            explicit_auth = any(name in os.environ for name in (
                "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD",
            ))
            if registration is not None and not explicit_auth:
                raw = _direct(registration, deadline)
                if raw is not None:
                    return raw
            result = subprocess.run(
                ["opencode", "api", "post", _RPC, "--data", _INPUT],
                capture_output=True, text=True, encoding="utf-8", check=True,
                timeout=_remaining(deadline),
            )
            _remaining(deadline)
            return result.stdout
    except (OSError, http.client.HTTPException, ValueError, RecursionError, subprocess.SubprocessError):
        raise RPCError from None
