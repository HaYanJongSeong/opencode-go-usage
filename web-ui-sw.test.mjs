import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import assert from "node:assert/strict"

const source = await readFile(process.argv[2], "utf8")
const origin = "http://127.0.0.1:49375"

async function navigate(path, offline = false) {
  const listeners = new Map()
  const pending = []
  let response
  let networkReads = 0
  class FetchEvent {}
  const cache = {
    match: async () => new Response("PREVIOUS_BUILD"),
    put: async () => undefined,
    keys: async () => [],
  }
  const caches = { open: async () => cache, match: cache.match, keys: async () => [] }
  const self = {
    caches,
    location: new URL(origin),
    registration: { scope: origin + "/" },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (name, callback) => {
      const callbacks = listeners.get(name) ?? []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
  }
  runInNewContext(source, {
    self,
    location: self.location,
    URL,
    Request,
    Response,
    Headers,
    FetchEvent,
    navigator: { userAgent: "quota-worker-reproduction" },
    caches,
    fetch: async () => {
      networkReads++
      if (offline) throw new TypeError("Offline fixture")
      return new Response("CURRENT_BUILD")
    },
    setTimeout,
    clearTimeout,
    console,
  })
  const request = new Request(origin + path)
  Object.defineProperty(request, "mode", { value: "navigate" })
  const event = Object.assign(new FetchEvent(), {
    request,
    waitUntil: (promise) => pending.push(promise),
    respondWith: (promise) => { response = promise },
  })
  for (const callback of listeners.get("fetch") ?? []) callback(event)
  const result = response ? await response : undefined
  await Promise.all(pending)
  return { body: result ? await result.text() : null, networkReads }
}

for (const path of ["/", "/directory/session"]) {
  const result = await navigate(path)
  console.log(JSON.stringify({ path, ...result }))
  assert.equal(result.body, "CURRENT_BUILD", "Online navigation must use current server HTML")
}
const offline = await navigate("/directory/session", true)
assert.equal(offline.body, "PREVIOUS_BUILD", "Offline navigation must retain cached fallback")
for (const path of ["/api/session", "/auth/pair", "/_assets/missing.js", "/assets/missing.js"]) {
  assert.equal((await navigate(path)).body, null, "API/auth/assets must bypass HTML navigation cache")
}
console.log("Navigation network-first, offline fallback and route exclusions passed")
