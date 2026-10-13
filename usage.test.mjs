import { mkdir, writeFile } from "node:fs/promises"
import { setupUsage } from "./index.mjs"
import { collectUsage, parseCodex, parseConsole, parseLegacy, usageMarkdown } from "./usage.mjs"

export const resultsFile = "/data/data/com.termux/files/usr/tmp/opencode/go-codex-usage-qa/results.json"
const now = Date.parse("2026-10-13T00:00:00Z")
const date = "2026-10-14T00:00:00Z"
const consoleBody = { access: { meters: { fiveHour: { usedMicroCents: "25", limitMicroCents: "100", resetsAt: date } } } }
const codexBody = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 3600, reset_after_seconds: 60 } } }
const consoleCred = { type: "oauth", access: "fixture-console-secret", metadata: { server: "https://opencode.ai/console", orgID: "fixture-org-private" } }
const codexCred = { type: "oauth", access: "fixture-codex-secret", metadata: { accountID: "fixture-account-private" } }
function assert(value) { if (!value) throw new Error("Assertion failed") }
function fails(fn) {
  let failed = false
  try { fn() } catch { failed = true }
  assert(failed)
}
function mock({ go = consoleCred, codex = codexCred, integration = "opencode", legacy = false } = {}) {
  const calls = [], commands = [], tools = [], prompts = [], registrations = []
  const ctx = {
    rpc: { register: async (definition, handlers) => { registrations.push({ definition, handlers }) } },
    provider: { get: async ({ providerID }) => {
      calls.push(["provider", providerID])
      return { data: providerID === "openai" ? { integrationID: "openai" } : providerID === (legacy ? "opencode-go" : "opencode") ? { integrationID: integration } : undefined }
    } },
    integration: { connection: {
      active: async (id) => { calls.push(["active", id]); return { id } },
      resolve: async (connection) => connection.id === "openai" ? codex : go,
    } },
    command: { transform: async (fn) => fn({ add: (item) => commands.push(item) }) },
    tool: { transform: async (fn) => fn({ add: (item) => tools.push(item) }) },
    session: { prompt: async (input) => { prompts.push(input) } },
  }
  return { ctx, calls, commands, tools, prompts, registrations }
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }) }
function fakeFetch(url) { return Promise.resolve(json(url.includes("chatgpt.com") ? codexBody : consoleBody)) }

export async function runTests() {
  const tests = []
  async function test(name, fn) {
    try { await fn(); tests.push({ name, passed: true }) }
    catch { tests.push({ name, passed: false }) }
  }
  await test("25 percent used means 75 remaining", () => {
    assert(parseConsole(consoleBody)[0].remainingPercent === 75)
    assert(parseCodex(codexBody, now).windows[0].remainingPercent === 75)
  })
  await test("missing fields and zero limits are errors", () => {
    for (const meter of [{}, { usedMicroCents: 0, limitMicroCents: 0, resetsAt: date }, { usedMicroCents: -1, limitMicroCents: 100, resetsAt: date }]) {
      fails(() => parseConsole({ access: { meters: { month: meter } } }))
    }
    fails(() => parseConsole({ access: { meters: {} } }))
    fails(() => parseCodex({ rate_limit: { primary_window: {} } }, now))
  })
  await test("live Console zero-use window with null reset retains all quotas", () => {
    const windows = parseConsole({ access: { meters: {
      fiveHour: { usedMicroCents: "0", limitMicroCents: "1200000000", resetsAt: null },
      week: { usedMicroCents: "1259460483", limitMicroCents: "3000000000", resetsAt: date },
      month: { usedMicroCents: "4875681078", limitMicroCents: "6000000000", resetsAt: date },
    } } })
    assert(windows.length === 3 && windows[0].remainingPercent === 100 && windows[0].resetsAt === null)
    assert(windows[1].remainingPercent === 58.02 && windows[2].remainingPercent === 18.74)
    const output = usageMarkdown({ checkedAt: new Date(now).toISOString(), go: { label: "Go", windows }, codex: parseCodex(codexBody, now) })
    assert(output.includes("리셋 시각 미제공") && !output.includes("schema"))
    fails(() => parseConsole({ access: { meters: { fiveHour: { usedMicroCents: "0", limitMicroCents: "100" } } } }))
  })
  await test("BigInt counters and over-limit saturation", () => {
    const row = (used, limit) => parseConsole({ access: { meters: { month: { usedMicroCents: used, limitMicroCents: limit, resetsAt: date } } } })[0]
    assert(row("250000000000000000000000", "1000000000000000000000000").usedPercent === 25)
    assert(row("101", "100").usedPercent === 100)
    fails(() => row(Number.MAX_SAFE_INTEGER + 1, "100"))
  })
  await test("strict finite percent range", () => {
    for (const value of [undefined, null, "25", NaN, Infinity, -1, 101]) {
      fails(() => parseCodex({ rate_limit: { primary_window: { ...codexBody.rate_limit.primary_window, used_percent: value } } }, now))
    }
  })
  await test("dynamic windows and truthful plan labels", () => {
    const parsed = parseCodex({ ...codexBody, plan_type: "plus", additional_rate_limits: [{ unknown: true }] }, now)
    assert(parsed.label === "Codex" && parsed.windows[0].name === "1h")
    assert(!parsed.windows.some((row) => row.name === "5h"))
    assert(parseCodex(codexBody, now).label === "Codex (Pro)")
    assert(parsed.windows[0].resetsAt === "2026-10-13T00:01:00.000Z")
  })
  await test("absolute reset and validated additional windows", () => {
    const meter = { used_percent: 50, limit_window_seconds: 604800, reset_at: now / 1000 + 60 }
    const parsed = parseCodex({ ...codexBody, additional_rate_limits: [{ rate_limit: { secondary_window: meter } }] }, now)
    assert(parsed.windows[1].name === "추가 7d" && parsed.windows[1].remainingPercent === 50)
    fails(() => parseCodex({ rate_limit: { primary_window: { ...meter, reset_at: "secret" } } }, now))
  })
  await test("legacy known schema only", () => {
    assert(parseLegacy({ usage: { rolling: { status: "ok", percent: 25, resetsAt: date } } })[0].remainingPercent === 75)
    fails(() => parseLegacy({ usage: { rolling: { status: "unknown", percent: 25, resetsAt: date } } }))
  })
  await test("selected provider data and direct credentials", async () => {
    const m = mock(), requests = []
    const result = await collectUsage(m.ctx, { now, fetcher: async (url, options) => {
      requests.push({ url, options }); return fakeFetch(url)
    } })
    assert(result.go.windows[0].remainingPercent === 75 && result.codex.windows[0].remainingPercent === 75)
    const go = requests.find((r) => r.url === "https://opencode.ai/console/api/go/status")
    const codex = requests.find((r) => r.url === "https://chatgpt.com/backend-api/wham/usage")
    assert(go.options.headers["x-org-id"] === consoleCred.metadata.orgID)
    assert(codex.options.headers["ChatGPT-Account-Id"] === codexCred.metadata.accountID)
    assert(requests.every((r) => r.options.redirect === "error" && r.options.method === "GET" && r.options.signal))
    assert(m.calls.some(([method, id]) => method === "active" && id === "opencode"))
  })
  await test("collectors start in parallel", async () => {
    const m = mock(), started = []
    let release, parallel = false, expired = false
    const gate = new Promise((resolve) => { release = resolve })
    const timer = setTimeout(() => { expired = true; release() }, 100)
    try {
      await collectUsage(m.ctx, { now, fetcher: async (url) => {
        started.push(url)
        if (started.length === 2) { parallel = !expired; release() }
        await gate
        return fakeFetch(url)
      } })
      assert(parallel && started.length === 2)
    } finally { clearTimeout(timer) }
  })
  await test("OpenAI key is not Codex OAuth", async () => {
    const m = mock({ codex: { type: "key", key: "fixture-key" } }), urls = []
    const result = await collectUsage(m.ctx, { fetcher: async (url) => { urls.push(url); return fakeFetch(url) }, now })
    assert(result.codex.error.code === "auth" && !urls.some((url) => url.includes("chatgpt.com")))
  })
  await test("foreign integration OAuth never sent to Codex", async () => {
    const m = mock(), urls = []
    const get = m.ctx.provider.get
    m.ctx.provider.get = async (input) => input.providerID === "openai" ? { data: { integrationID: "foreign" } } : get(input)
    const resolve = m.ctx.integration.connection.resolve
    m.ctx.integration.connection.resolve = async (connection) => connection.id === "foreign" ? codexCred : resolve(connection)
    const result = await collectUsage(m.ctx, { now, fetcher: async (url) => { urls.push(url); return fakeFetch(url) } })
    assert(result.codex.error.code === "auth" && !urls.some((url) => url.includes("chatgpt.com")))
  })
  await test("Console key and legacy key destinations", async () => {
    for (const legacy of [false, true]) {
      const m = mock({ legacy, integration: legacy ? "opencode-go" : "opencode", go: { type: "key", key: "fixture-key", metadata: consoleCred.metadata } })
      const urls = []
      const result = await collectUsage(m.ctx, { now, fetcher: async (url) => {
        urls.push(url)
        return json(url.includes("chatgpt.com") ? codexBody : legacy ? { usage: { weekly: { status: "ok", percent: 25, resetsAt: date } } } : consoleBody)
      } })
      assert(!result.go.error)
      assert(urls.includes(legacy ? "https://opencode.ai/zen/go/v1/usage" : "https://opencode.ai/console/api/go/status"))
    }
  })
  await test("Console OAuth never sent to legacy or arbitrary origin", async () => {
    for (const settings of [{ integration: "opencode-go" }, { go: { ...consoleCred, metadata: { server: "https://example.com" } } }]) {
      const urls = []
      const result = await collectUsage(mock(settings).ctx, { now, fetcher: async (url) => { urls.push(url); return fakeFetch(url) } })
      assert(result.go.error && urls.every((url) => url.includes("chatgpt.com")))
    }
  })
  await test("HTTP errors sanitized", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limit"], [500, "http"], [302, "http"]]) {
      const result = await collectUsage(mock().ctx, { now, fetcher: async () => json({ secret: "fixture-secret" }, status) })
      assert(result.go.error.code === code && !JSON.stringify(result).includes("fixture-secret"))
    }
  })
  await test("redirect rejection and raw errors sanitized", async () => {
    const result = await collectUsage(mock().ctx, { now, fetcher: async () => { throw new Error("fixture-secret redirect blocked") } })
    assert(result.go.error.code === "network" && !JSON.stringify(result).includes("fixture-secret"))
  })
  await test("timeout and cancellation", async () => {
    const abortingFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"))
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
    assert((await collectUsage(mock().ctx, { now, fetcher: abortingFetch, timeoutMs: 1 })).go.error.code === "timeout")
    const controller = new AbortController(); controller.abort()
    assert((await collectUsage(mock().ctx, { now, fetcher: abortingFetch, signal: controller.signal })).go.error.code === "cancelled")
  })
  await test("response cap, invalid JSON, invalid schema", async () => {
    for (const [factory, code] of [
      [() => new Response("x".repeat(131073)), "size"],
      [() => new Response("{}", { headers: { "content-length": "131073" } }), "size"],
      [() => new Response("not JSON"), "json"],
      [() => json({ cost: 0 }), "schema"],
    ]) assert((await collectUsage(mock().ctx, { now, fetcher: async () => factory() })).go.error.code === code)
  })
  await test("no tokens account identifiers or local zero-cost estimates", async () => {
    const m = mock()
    m.ctx.data = { session: { list: () => { throw new Error("Local records must not be read") } } }
    const result = await collectUsage(m.ctx, { now, fetcher: fakeFetch })
    const output = JSON.stringify(result) + usageMarkdown(result)
    assert(!/fixture-|accountID|orgID|accessMicro/.test(output))
    assert(output.includes("75%") && output.includes("응답 전 조회값"))
  })
  await test("missing auth never manufactures 100 percent", async () => {
    const absent = await collectUsage(mock({ go: null, codex: null }).ctx, { now, fetcher: fakeFetch })
    assert(absent.go.error.code === "auth" && absent.codex.error.code === "auth")
    assert(!usageMarkdown(absent).includes("100%"))
  })
  await test("mobile output uses relative resets and no raw ISO timestamp", () => {
    const output = usageMarkdown({ checkedAt: new Date(now).toISOString(), go: { label: "Go", windows: parseConsole(consoleBody) }, codex: parseCodex(codexBody, now) })
    assert(output.includes("리셋 약 1일 후") && output.includes("리셋 약 1분 후"))
    assert(!output.includes("T00:") && output.includes("남음 **75%**"))
  })
  await test("commands preserve session delivery and call model once", async () => {
      for (const name of ["사용량", "left"]) {
        const m = mock(); await setupUsage(m.ctx, { fetcher: fakeFetch })
        const command = m.commands.find((item) => item.name === name)
        await command.execute({ sessionID: "fixture-session", delivery: "queue", prompt: { text: `/${name}` } })
        assert(m.prompts.length === 1 && m.prompts[0].sessionID === "fixture-session" && m.prompts[0].delivery === "queue")
        assert(m.prompts[0].text.includes("도구 호출") && !m.prompts[0].text.includes("fixture-secret"))
      }
  })
  await test("invalid command arguments cause no network or model", async () => {
    const m = mock(); await setupUsage(m.ctx, { fetcher: async () => { throw new Error("No network allowed") } })
    for (const text of ["/사용량 unknown", "/사용량 test extra", "/사용량x", "unknown"]) {
      let rejected = false
      try { await m.commands[0].execute({ sessionID: "fixture", prompt: { text }, delivery: "steer" }) } catch { rejected = true }
      assert(rejected)
    }
    assert(m.calls.length === 0 && m.prompts.length === 0)
  })
  await test("tool returns parsed JSON without model calls", async () => {
      const m = mock(); await setupUsage(m.ctx, { fetcher: fakeFetch })
      const output = await m.tools[0].execute({}, { signal: new AbortController().signal })
      assert(m.tools[0].name === "usage_status" && JSON.parse(output.content).go.windows[0].remainingPercent === 75)
      assert(m.prompts.length === 0 && !output.content.includes("fixture-"))
  })
  await test("quota RPC returns API snapshot without model or message", async () => {
    const m = mock(); await setupUsage(m.ctx, { fetcher: fakeFetch })
    assert(m.registrations.length === 1 && m.registrations[0].definition.id === "go-codex-quota")
    const snapshot = await m.registrations[0].handlers.read({}, { signal: new AbortController().signal })
    assert(snapshot.go.windows[0].remainingPercent === 75 && snapshot.codex.windows[0].remainingPercent === 75)
    assert(m.prompts.length === 0 && !JSON.stringify(snapshot).includes("fixture-"))
  })
  const result = { passed: tests.every((item) => item.passed), total: tests.length, tests, resultsFile }
  await mkdir(resultsFile.slice(0, resultsFile.lastIndexOf("/")), { recursive: true })
  await writeFile(resultsFile, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
  return result
}
