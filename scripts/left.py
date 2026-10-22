#!/data/data/com.termux/files/usr/bin/python
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: left, or python ~/.config/opencode/scripts/left.py
"""Print live Go/Codex quotas through the existing read-only plugin RPC."""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Final

from left_rpc import read_usage

KST: Final = timezone(timedelta(hours=9))
SNAPSHOT: Final = Path.home() / "left-snapshot.md"
ERRORS: Final = {
    "auth": "인증 연결 확인 필요",
    "origin": "공식 Console 연결 확인 필요",
    "unauthorized": "인증 거부 (401/403)",
    "rate_limit": "조회 제한 (429)",
    "http": "사용량 서버 오류",
    "network": "네트워크 오류",
    "timeout": "조회 시간 초과",
    "cancelled": "조회 취소",
    "size": "응답 크기 초과",
    "json": "올바르지 않은 JSON 응답",
    "expired": "구독기간 만료",
    "schema": "지원되지 않는 사용량 응답",
}


class InvalidQuotaResponse(ValueError):
    """The RPC response cannot be displayed as a current quota."""


def reset_label(timestamp: str | None, checked: datetime) -> str:
    """Describe the reported reset relative to the snapshot, not the clock."""
    if timestamp is None:
        return "리셋 시각 미제공"
    if not isinstance(timestamp, str):
        raise InvalidQuotaResponse
    reset = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if reset.utcoffset() is None:
        raise InvalidQuotaResponse
    seconds = (reset - checked).total_seconds()
    if seconds <= 0:
        return "리셋 시각 도달"
    if seconds < 60:
        return "리셋 1분 이내"
    days, rest = divmod(math.ceil(seconds / 60), 1440)
    hours, minutes = divmod(rest, 60)
    parts = []
    if days:
        parts.append(f"{days}일")
    if hours:
        parts.append(f"{hours}시간")
    if not days and minutes:
        parts.append(f"{minutes}분")
    return f"리셋 약 {' '.join(parts)} 후"


def format_usage(raw: str) -> tuple[str, int]:
    """Return display fields and the number of providers that failed."""
    snapshot = json.loads(raw)["output"]
    timestamp = snapshot["checkedAt"]
    if not isinstance(timestamp, str):
        raise InvalidQuotaResponse
    checked = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if checked.utcoffset() is None:
        raise InvalidQuotaResponse
    local = checked.astimezone(KST)
    lines = [f"확인: {local:%m.%d %H:%M} GMT+9"]
    failures = 0
    for key, label in (("go", "Go"), ("codex", "Codex")):
        section = snapshot[key]
        if "error" in section:
            code = section["error"]["code"]
            prefix = label if code == "expired" else f"{label} 오류"
            lines.append(f"{prefix}: {ERRORS[code]}")
            failures += 1
            continue
        windows = section["windows"]
        if not isinstance(windows, list) or not windows:
            raise InvalidQuotaResponse
        rows = []
        for window in windows:
            name, remaining = window["name"], window["remainingPercent"]
            if not isinstance(name, str) or not name or not name.isprintable():
                raise InvalidQuotaResponse
            if type(remaining) not in (int, float) or not 0 <= remaining <= 100 or not math.isfinite(remaining):
                raise InvalidQuotaResponse
            percent = f"{remaining:.2f}".rstrip("0").rstrip(".")
            rows.append(f"{name} {percent}% ({reset_label(window['resetsAt'], checked)})")
        lines.append(f"{label} 남음: {' · '.join(rows)}")
    return "\n".join(lines), failures


def save_context(output: str, status: int) -> None:
    """Atomically replace the context snapshot, including failed lookups."""
    state = "정상 조회" if status == 0 else "조회 실패 또는 일부 제공자 조회 불가"
    content = (
        "# Go/Codex 사용량 스냅샷\n\n"
        "마지막 조회 시점의 자료이며 실시간 값이 아닙니다. @ 첨부만으로 자동 갱신되지 않습니다.\n\n"
        f"상태: {state}\n\n{output}\n\n"
        "Codex는 ChatGPT 전체 사용량이 아니라 Codex 제한입니다.\n"
    )
    with tempfile.TemporaryDirectory(prefix=".left-snapshot-", dir=SNAPSHOT.parent) as directory:
        temporary = Path(directory) / "snapshot.md"
        temporary.write_text(content, encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(SNAPSHOT)


def main() -> int:
    """Make one quota RPC request without creating or prompting a session."""
    if len(sys.argv) != 1:
        print("사용법: left (이미 셸모드라면 느낌표 없이 입력)", file=sys.stderr)
        return 2
    available = True
    try:
        output, failures = format_usage(read_usage())
        status = int(failures == 2)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        attempted = datetime.now(KST).strftime("%m.%d %H:%M GMT+9")
        output = f"조회 시도: {attempted}\nleft: 사용량을 조회하지 못했습니다. 서버와 사용량 플러그인 연결을 확인하세요."
        failures, status, available = 2, 1, False
    except KeyboardInterrupt:
        attempted = datetime.now(KST).strftime("%m.%d %H:%M GMT+9")
        output = f"조회 시도: {attempted}\nleft: 조회가 취소되었습니다."
        failures, status, available = 2, 130, False
    print(output, file=sys.stdout if available else sys.stderr)
    try:
        save_context(output, failures)
    except OSError:
        print("left: 문맥 파일 갱신 실패. @left-snapshot.md는 이전 자료일 수 있습니다.", file=sys.stderr)
        return status or 1
    return status


if __name__ == "__main__":
    raise SystemExit(main())
