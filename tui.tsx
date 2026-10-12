// OpenCode Go 사용량 사이드바 위젯
// 콘솔(opencode.ai/console)의 Go 사용량 미터를 그대로 읽어 5H / 주간 / 월간 남은 %와 리셋까지 남은 시간만 표시한다.
// 콘솔 조회가 안 되면(오프라인·토큰 만료) 로컬 세션 기록으로 근사치를 계산하고 값 뒤에 ~ 를 붙인다.
// 옵션(cli.json 또는 opencode.json plugins[].options): { "plan": "go"|"goplus", "refreshSec": 45, "locale": "ko"|"en",
//   "source": "auto"|"api"|"local", "monthlyLimits": {...} }

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount, For, Show } from "solid-js"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const CONSOLE_BASE = "https://opencode.ai/console"
const STATUS_TTL = 15_000 // 콘솔 응답 캐시(ms) — refreshSec이 더 짧아도 콘솔을 초당으로 두드리지 않게

// 콘솔 조회 실패 시 쓰는 로컬 근사용 월 한도(USD) — /v2/docs/console/go
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
    "deepseek-v4.1-flash": 80,
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
type Meter = { usedMicroCents?: string | number; limitMicroCents?: string | number; resetsAt?: string }
type Meters = { fiveHour?: Meter; week?: Meter; month?: Meter }
type Cred = { access: string; orgID?: string }
type Row = { label: string; pct: number; reset: string; approx: boolean }

// 라벨/표기 로케일: options.locale = "ko"(기본) | "en"
// 5칸 고정폭으로 맞추기(터미널 CJK 폭 고려) — 바 우측 정렬 일관성 유지.
const LABELS: Record<string, { five: string; week: string; month: string }> = {
  ko: { five: "5H  ", week: "주간", month: "월간" },
  en: { five: "5H   ", week: "WEEK ", month: "MONTH" },
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
    const source = options.source === "api" || options.source === "local" ? options.source : "auto"

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <GoUsage context={context} limits={limits} labels={labels} refreshMs={refreshMs} source={source} />
      ),
    })
    return () => unregister()
  },
})

function GoUsage(props: {
  context: any
  limits: Record<string, number>
  labels: (typeof LABELS)["ko"]
  refreshMs: number
  source: string
}) {
  const [rows, setRows] = createSignal<Row[]>([])

  onMount(() => {
    const run = async () => {
      try {
        setRows(await buildRows(props.context, props.limits, props.labels, props.source))
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
            const rem = Math.max(0, 100 - r.pct)
            const h = Math.max(0, Math.min(6, Math.round((rem / 100) * 6)))
            const bar = "▓".repeat(h) + "░".repeat(6 - h)
            const fg = rem <= 10 ? "red" : rem <= 40 ? "yellow" : "green"
            return (
              <text fg={fg}>
                {r.label} {bar} {rem}% {"·"} {r.reset}
                {r.approx ? " ~" : ""}
              </text>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

async function buildRows(
  context: any,
  limits: Record<string, number>,
  labels: (typeof LABELS)["ko"],
  source: string,
): Promise<Row[]> {
  if (source !== "local") {
    const meters = await consoleMeters(context)
    if (meters) {
      const rows = rowsFromMeters(meters, labels)
      if (rows.length > 0) return rows
    }
    if (source === "api") return []
  }
  return localRows(context, limits, labels)
}

// ── 콘솔 실시간 미터 ─────────────────────────────────────────────

let cache: { at: number; meters: Meters | null } | null = null

async function consoleMeters(context: any): Promise<Meters | null> {
  if (cache && Date.now() - cache.at < STATUS_TTL) return cache.meters
  let meters: Meters | null = null
  try {
    const cred = await resolveCredential(context)
    if (cred) {
      const headers: Record<string, string> = { authorization: `Bearer ${cred.access}` }
      if (cred.orgID) headers["x-org-id"] = cred.orgID
      const res = await fetch(`${CONSOLE_BASE}/api/go/status`, { headers })
      if (res.ok) {
        const body: any = await res.json()
        meters = body?.access?.meters ?? null
      }
    }
  } catch {}
  cache = { at: Date.now(), meters }
  return meters
}

async function resolveCredential(context: any): Promise<Cred | null> {
  // 1) 플러그인 컨텍스트가 서버 클라이언트를 노출하면 그걸로 (토큰 갱신도 서버가 처리)
  try {
    const conn = await context?.integration?.connection?.active?.("opencode")
    if (conn) {
      const cred: any = await context.integration.connection.resolve(conn)
      if (cred?.access) return { access: cred.access, orgID: cred?.metadata?.orgID }
    }
  } catch {}
  try {
    const list: any = await context?.credential?.list?.()
    const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : []
    for (const item of arr) {
      const parsed = parseCredential(item?.value ?? item)
      if (parsed) return parsed
    }
  } catch {}
  // 2) 로컬 DB에서 직접 (opencode 자체 로그인 토큰)
  return credentialFromDb()
}

function parseCredential(raw: any): Cred | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw
    if (v?.access) return { access: v.access, orgID: v?.metadata?.orgID }
  } catch {}
  return null
}

async function credentialFromDb(): Promise<Cred | null> {
  try {
    const { Database } = await import("bun:sqlite")
    const home = process.env.HOME ?? ""
    const dataHome = process.env.XDG_DATA_HOME ?? `${home}/.local/share`
    const paths = [`${dataHome}/opencode/opencode.db`, `${home}/.local/share/opencode/opencode.db`]
    for (const path of paths) {
      // WAL 모드에선 읽기 전용 열기가 -shm 때문에 실패할 수 있어 일반 열기까지 시도한다(읽기만 함).
      for (const opts of [{ readonly: true, create: false }, { create: false }]) {
        try {
          const db: any = new Database(path, opts)
          const row: any = db
            .query("select value from credential where integration_id = 'opencode' and active = 1 limit 1")
            .get()
          db.close()
          const cred = parseCredential(row?.value)
          if (cred) return cred
        } catch {}
      }
    }
  } catch {}
  return null
}

function rowsFromMeters(meters: Meters, labels: (typeof LABELS)["ko"]): Row[] {
  const mk = (label: string, meter?: Meter): Row | null => {
    if (!meter) return null
    const limit = Number(meter.limitMicroCents ?? 0)
    const used = Number(meter.usedMicroCents ?? 0)
    const pct = limit > 0 ? Math.round(Math.min(1, Math.max(0, used / limit)) * 100) : 0
    const at = meter.resetsAt ? Date.parse(meter.resetsAt) : NaN
    return { label, pct, reset: Number.isFinite(at) ? fmtLeft(at - Date.now()) : "-", approx: false }
  }
  const rows = [mk(labels.five, meters.fiveHour), mk(labels.week, meters.week), mk(labels.month, meters.month)]
  return rows.filter((r): r is Row => r !== null)
}

// ── 로컬 근사(콘솔 조회 실패 시) ────────────────────────────────

async function localRows(
  context: any,
  limits: Record<string, number>,
  labels: (typeof LABELS)["ko"],
): Promise<Row[]> {
  const now = Date.now()
  const c30d = now - 30 * DAY

  const msgs: Msg[] = []
  let sessions: any[] = []
  try {
    sessions = context.data.session.list() ?? []
  } catch {
    sessions = []
  }
  for (const s of sessions) {
    if ((s?.time?.updated ?? 0) < c30d) continue
    const model = s?.model?.id ?? "unknown"
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
  const w7 = per(now - 7 * DAY)
  const w30 = per(c30d)

  const mkRow = (
    label: string,
    win: { m: Map<string, number>; earliest: number },
    share: number,
    resetAt: number | null,
  ): Row => {
    let worst = 0
    for (const [model, cost] of win.m) {
      const allowed = (limits[model] ?? 0) * share
      if (allowed <= 0) continue
      worst = Math.max(worst, cost / allowed)
    }
    const pct = Math.round(Math.min(1, Math.max(0, worst)) * 100)
    const reset = resetAt === null ? "-" : fmtLeft(resetAt - Date.now())
    return { label, pct, reset, approx: true }
  }

  const now2 = new Date()
  const r5 = w5.earliest === Infinity ? null : w5.earliest + 5 * HOUR
  const dow = (now2.getDay() + 6) % 7
  const nextMon = new Date(now2)
  nextMon.setDate(now2.getDate() + (7 - dow))
  nextMon.setHours(0, 0, 0, 0)
  const nextMonth = new Date(now2.getFullYear(), now2.getMonth() + 1, 1, 0, 0, 0, 0)

  return [
    mkRow(labels.five, w5, 0.2, r5),
    mkRow(labels.week, w7, 0.5, nextMon.getTime()),
    mkRow(labels.month, w30, 1.0, nextMonth.getTime()),
  ]
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
