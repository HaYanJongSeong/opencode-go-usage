import { expect, test } from "bun:test"
import { collectUsage, parseConsole } from "./usage.mjs"

const expired = { access: null, resumability: "access-ended" }

test("ended Console access is reported as subscription expiry", () => {
  expect(() => parseConsole(expired)).toThrow("expired")
})

for (const [name, body] of [
  ["missing access", { resumability: "access-ended" }],
  ["null status", null],
  ["null access without a reason", { access: null }],
  ["renewing access", { access: null, resumability: "renewing" }],
  ["revoked access", { access: null, resumability: "revoked" }],
  ["malformed meters", { access: { meters: {} }, resumability: "access-ended" }],
]) {
  test(`${name} is not misreported as an expired subscription`, () => {
    expect(() => parseConsole(body)).toThrow("schema")
  })
}

test("expired Go access preserves live Codex quota without exposing credentials", async () => {
  const credentials = {
    opencode: { type: "oauth", access: "fixture-go-secret", metadata: { server: "https://opencode.ai/console" } },
    openai: { type: "oauth", access: "fixture-codex-secret", metadata: { accountID: "fixture-account" } },
  }
  const ctx = {
    provider: { get: async ({ providerID }) => ({ data: { integrationID: providerID } }) },
    integration: { connection: {
      active: async (integrationID) => ({ integrationID }),
      resolve: async ({ integrationID }) => credentials[integrationID],
    } },
  }
  const requests = []

  const result = await collectUsage(ctx, { fetcher: async (url, options) => {
    requests.push([url, options.method])
    const body = url.includes("chatgpt.com")
      ? { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_after_seconds: 60 } } }
      : expired
    return new Response(JSON.stringify(body))
  } })

  expect(result.go.error.code).toBe("expired")
  expect(result.go.windows).toBeUndefined()
  expect(result.codex.windows[0].remainingPercent).toBe(75)
  expect(requests.sort()).toEqual([
    ["https://chatgpt.com/backend-api/wham/usage", "GET"],
    ["https://opencode.ai/console/api/go/status", "GET"],
  ])
  expect(JSON.stringify(result)).not.toContain("fixture-")
})
