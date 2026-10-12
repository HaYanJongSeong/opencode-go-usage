# opencode-go-usage (TUI plugin)

OpenCode **Go / Go Plus** 구독 사용량을 TUI **사이드바**에 표시하는 CLI 플러그인.

```
5H   ▓▓▓▓▓░ 99% · 4h12m   ← 남은 99%, 5시간 창 리셋까지 4h12m
일   ▓▓▓▓▓░ 98% · 22h     ← 24h 기준
주간  ▓▓▓▓▓░ 96% · 1d2h   ← 다음 월요일 00:00 기준
월간  ▓▓▓▓▓░ 82% · 15d    ← 다음달 1일 00:00 기준
```

- **남은 사용량(%)** = Go 규칙 근사 (5H = 월한도의 20%, 주간 = 50%, 월간 = 100%)
- 남은량 기준 색상: 초록(40%↑) / 노랑(40%↓) / 빨강(10%↓)
- 40초마다 자동 갱신 (옵션으로 조정 가능)
- `$` / 소계 없음 — % · 바 · 리셋시간만

## 설치

### 1) npm (배포용)

```sh
npm i -g opencode-go-usage
```

`~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-go-usage",
      "options": { "plan": "go", "refreshSec": 40 }
    }
  ]
}
```

### 2) GitHub 클론 (로컬)

```sh
git clone https://github.com/<you>/opencode-go-usage \
  ~/.config/opencode/plugins/opencode-go-usage
```

파일을 `<global-config>/plugins/<name>/tui.tsx` 형태로 두면 별도 cli.json 설정 없이 자동 로드됩니다.

기존 `cli.json` 방식:

```json
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/opencode-go-usage",
      "options": { "plan": "go" }
    }
  ]
}
```

## 옵션

| 옵션            | 기본값  | 설명                                            |
| --------------- | ------- | ----------------------------------------------- |
| `plan`          | `"go"`  | `"go"` 또는 `"goplus"` (한도 표 기준 변경)      |
| `refreshSec`    | `40`    | 갱신 주기(초), 최소 10                          |
| `monthlyLimits` | —       | 모델별 월한도 수동 보정, 예 `{ "glm-5.3": 60 }` |

## 데이터 방식 (중요)

플러그인은 **로컬 서버(DB)의 세션/메시지 기록**에서 모델별 cost·시간을 읽어 근사 계산합니다.

- 다른 폴더(별도 서버 인스턴스/프로젝트)에서 쓴 세션은 합산에서 빠질 수 있음
- 리셋 시각은 서버 공식 `resetsAt`이 아니라 위 창 기준의 근사치
- 콘솔(Console → Usage)의 공식 잔량과 완전히 동일하진 않습니다

## 라이선스

MIT
