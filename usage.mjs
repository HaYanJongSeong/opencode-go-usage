const CONSOLE = "https://opencode.ai/console"
const CODEX = "https://chatgpt.com/backend-api/wham/usage"
const LEGACY = "https://opencode.ai/zen/go/v1/usage"
const MAX_BYTES = 128 * 1024
const errors = {
  auth: "로그인이 없거나 지원되지 않습니다. 해당 제공자 연결을 다시 선택하고 로그인하세요.",
  origin: "공식 Console 연결이 아닙니다. https://opencode.ai/console 연결로 다시 로그인하세요.",
  unauthorized: "인증이 거부되었습니다 (401/403). 해당 제공자에 다시 로그인하세요.",
  rate_limit: "조회 제한입니다 (429). 잠시 후 다시 실행하세요.",
  http: "사용량 서버 오류입니다. 잠시 후 다시 실행하세요.",
  network: "네트워크 또는 리디렉션 오류입니다. 연결을 확인하고 다시 실행하세요.",
  timeout: "조회 시간이 초과되었습니다. 다시 실행하세요.",
  cancelled: "조회가 취소되었습니다.",
  size: "사용량 응답이 크기 제한을 초과했습니다.",
  json: "사용량 서버가 올바른 JSON을 반환하지 않았습니다.",
  expired: "구독기간 만료",
  schema: "지원되지 않거나 불완전한 사용량 형식입니다. 플러그인 계약을 확인하세요. 추정하지 않았습니다.",
}
class UsageError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireValue(valid, code = "schema") {
  if (!valid) throw new UsageError(code)
}
function percent(value) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
  return value
}
function integer(value) {
  requireValue((typeof value === "string" && /^\d+$/.test(value) && value.length <= 512)
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
  return BigInt(value)
}
function reset(value) {
  requireValue(typeof value === "string" || (typeof value === "number" && Number.isFinite(value) && value >= 0))
  const time = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  requireValue(Number.isFinite(time) && Math.abs(time) <= 8.64e15)
  return new Date(time).toISOString()
}
function windowRow(name, used, resetsAt) {
  return { name, usedPercent: percent(used), remainingPercent: Math.round((100 - used) * 100) / 100, resetsAt }
}
export function parseConsole(body) {
  if (body?.access === null && body?.resumability === "access-ended") throw new UsageError("expired")
  const meters = body?.access?.meters
  requireValue(meters && typeof meters === "object")
  const rows = []
  for (const [key, name] of [["fiveHour", "5h"], ["week", "주간"], ["month", "월간"]]) {
    const meter = meters[key]
    if (meter === undefined || meter === null) continue
    const used = integer(meter.usedMicroCents)
    const limit = integer(meter.limitMicroCents)
    requireValue(limit > 0n)
    // BigInt division avoids precision loss in large microcent counters.
    const pct = used >= limit ? 100 : Number((used * 10000n + limit / 2n) / limit) / 100
    rows.push(windowRow(name, pct, meter.resetsAt === null ? null : reset(meter.resetsAt)))
  }
  requireValue(rows.length > 0)
  return rows
}
export function parseLegacy(body) {
  const rows = []
  for (const [key, name] of [["rolling", "롤링"], ["weekly", "주간"], ["monthly", "월간"]]) {
    const meter = body?.usage?.[key]
    if (meter === undefined || meter === null) continue
    requireValue(["ok", "warning", "exceeded"].includes(meter.status))
    rows.push(windowRow(name, percent(meter.percent), reset(meter.resetsAt)))
  }
  requireValue(rows.length > 0)
  return rows
}
function codexWindow(meter, now, prefix) {
  requireValue(Number.isSafeInteger(meter.limit_window_seconds) && meter.limit_window_seconds > 0)
  const seconds = meter.limit_window_seconds
  const name = seconds % 86400 === 0 ? `${seconds / 86400}d` : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds}s`
  let resetsAt
  if (meter.reset_at !== undefined && meter.reset_at !== null) {
    requireValue(typeof meter.reset_at === "number" && Number.isFinite(meter.reset_at) && meter.reset_at >= 0)
    resetsAt = reset(meter.reset_at)
  } else {
    requireValue(Number.isSafeInteger(meter.reset_after_seconds) && meter.reset_after_seconds >= 0)
    resetsAt = reset(now + meter.reset_after_seconds * 1000)
  }
  return windowRow(`${prefix}${name}`, percent(meter.used_percent), resetsAt)
}
export function parseCodex(body, now = Date.now()) {
  const rows = []
  for (const key of ["primary_window", "secondary_window"]) {
    const meter = body?.rate_limit?.[key]
    if (meter !== undefined && meter !== null) rows.push(codexWindow(meter, now, ""))
  }
  // Additional labels are deliberately not echoed: they are untrusted server strings.
  if (Array.isArray(body?.additional_rate_limits)) {
    for (const item of body.additional_rate_limits) {
      for (const key of ["primary_window", "secondary_window"]) {
        const meter = item?.rate_limit?.[key]
        if (!meter || typeof meter.used_percent !== "number" || !Number.isSafeInteger(meter.limit_window_seconds)) continue
        rows.push(codexWindow(meter, now, "추가 "))
      }
    }
  }
  requireValue(rows.length > 0)
  return { label: body?.plan_type === "pro" ? "Codex (Pro)" : "Codex", windows: rows }
}
async function credential(ctx, providerID) {
  const provider = (await ctx.provider.get({ providerID }))?.data
  if (!provider?.integrationID) return undefined
  const connection = await ctx.integration.connection.active(provider.integrationID)
  requireValue(connection, "auth")
  const value = await ctx.integration.connection.resolve(connection)
  requireValue(value, "auth")
  return { integrationID: provider.integrationID, value }
}
async function request(url, headers, fetcher, signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const res = await fetcher(url, { method: "GET", headers, redirect: "error", signal: controller.signal })
    if (!res.ok) {
      if (res.body) await res.body.cancel()
      throw new UsageError(res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 429 ? "rate_limit" : "http")
    }
    if (Number(res.headers.get("content-length")) > MAX_BYTES) {
      if (res.body) await res.body.cancel()
      throw new UsageError("size")
    }
    requireValue(res.body, "json")
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0, text = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new UsageError("size") }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    try { return JSON.parse(text) } catch { throw new UsageError("json") }
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(timedOut ? "timeout" : signal?.aborted ? "cancelled" : "network")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  }
}
export async function collectUsage(ctx, { fetcher = globalThis.fetch, signal, timeoutMs = 10000, now = Date.now() } = {}) {
  const checkedAt = new Date(now).toISOString()
  async function collect(kind) {
    try {
      if (kind === "Codex") {
        const selected = await credential(ctx, "openai")
        const cred = selected?.value
        requireValue(selected?.integrationID === "openai" && cred?.type === "oauth" && typeof cred.access === "string" && cred.access.length > 0
          && typeof cred.metadata?.accountID === "string" && cred.metadata.accountID.length > 0, "auth")
        const body = await request(CODEX, { Authorization: `Bearer ${cred.access}`, "ChatGPT-Account-Id": cred.metadata.accountID }, fetcher, signal, timeoutMs)
        return { ...parseCodex(body, now), checkedAt }
      }
      const selected = await credential(ctx, "opencode") ?? await credential(ctx, "opencode-go")
      requireValue(selected, "auth")
      const { value: cred, integrationID } = selected
      let url, token
      const headers = {}
      if (integrationID === "opencode") {
        requireValue(cred.metadata?.server === CONSOLE, "origin")
        requireValue(cred.type === "oauth" || cred.type === "key", "auth")
        token = cred.type === "oauth" ? cred.access : cred.key
        url = `${CONSOLE}/api/go/status`
        if (cred.metadata?.orgID !== undefined) {
          requireValue(typeof cred.metadata.orgID === "string" && cred.metadata.orgID.length > 0, "auth")
          headers["x-org-id"] = cred.metadata.orgID
        }
      } else {
        requireValue(integrationID === "opencode-go" && cred.type === "key", "auth")
        token = cred.key
        url = LEGACY
      }
      requireValue(typeof token === "string" && token.length > 0, "auth")
      headers.Authorization = `Bearer ${token}`
      const body = await request(url, headers, fetcher, signal, timeoutMs)
      return { label: "Go", checkedAt, windows: url === LEGACY ? parseLegacy(body) : parseConsole(body) }
    } catch (error) {
      const code = error instanceof UsageError ? error.code : "auth"
      return { label: kind, checkedAt, error: { code, message: errors[code] } }
    }
  }
  const [go, codex] = await Promise.all([collect("Go"), collect("Codex")])
  return { checkedAt, go, codex }
}
export function usageMarkdown(snapshot) {
  const checked = Date.parse(snapshot.checkedAt)
  const checkedLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(checked)
  const resetLabel = (at) => {
    if (at === null) return "리셋 시각 미제공"
    const left = Date.parse(at) - checked
    if (left <= 0) return "리셋 시각 도달"
    if (left < 60000) return "리셋 1분 이내"
    const minutes = Math.ceil(left / 60000)
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const rest = minutes % 60
    return `리셋 약 ${days ? `${days}일 ` : ""}${hours ? `${hours}시간 ` : ""}${!days && rest ? `${rest}분 ` : ""}후`
  }
  const lines = ["# 사용량", "", `확인: ${checkedLabel}`]
  for (const section of [snapshot.go, snapshot.codex]) {
    lines.push("", `## ${section.label}`)
    if (section.error) lines.push(`${section.error.message} (${section.error.code})`)
    else for (const row of section.windows) lines.push(`- ${row.name}: 남음 **${row.remainingPercent}%** · ${resetLabel(row.resetsAt)}`)
  }
  lines.push("", "Codex 제한만 표시하며 ChatGPT 전체 사용량이 아닙니다.", "표시를 위해 현재 모델 응답 1회가 실행되어 소량의 사용량/비용이 추가됩니다. 수치는 그 응답 전 조회값입니다.")
  return lines.join("\n")
}
