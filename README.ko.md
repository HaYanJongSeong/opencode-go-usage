# opencode-go-usage

OpenCode에서 Go와 Codex 한도를 조회합니다. 권장 구성은 OpenCode 2.0.22 소스 빌드 웹 UI와 이 프로젝트의 서버 quota RPC입니다. 원래 내장 UI의 채팅 폴백은 모델 응답 1회를 사용합니다. 기존 Go TUI 사이드바는 별도 구현입니다.

[English](README.md)

## 웹 UI

일반 입력 모드에서 인자 없이 `/left` 또는 `/사용량`을 제출합니다. 수정 UI는 `go-codex-quota.read`로 조회한 잔여율과 막대를 입력창 위에 표시합니다. 모델 요청이나 대화 메시지를 만들지 않습니다. `/usage`는 등록하지 않습니다.

상세 펼침은 없습니다. 테두리가 있는 **사용량 닫기** 버튼으로 조회 중에도 패널을 닫고, 같은 명령으로 다시 엽니다. 오른쪽 리셋 카운트다운은 일 단위 대신 총 시간과 분으로 표시합니다. 패널이 열린 동안 1분마다 시간 표시만 갱신하며, **새로고침**을 눌러야 새 한도 값을 조회합니다.

Go 5h 창의 `resetsAt: null`은 공식 배포 Console JavaScript와 같은 의미인 **첫 사용 시 시작**으로 표시합니다. 다른 창의 null은 리셋 시각 미제공으로 남깁니다. 웹 UI는 리셋 시각을 추정하지 않습니다.

연결이 없거나 지원되는 인증을 사용할 수 없으면 해당 제공자에 **OpenAI 연결 필요** 또는 **OpenCode Go 연결 필요**를 표시합니다. 한쪽만 연결돼 있어도 그쪽 사용량은 표시합니다. 시간 초과·서버 오류·인증 거부는 연결 누락으로 표시하지 않고 조회 오류로 남깁니다.

### 서버 플러그인 설치

저장소를 복제한 뒤 V2 서버의 `opencode.json` 또는 `opencode.jsonc`에 있는 `plugins` 배열에 저장소의 절대 경로를 추가합니다.

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage.git
```

```json
{
  "plugins": ["/absolute/path/opencode-go-usage"]
}
```

기존 플러그인 항목은 유지하세요. 평소 절차대로 서버를 다시 로드하거나 재시작합니다. 기본 export는 `index.mjs`이며 RPC와 채팅 명령을 함께 등록합니다. `./rpc`는 RPC 계약만 내보내므로 이것만 로드해서는 서버 핸들러가 설치되지 않습니다. `./tui`는 웹 패널이 아닌 기존 사이드바입니다. 현재 패키지 manifest의 이름은 `prometheus-side-bar`입니다. 이 안내는 npm 배포를 전제하지 않고 GitHub 로컬 복제본을 사용합니다.

### 웹 UI 빌드와 실행

Git과 해당 환경에서 실행 가능한 Bun이 필요합니다. 임의의 OpenCode 버전 대신 지정된 upstream commit을 사용합니다.

```sh
git clone https://github.com/anomalyco/opencode.git opencode-source
cd opencode-source
git checkout 527f0b931d1f9b3ebd34e106c51b31ce5db5b075
git apply --check ../opencode-go-usage/web-ui-v2.0.22.patch
git apply ../opencode-go-usage/web-ui-v2.0.22.patch
bun install --frozen-lockfile --ignore-scripts --filter '@opencode/app'
OPENCODE_CHANNEL=latest VITE_OPENCODE_SERVER_MODE=origin bun --bun run --cwd packages/app build
cd ../opencode-go-usage
bun web-server.mjs ../opencode-source/packages/app/dist
```

RPC 플러그인을 로드한 원래 인증 서버를 `127.0.0.1:49374`에서 실행해 둡니다. 수정 UI는 `http://127.0.0.1:49375/`로 엽니다. 프록시는 빌드 자산을 제공하고 API와 WebSocket 요청을 원래 서버로 전달합니다. 기존 내장 UI는 `http://127.0.0.1:49374/`에 그대로 남습니다.

`localhost`가 아닌 `127.0.0.1`을 사용하세요. 인증이 필요하면 OpenCode의 정상 페어링 절차를 따릅니다. 프록시는 원래 서버의 포트별 세션 쿠키만 전달하며 인증정보를 만들지 않습니다. Host·Origin·Fetch Metadata를 검사하고 loopback에만 바인딩합니다. 공개 서비스로 노출하지 마세요. 실행 명령은 포그라운드에서 동작하며 재부팅 자동 시작을 설치하지 않습니다.

## 조회 출처와 인증정보

서버 수집기는 자격증명 목록이나 로컬 DB 대신 선택된 제공자의 활성 integration 연결을 해석합니다. Go와 Codex를 병렬로 조회하며 매번 새 데이터를 읽습니다.

- Go Console OAuth/key는 metadata에 `https://opencode.ai/console`이 지정되어 있어야 합니다. `https://opencode.ai/console/api/go/status`의 `access.meters`에서 양수 한도를 가진 `fiveHour`, `week`, `month`를 읽습니다.
- 선택된 레거시 `opencode-go` key는 `https://opencode.ai/zen/go/v1/usage`를 사용합니다. Console OAuth는 이 주소로 보내지 않습니다.
- Codex는 공식 `openai` OAuth의 활성 연결로 `https://chatgpt.com/backend-api/wham/usage`를 조회합니다. 시간창은 응답에서 읽습니다. ChatGPT 전체 사용량이 아니며 API가 `pro`를 반환할 때만 Pro 라벨을 표시합니다.

조회 실패를 로컬 추정값으로 대체하지 않습니다. HTTP 요청은 리디렉션을 거부하고 10초 제한과 128 KiB 본문 제한을 적용합니다. UI와 도구에는 파싱한 한도 값과 고정 오류만 전달하며 원본 응답·토큰·계정/조직 ID는 출력하지 않습니다. 취소 신호는 HTTP 요청에 전달하지만 자격증명 해석의 즉시 취소는 보장하지 않습니다. backend 응답 형식은 바뀔 수 있습니다.

## 원래 내장 UI의 채팅 폴백

웹 패치 없이 `/left` 또는 `/사용량`을 실행하면 서버 채팅 명령이 동작합니다. 정제한 Markdown 스냅샷을 조회한 뒤 현재 세션 모델에 그대로 출력하도록 요청합니다. 모델 응답 1회가 발생하므로 사용량이나 비용이 추가될 수 있습니다. 수치는 그 응답 전 조회값이며 모델의 정확한 원문 출력은 보장하지 않습니다. 기존 세션과 전달 모드는 유지합니다.

읽기 전용 `usage_status` 도구는 자체적으로 모델 응답을 요청하지 않고 정제한 JSON 스냅샷을 반환합니다. 같은 수집기를 사용하며 로컬 비용 추정은 없습니다. 모델이 이 도구를 호출하는 경우 그 호출은 여전히 모델 대화의 일부입니다.

수정하지 않은 UI의 `/left test` 또는 `/사용량 test`는 실제 한도 조회나 모델 응답 없이 모의 테스트를 실행합니다. 결과는 채팅 대신 테스트 코드에 지정된 로컬 파일에 저장합니다. 수정 웹 UI는 인자 없는 명령만 허용하므로 테스트는 직접 실행하세요.

```sh
bun -e 'const r = await (await import("./usage.test.mjs")).runTests(); console.log({ passed: r.passed, total: r.total }); if (!r.passed) process.exit(1)'
bun test web-server.test.mjs
bun web-ui-sw.test.mjs ../opencode-source/packages/app/dist/sw.js
```

## 기존 Go TUI 사이드바

변경하지 않은 `tui.tsx`는 Go 잔여율·6칸 막대·리셋까지 남은 시간을 표시합니다. Codex는 표시하지 않습니다. 시작 직후 조회하고 기본 45초마다 갱신하며 Console 응답은 15초 캐시합니다. 잔여량이 40% 초과면 초록, 10% 초과부터 40%까지는 노랑, 10% 이하면 빨강입니다. 기본 라벨은 `5H / 주간 / 월간`이며 `locale: "en"`은 `5H / WEEK / MONTH`입니다.

호환되는 TUI 플러그인 로더에서 `tui.tsx` 또는 패키지의 `./tui` export를 로드합니다. 웹/서버 플러그인 등록만으로 TUI 사이드바가 추가되지는 않습니다. 이 구현은 `package.json`에 명시된 TUI API와 peer dependency에 의존합니다. OpenCode 버전별 자동 발견은 여기서 검증하지 않았습니다.

| 옵션 | 기본값 | 동작 |
| --- | --- | --- |
| `plan` | `"go"` | `go` 또는 `goplus`; 로컬 추정에만 쓰는 내장 한도 |
| `refreshSec` | `45` | 조회 주기(초), 최소 10 |
| `locale` | `"ko"` | 한국어 또는 `"en"` 라벨 |
| `source` | `"auto"` | Console 후 로컬 추정; `"api"`는 추정 금지; `"local"`은 Console 조회 생략 |
| `monthlyLimits` | 미설정 | 로컬 추정용 모델별 한도 덮어쓰기 |

V2 수집기와 달리 기존 위젯은 integration 접근에 실패하면 자격증명 목록과 로컬 OpenCode DB를 사용할 수 있습니다. `source: "auto"` 또는 `"local"`에서는 로컬 메시지 비용과 내장 플랜 한도로 추정하고 행에 `~`를 붙입니다. 추정 리셋 시각도 로컬 규칙으로 계산하며 API 리셋 시각이 아닙니다. 추정을 피하려면 `source: "api"`를 사용하세요. 내장 한도는 오래된 값일 수 있고 로컬 기록도 불완전할 수 있습니다.

## 검증 범위와 한계

게시 전 검증은 수집기/RPC 25개, 프록시 41개, UI 46개 테스트와 지정 upstream의 production 빌드를 포함합니다. 생성된 서비스워커에서도 온라인 탐색, 오프라인 캐시 대체, API·인증 경로 제외를 실행합니다. Android에 배포한 화면에서는 사용자가 기존 상세 버튼이 사라지고 요청한 패널 변경이 보인다고 확인했습니다. 미연결 안내는 DOM 테스트로 검증했으며, 실제 계정 연결을 끊어 시험하지는 않았습니다.

문서 탐색은 서버의 최신 HTML을 먼저 읽고, 오프라인에서 runtime 캐시를 사용합니다. 해시가 붙은 자산은 precache를 유지합니다. 기존 배포를 갱신할 때는 자산을 먼저 복사하고 `index.html`, `sw.js` 순서로 교체하세요. 열려 있는 탭을 위해 이전 해시 자산도 보존합니다. 업데이트는 탭을 강제로 새로고침하거나 쿠키·대화 저장소를 지우지 않습니다. 새 서비스워커 활성화 후에도 이전 탭이 남아 있으면 닫았다가 다시 열어야 할 수 있습니다.

이 환경에서는 Brave/Gboard 자동 조작, 모바일 라이트·다크 스크린샷 검증, 브라우저 쿠키 통합 테스트를 실행할 수 없습니다. 전체 upstream typecheck는 기존 타입 오류와 필터 설치에서 빠진 Storybook 의존성 때문에 실패합니다. 변경한 quota 파일에는 보고된 진단이 없으며 서비스워커 설정은 별도 타입 검사를 통과했습니다. 원본 소스에서도 동일하게 실패하는 제출 테스트 1개가 있습니다. 이 항목들을 통과했다고 표시하지 않습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
