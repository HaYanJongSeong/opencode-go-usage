// OpenCode Go 사용량 사이드바 위젯 (minimal)
// 사이드바에 5H / 일(24h) / 주간 / 월간 남은 사용량 % 와 리셋까지 남은 시간만 표시한다.
// 데이터: 로컬 서버 세션/메시지 기록(메시지별 cost + time)으로 근사 계산.
// 옵션(cli.json plugins[].options): { "plan": "go"|"goplus", "refreshSec": 45, "monthlyLimits": {...} }

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount, For, Show } from "solid-js"

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Go 플랜 모델별 월 한도(USD) — /v2/docs/console/go
const PLAN_LIMITS: Record<string, Record<string, number>> = {
  go: {
    "glm-5.3-flash": 60,
    "glm-5.3": 15,
    "glm-5.2": 60,
    "kimi-k3": 15,
    "kimi-k2.7-code": 60,
    "kimi-k2.6": 60,
    "longcat-2.0": 60,
    "mimo-v2.6-flash": 60,
    "mimo-v2.6-pro": 15,
    "mimo-v2.5": 60,
    "mimo-v2.5-pro": 15,
    "minimax-m3": 60,
    "minimax-m2.7": 60,
    "muse-spark-1.3-contributor": 60,
    "muse-spark-1.2-contributor": 60,
    "qwen3.8-max": 15,
    "qwen3.8-flash": 30,
    "qwen3.7-plus": 60,
    "deepseek-v4.1-flash": 60,
    "deepseek-v4-pro": 15,
    "deepseek-v4-flash": 30,
    "deepseek-v4-flash-vision-exp": 15,
    "hy4-preview": 30,
    hy3: 60,
    "space-bunny": 30,
    "space-bunny-free": 30,
    "grok-4.7": 15,
    "grok-4.6": 15,
    "gpt-6-luna": 15,
    "gpt-5.6-luna": 15,
    "claude-haiku-5-5": 15,
  },
  goplus: {
    "glm-5.3-flash": 180,
    "glm-5.3": 120,
    "glm-5.2": 180,
    "kimi-k3": 60,
    "kimi-k2.7-code": 180,
    "kimi-k2.6": 240,
    "longcat-2.0": 240,
    "mimo-v2.6-flash": 120,
    "mimo-v2.6-pro": 60,
    "mimo-v2.5": 120,
    "mimo-v2.5-pro": 60,
    "minimax-m3": 180,
    "minimax-m2.7": 240,
    "muse-spark-1.3-contributor": 120,
    "muse-spark-1.2-contributor": 120,
    "qwen3.8-max": 60,
    "qwen3.8-flash": 90,
    "qwen3.7-plus": 180,
    "deepseek-v4.1-flash": 120,
    "deepseek-v4-pro": 60,
    "deepseek-v4-flash": 120,
    "deepseek-v4-flash-vision-exp": 60,
    "hy4-preview": 120,
    hy3: 240,
    "space-bunny": 120,
    "space-bunny-free": 0,
    "grok-4.7": 60,
    "grok-4.6": 60,
    "gpt-6-luna": 60,
    "gpt-5.6-luna": 60,
    "claude-haiku-5-5": 60,
  },
}

type Msg = { cost: number; created: number; model: string }

// 라벨/표기 로케일: cli.json options.locale = "ko"(기본) | "en"
// 5칸 고정폭으로 맞추기(터미널 CJK 폭 고려) — 바 우측 정렬 일관성 유지.
const LABELS: Record<string, { five: string; day: string; week: string; month: string; empty: string }> = {
  ko: { five: "5H  ", day: "일  ", week: "주간", month: "월간", empty: "-" },
  en: { five: "5H   ", day: "DAY  ", week: "WEEK ", month: "MONTH", empty: "-" },
}

export default Plugin.define({
  id: "prometheus-go-usage",
  async setup(context: any) {
    const options = context.options ?? {}
    const planKey = options.plan === "goplus" ? "goplus" : "go"
    const limits =
      options.monthlyLimits && typeof options.monthlyLimits === "object"
        ? { ...PLAN_LIMITS[planKey], ...options.monthlyLimits }
        : PLAN_LIMITS[planKey]
    const refreshMs = Math.max(10, Number(options.refreshSec ?? 45)) * 1000
    const labels = LABELS[options.locale === "en" ? "en" : "ko"] ?? LABELS.ko

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <GoUsage context={context} limits={limits} labels={labels} refreshMs={refreshMs} />,
    })
    return () => unregister()
  },
})

function GoUsage(props: { context: any; limits: Record<string, number>; labels: (typeof LABELS)["ko"]; refreshMs: number }) {
  const [rows, setRows] = createSignal<Row[]>([])

  onMount(() => {
    const run = async () => {
      try {
        setRows(await buildRows(props.context, props.limits, props.labels))
      } catch {}
    }
    run()
    const iv = setInterval(run, props.refreshMs)
    onCleanup(() => clearInterval(iv))
  })

  return (
    <Show when={rows().length > 0} fallback={null}>
      <box flexDirection="column" rowGap={0}>
        <For each={rows()}>
          {(r) => {
            const rem = 100 - r.pct // 남은 잔량
            const h = Math.max(0, Math.min(6, Math.round((rem / 100) * 6)))
            const bar = "▓".repeat(h) + "░".repeat(6 - h)
            const fg = rem <= 10 ? "red" : rem <= 40 ? "yellow" : "green"
            return (
              <text fg={fg}>
                {r.label} {bar} {rem}% {"·"} {r.reset}
              </text>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

type Row = { label: string; pct: number; reset: string }

async function buildRows(context: any, limits: Record<string, number>, labels: (typeof LABELS)["ko"]): Promise<Row[]> {
  const now = Date.now()
  const c30d = now - 30 * DAY

  // 세션/메시지 수집 (opencode-go 사용분만)
  const msgs: Msg[] = []
  const sessionSpend = new Map<string, number>()
  let sessions: any[] = []
  try {
    sessions = context.data.session.list() ?? []
  } catch {
    sessions = []
  }
  for (const s of sessions) {
    if ((s?.time?.updated ?? 0) < c30d) continue
    const model = s?.model?.id ?? "unknown"
    sessionSpend.set(model, (sessionSpend.get(model) ?? 0) + (typeof s?.cost === "number" ? s.cost : 0))
    const sid = s?.id
    try {
      await context.data.session.message.sync(sid)
    } catch {}
    let list: any[] = []
    try {
      list = context.data.session.message.list(sid) ?? []
    } catch {}
    for (const m of list) {
      const info = m?.info ?? m
      const created = info?.time?.created ?? 0
      if (created < c30d) continue
      const prov = info?.model?.providerID ?? ""
      if (prov && prov !== "opencode-go") continue
      msgs.push({
        cost: typeof info?.cost === "number" ? info.cost : 0,
        created,
        model: info?.model?.id ?? model,
      })
    }
  }

  const per = (from: number) => {
    const m = new Map<string, number>()
    let earliest = Infinity
    for (const x of msgs) {
      if (x.created < from) continue
      m.set(x.model, (m.get(x.model) ?? 0) + x.cost)
      if (x.created < earliest) earliest = x.created
    }
    return { m, earliest }
  }
  const w5 = per(now - 5 * HOUR)
  const w1 = per(now - DAY)
  const w7 = per(now - 7 * DAY)
  const w30 = per(c30d)
  if (w30.m.size === 0) {
    for (const [model, cost] of sessionSpend) w30.m.set(model, cost)
  }

  const mkRow = (
    label: string,
    win: { m: Map<string, number>; earliest: number },
    share: number,
    resetAt: number | null,
  ): Row => {
    let worst = 0
    for (const [model, cost] of win.m) {
      const allowed = (limits[model] ?? 15) * share
      if (allowed <= 0) continue
      worst = Math.max(worst, cost / allowed)
    }
    const pct = Math.round(Math.min(1, Math.max(0, worst)) * 100)
    const reset = resetAt === null ? "-" : fmtLeft(resetAt - Date.now())
    return { label, pct, reset }
  }

  // 로컬데이터 만 30d 예상치: 세션이 여러 프로젝트 디렉터리에 분산 저장되므로 콘솔 전체 사용량과 차이가 있을 수 있음.

  const now2 = new Date()
  // 5H: 현재 창 최초 요청 + 5h (롤링)
  const r5 = w5.earliest === Infinity ? null : w5.earliest + 5 * HOUR
  const r1 = w1.earliest === Infinity ? null : w1.earliest + DAY  // 주간: 다음 월요일 00:00 로컬 / 월간: 다음달 1일 00:00 로컬
  // 라벨 로케일(en/ko)은 LABELS에서 결정되어 여기서 소비된다.
  const dow = (now2.getDay() + 6) % 7
  const nextMon = new Date(now2)
  nextMon.setDate(now2.getDate() + (7 - dow))
  nextMon.setHours(0, 0, 0, 0)
  const nextMonth = new Date(now2.getFullYear(), now2.getMonth() + 1, 1, 0, 0, 0, 0)

  const rows: Row[] = [
    mkRow(labels.five, w5, 0.2, r5),
    mkRow(labels.day, w1, 0.96, r1),
    mkRow(labels.week, w7, 0.5, nextMon.getTime()),
    mkRow(labels.month, w30, 1.0, nextMonth.getTime()),
  ]
  return rows
}

function fmtLeft(ms: number) {
  if (ms <= 0) return "now"
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}
