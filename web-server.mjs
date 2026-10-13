import { realpath, stat } from "node:fs/promises"
import { resolve, relative, sep, extname } from "node:path"

const queueLimit = 1024 * 1024
function cleanHeaders(input) {
  const headers = new Headers(input)
  for (const name of [...(headers.get("connection") || "").split(","), "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"]) {
    if (name.trim()) headers.delete(name.trim())
  }
  return headers
}
function inside(root, file) {
  const path = relative(root, file)
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}
function closeCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) || [1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ? code : 1011
}

// Alternate ports are trusted test configuration, never request input.
export async function createWebServer({ distDirectory, port = 49375, upstreamPort = 49374 }) {
  for (const value of [port, upstreamPort]) {
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError("Invalid loopback port")
  }
  if (upstreamPort === 0) throw new RangeError("Upstream port must be assigned")
  const root = await realpath(distDirectory)
  const index = await realpath(resolve(root, "index.html"))
  if (!inside(root, index) || !(await stat(index)).isFile()) throw new Error("Invalid dist index")
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const cookieName = `opencode_session_${upstreamPort}`
  return Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 0,
    async fetch(request, listener) {
      const origin = `http://127.0.0.1:${listener.port}`
      const suppliedOrigin = request.headers.get("origin")
      if (request.headers.get("host") !== `127.0.0.1:${listener.port}` || (suppliedOrigin !== null && suppliedOrigin !== origin)) return new Response("Forbidden", { status: 403 })
      const url = new URL(request.url)
      const proxy = url.pathname.startsWith("/api/") || url.pathname === "/openapi.json"
      const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
      if (proxy && (upgrade ? suppliedOrigin !== origin : suppliedOrigin === null && request.headers.get("sec-fetch-site") !== "same-origin")) return new Response("Forbidden", { status: 403 })
      if (upgrade && (!proxy || !url.pathname.startsWith("/api/"))) return new Response("Forbidden", { status: 403 })
      if (proxy) {
        const headers = cleanHeaders(request.headers)
        headers.set("host", `127.0.0.1:${upstreamPort}`)
        if (suppliedOrigin !== null) headers.set("origin", upstreamOrigin)
        const cookies = (headers.get("cookie") || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
        headers.delete("cookie")
        if (cookies.length) headers.set("cookie", cookies.join("; "))
        const target = `${upstreamOrigin}${url.pathname}${url.search}`
        if (upgrade) {
          for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) headers.delete(name)
          if (listener.upgrade(request, { data: { target: target.replace(/^http:/, "ws:"), headers, upstream: null, queue: [], bytes: 0, closed: false } })) return
          return new Response("Upgrade failed", { status: 400 })
        }
        try {
          const response = await fetch(target, {
            method: request.method, headers, redirect: "manual", signal: request.signal,
            body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
            duplex: "half", decompress: false,
          })
          const outgoing = cleanHeaders(response.headers)
          outgoing.delete("set-cookie")
          for (const cookie of response.headers.getSetCookie()) {
            const parts = cookie.split(";").map(value => value.trim())
            if (!parts[0].startsWith(`${cookieName}=`)) continue
            outgoing.append("set-cookie", [...parts.filter((value, i) => i === 0 || !/^(domain|path)=/i.test(value)), "Path=/"].join("; "))
          }
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
        } catch {
          return new Response("Upstream unavailable", { status: 502 })
        }
      }
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 })
      let path
      try { path = decodeURIComponent(url.pathname) } catch { return new Response("Invalid path", { status: 400 }) }
      if (path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) return new Response("Forbidden", { status: 403 })
      const candidate = resolve(root, `.${path}`)
      if (!inside(root, candidate)) return new Response("Forbidden", { status: 403 })
      let file
      try {
        file = await realpath(candidate)
        if (!inside(root, file)) return new Response("Forbidden", { status: 403 })
        if (!(await stat(file)).isFile()) file = undefined
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return new Response("File unavailable", { status: 500 })
      }
       if (!file && (/^\/_?assets\//.test(path) || extname(path))) return new Response("Not found", { status: 404 })
      file ||= index
       const cache = file === index || /(^|\/)(sw|service-worker)\.[^/]+$/.test(path) ? "no-store" : /^\/_?assets\//.test(path) && /[-.][a-zA-Z0-9_-]{8,}\./.test(path) ? "public, max-age=31536000, immutable" : "no-cache"
      const asset = Bun.file(file)
      return new Response(request.method === "HEAD" ? null : asset, { headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" } })
    },
    websocket: {
      maxPayloadLength: queueLimit,
      open(client) {
        const data = client.data
        const upstream = new WebSocket(data.target, { headers: data.headers })
        data.upstream = upstream
        upstream.binaryType = "arraybuffer"
        upstream.onopen = () => {
          if (data.closed) { upstream.close(1000); return }
          for (const frame of data.queue) upstream.send(frame)
          data.queue = []
          data.bytes = 0
        }
        upstream.onmessage = event => {
          if (!data.closed) client.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data))
        }
        upstream.onerror = () => { client.close(1011, "Upstream unavailable") }
        upstream.onclose = event => { if (!data.closed) client.close(closeCode(event.code), event.reason) }
      },
      message(client, message) {
        const data = client.data
        if (data.upstream?.readyState === WebSocket.OPEN) { data.upstream.send(message); return }
        const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
        if (data.bytes + size > queueLimit) { client.close(1009, "Queue limit"); return }
        data.queue.push(typeof message === "string" ? message : Buffer.from(message))
        data.bytes += size
      },
      close(client, code, reason) {
        const data = client.data
        data.closed = true
        data.queue = []
        if (data.upstream && data.upstream.readyState < WebSocket.CLOSING) data.upstream.close(closeCode(code), reason)
      },
    },
    error() { return new Response("Server error", { status: 500 }) },
  })
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun web-server.mjs <dist-directory>")
  await createWebServer({ distDirectory: process.argv[2] })
}
