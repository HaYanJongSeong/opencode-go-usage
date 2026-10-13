import { test, beforeAll, afterAll } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { createWebServer } from "./web-server.mjs"

let directory, upstream, proxy, origin, cookieName, lastRequest, streamController, streamCancelled
let releaseHandshake, handshakeEntered
const handshakeGate = new Promise(resolve => { releaseHandshake = resolve })
const handshakePending = new Promise(resolve => { handshakeEntered = resolve })
const cancelled = new Promise(resolve => { streamCancelled = resolve })
beforeAll(async () => {
  directory = await mkdtemp("/data/data/com.termux/files/usr/tmp/opencode/web-proxy-")
  await mkdir(`${directory}/dist/assets`, { recursive: true })
  await writeFile(`${directory}/dist/index.html`, "<html>upstream build</html>")
  await writeFile(`${directory}/dist/assets/app-abcdefgh.js`, "export default 1")
  await writeFile(`${directory}/dist/sw.js`, "self.addEventListener('fetch',()=>{})")
  await writeFile(`${directory}/private.txt`, "outside")
  await symlink(`${directory}/private.txt`, `${directory}/dist/leak.txt`)
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname
      lastRequest = { headers: new Headers(request.headers), path }
      if (path === "/api/pty" || path === "/api/queued") {
        if (path === "/api/queued") { handshakeEntered(); await handshakeGate }
        if (server.upgrade(request)) return
        return new Response(null, { status: 400 })
      }
      if (path === "/api/ws-fail") return new Response(null, { status: 503 })
      if (path === "/api/auth" && request.headers.get("authorization") !== "Bearer fixture" && request.headers.get("cookie") !== `${cookieName}=fixture`) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } })
      if (path === "/api/login") return new Response("login", { headers: [["set-cookie", `${cookieName}=fixture; HttpOnly; SameSite=Strict; Path=/api; Domain=127.0.0.1`], ["set-cookie", "unrelated=blocked; Path=/"]] })
      if (path === "/api/redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/unchanged" } })
      if (path === "/api/event") return new Response(new ReadableStream({
        start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode("data: first\n\n")) },
        cancel() { streamCancelled() },
      }), { headers: { "content-type": "text/event-stream" } })
      if (path === "/api/body") return new Response(await request.text())
      return new Response("ok")
    },
    websocket: { message(socket, message) { socket.send(message) } },
  })
  cookieName = `opencode_session_${upstream.port}`
  proxy = await createWebServer({ distDirectory: `${directory}/dist`, port: 0, upstreamPort: upstream.port })
  origin = `http://127.0.0.1:${proxy.port}`
})
afterAll(async () => {
  proxy?.stop(true)
  upstream?.stop(true)
  if (directory) await rm(directory, { recursive: true })
})
function request(path, headers = {}, options = {}) {
  return fetch(`${origin}${path}`, { ...options, headers, redirect: "manual" })
}

for (const path of ["/", "/assets/app-abcdefgh.js", "/api/auth", "/openapi.json"]) {
  for (const rejectedOrigin of ["null", "https://evil.invalid", "http://127.0.0.1:49374"]) {
    test(`rejects ${rejectedOrigin} Origin for ${path}`, async () => { assert.equal((await request(path, { origin: rejectedOrigin })).status, 403) })
  }
  test(`rejects hostile Host for ${path}`, async () => { assert.equal((await request(path, { host: "evil.invalid", origin })).status, 403) })
}
for (const site of [undefined, "cross-site", "same-site", "none"]) {
  test(`rejects API without Origin with Fetch-Site ${site}`, async () => { assert.equal((await request("/api/auth", site ? { "sec-fetch-site": site } : {})).status, 403) })
}
test("preserves unauthenticated upstream 401", async () => {
  const response = await request("/api/auth", { "sec-fetch-site": "same-origin" })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("www-authenticate"), "Bearer")
  assert.equal(await response.text(), "unauthorized")
})
test("transforms validated Host and Origin while preserving authorization", async () => {
  assert.equal((await request("/api/auth", { origin, authorization: "Bearer fixture" })).status, 200)
  assert.equal(lastRequest.headers.get("host"), `127.0.0.1:${upstream.port}`)
  assert.equal(lastRequest.headers.get("origin"), `http://127.0.0.1:${upstream.port}`)
  assert.equal(lastRequest.headers.get("authorization"), "Bearer fixture")
})
test("roundtrips only host-scoped upstream session cookie at root", async () => {
  const login = await request("/api/login", { origin })
  assert.deepEqual(login.headers.getSetCookie(), [`${cookieName}=fixture; HttpOnly; SameSite=Strict; Path=/`])
  const response = await request("/api/auth", { origin, cookie: `other=secret; ${cookieName}=fixture; opencode_session_9999=blocked` })
  assert.equal(response.status, 200)
  assert.equal(lastRequest.headers.get("cookie"), `${cookieName}=fixture`)
})
test("streams POST request body", async () => {
  const response = await request("/api/body", { origin }, { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("body bytes")); c.close() } }), duplex: "half" })
  assert.equal(await response.text(), "body bytes")
})
test("does not follow or rewrite upstream redirects", async () => {
  const response = await request("/api/redirect", { origin })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get("location"), "https://example.invalid/unchanged")
})
test("serves existing build and SPA routes without caching index", async () => {
  const response = await request("/session/abc")
  assert.equal(await response.text(), "<html>upstream build</html>")
  assert.equal(response.headers.get("cache-control"), "no-store")
})
test("caches hashed assets but never the service worker", async () => {
  const asset = await request("/assets/app-abcdefgh.js")
  assert.equal(await asset.text(), "export default 1")
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable")
  assert.equal((await request("/sw.js")).headers.get("cache-control"), "no-store")
})
for (const path of ["/assets/missing", "/missing.js"]) {
  test(`returns 404 rather than SPA for ${path}`, async () => { assert.equal((await request(path)).status, 404) })
}
for (const path of ["/%2e%2e%2fprivate.txt", "/leak.txt", "/%5cprivate.txt"]) {
  test(`rejects filesystem escape ${path}`, async () => { assert.equal((await request(path)).status, 403) })
}
test("streams SSE chunks before completion and cancels upstream on abort", async () => {
  const abort = new AbortController()
  const response = await request("/api/event", { origin }, { signal: abort.signal })
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n")
  streamController.enqueue(new TextEncoder().encode("data: second\n\n"))
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: second\n\n")
  abort.abort()
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE cancellation timed out")), 2000))])
})
test("WS echoes queued text and binary with validated transformed headers", async () => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/pty?ticket=synthetic`, { headers: { origin, authorization: "Bearer fixture", cookie: `${cookieName}=fixture; other=blocked` } })
  socket.binaryType = "arraybuffer"
  const frames = []
  await new Promise((resolve, reject) => {
    socket.onopen = () => { socket.send("text"); socket.send(new Uint8Array([0, 128, 255])) }
    socket.onerror = () => reject(new Error("WS failed"))
    socket.onmessage = event => { frames.push(event.data); if (frames.length === 2) resolve() }
  })
  assert.equal(frames[0], "text")
  assert.deepEqual(new Uint8Array(frames[1]), new Uint8Array([0, 128, 255]))
  assert.equal(lastRequest.headers.get("origin"), `http://127.0.0.1:${upstream.port}`)
  assert.equal(lastRequest.headers.get("cookie"), `${cookieName}=fixture`)
  assert.equal(lastRequest.headers.get("authorization"), "Bearer fixture")
  const closed = new Promise(resolve => { socket.onclose = resolve })
  socket.close(1000, "done")
  assert.equal((await closed).code, 1000)
})
for (const suppliedOrigin of [undefined, "null", "https://evil.invalid"]) {
  test(`rejects WS handshake Origin ${suppliedOrigin}`, async () => {
    const response = await request("/api/pty", { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), "sec-fetch-site": "same-origin" })
    assert.equal(response.status, 403)
  })
}
test("closes downstream WS 1011 on upstream handshake failure", async () => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws-fail`, { headers: { origin } })
  const closed = await new Promise((resolve, reject) => { socket.onclose = resolve; socket.onerror = () => reject(new Error("Downstream handshake failed")) })
  assert.equal(closed.code, 1011)
})
test("bounds queued WS frames while upstream handshake is pending", async () => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/queued`, { headers: { origin } })
  try {
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("Downstream handshake failed")) })
    await handshakePending
    const closed = new Promise(resolve => { socket.onclose = resolve })
    socket.send(new Uint8Array(600000))
    socket.send(new Uint8Array(600000))
    assert.equal((await closed).code, 1009)
  } finally { releaseHandshake(); socket.close() }
})
test("returns 502 when the fixed upstream is unavailable", async () => {
  const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("unused") } })
  const upstreamPort = unavailable.port
  unavailable.stop(true)
  const isolated = await createWebServer({ distDirectory: `${directory}/dist`, port: 0, upstreamPort })
  try {
    const isolatedOrigin = `http://127.0.0.1:${isolated.port}`
    assert.equal((await fetch(`${isolatedOrigin}/api/auth`, { headers: { origin: isolatedOrigin } })).status, 502)
  } finally { isolated.stop(true) }
})
test("closes WS 1011 when the fixed upstream refuses connection", async () => {
  const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("unused") } })
  const upstreamPort = unavailable.port
  unavailable.stop(true)
  const isolated = await createWebServer({ distDirectory: `${directory}/dist`, port: 0, upstreamPort })
  try {
    const isolatedOrigin = `http://127.0.0.1:${isolated.port}`
    const socket = new WebSocket(`${isolatedOrigin.replace("http:", "ws:")}/api/pty`, { headers: { origin: isolatedOrigin } })
    const closed = await new Promise((resolve, reject) => { socket.onclose = resolve; socket.onerror = () => reject(new Error("Downstream handshake failed")) })
    assert.equal(closed.code, 1011)
  } finally { isolated.stop(true) }
})
