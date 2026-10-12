# opencode-go-usage (TUI plugin)

[English](README.md) | **한국어**

OpenCode **Go / Go Plus** 구독 중이라면 사이드바에서 창별로 얼마나 남았는지, 언제 리셋되는지 바로 볼 수 있다.

```
5H    ▓▓▓▓▓░ 88% · 1h12m   ← 5시간 창
주간  ▓▓░░░░ 37% · 3d4h    ← 주간
월간  ▓░░░░░ 12% · 12d     ← 월간
```

- 콘솔([opencode.ai/console](https://opencode.ai/console)) → Usage와 **같은 미터**를 읽는다. 플랜이 실제로 막는 숫자와 일치한다
- 남은량 기준 색상: 초록(40%↑) / 노랑(40%↓) / 빨강(10%↓)
- 기본 45초마다 갱신
- `$` / 소계 없음 — % · 바 · 리셋시간만
- 콘솔에 못 닿으면(오프라인·로그인 만료) 로컬 기록으로 근사치를 내고 행 끝에 `~`를 붙인다

라벨은 기본 `5H / 주간 / 월간`. `"locale": "en"`으로 바꾸면 `5H / WEEK / MONTH`.

## 설치 (다른 컴퓨터)

**한 줄 클론 — cli.json 수정 불필요, node_modules 불필요:**

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage \
  ~/.config/opencode/plugins/opencode-go-usage
```

OpenCode는 `<global-config>/plugins/<name>/tui.tsx` 경로의 플러그인을 자동으로 발견하기 때문에 위 경로만으로 충분하다.

`~/.config/opencode/cli.json`에 직접 적는 방식:

```json
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/opencode-go-usage",
      "options": { "locale": "ko" }
    }
  ]
}
```

## 옵션

| 옵션            | 기본값   | 설명                                                          |
| --------------- | -------- | ------------------------------------------------------------- |
| `plan`          | `"go"`   | `"go"` 또는 `"goplus"` — 로컬 근사에만 쓰는 한도 표            |
| `refreshSec`    | `45`     | 갱신 주기(초), 최소 10                                        |
| `locale`        | `"ko"`   | `"en"`이면 라벨이 `5H/WEEK/MONTH`                             |
| `source`        | `"auto"` | `auto`(콘솔 → 로컬) · `api`(콘솔만) · `local`(콘솔 안 부름)     |
| `monthlyLimits` | —        | 로컬 근사용 모델별 월한도 수동 보정, 예 `{ "glm-5.3": 60 }`    |

## 동기화 시점

| 시점                  | 동작                          |
| --------------------- | ----------------------------- |
| TUI 시작 직후         | 즉시 조회해서 1회 렌더        |
| `refreshSec`마다      | 콘솔 미터를 다시 읽음         |
| 사용량이 움직임       | 다음 폴링 주기에 반영(푸시 아님) |

응답은 15초간 캐시한다. `refreshSec`를 아주 짧게 잡아도 콘솔을 초당으로 두드리진 않는다.

## 예시 화면

![사이드바 예시](assets/preview.svg)

![Sidebar preview (English)](assets/preview-en.svg)

## 숫자 출처

`GET https://opencode.ai/console/api/go/status` 를 디스크에 이미 있는 로그인 토큰(=`~/.local/share/opencode/opencode.db`의 `opencode` 자격증명, CLI가 쓰는 것과 동일)으로 호출한다. 응답에는 창별 미터가 들어 있다.

```
fiveHour · week · month   →   usedMicroCents, limitMicroCents, resetsAt
```

남은 %는 `1 - used/limit`, 카운트다운은 `resetsAt`에서 현재를 뺀 값이라 콘솔과 같게 나온다. 5시간 한도를 다 썼을 때 받는 `retry-after`와도 맞는다.

토큰은 읽기만 한다. 갱신·회전·기록은 하지 않는다.

### 폴백(로컬 근사)

콘솔 호출이 실패하면 로컬 세션 기록을 합산한다(메시지별 `cost`·시각을 모델별로 묶고, [Go 플랜 문서](https://opencode.ai/v2/docs/console/go)의 월한도와 비교). 이때 행 끝에 `~`가 붙는다. 서버 계산보다 낮게 잡히는 근사치라 오프라인일 때의 임시값으로만 보면 된다.

## 라이선스

MIT
