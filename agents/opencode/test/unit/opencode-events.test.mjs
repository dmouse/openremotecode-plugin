import assert from "node:assert/strict"
import test from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { openCodeEvents } from "../../dist/opencode-events.js"

test("embedded TUI events use injected fetch, canonical context and headers without global network access", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected global fetch") })
  const controller = new AbortController()
  let cancelled = 0, requests = 0
  const client = createOpencodeClient({ baseUrl: "http://embedded.invalid", directory: "/default",
    headers: { "x-fixture-auth": "synthetic" }, fetch: async (request) => {
      requests++
      assert.equal(request.url, "http://embedded.invalid/event?directory=%2Fworkspace")
      assert.equal(request.headers.get("x-fixture-auth"), "synthetic")
      assert.equal(request.headers.get("accept"), "text/event-stream")
      assert.equal(request.headers.has("x-opencode-directory"), false)
      return new Response(new ReadableStream({ start(stream) {
        for (const text of [': heartbeat\r\n\r\ndata: {"type":"server.connected"}\r',
          '\n\r\ndata: {"type":"message.part.delta",\r\ndata: "properties":{"delta":"fixture"}}\r\n\r\n']) {
          stream.enqueue(new TextEncoder().encode(text))
        }
      }, cancel() { cancelled++ } }), { headers: { "content-type": "text/event-stream" } })
    } })
  const events = openCodeEvents(client, "/workspace", controller.signal)
  assert.equal((await events.next()).value.type, "server.connected")
  assert.equal((await events.next()).value.type, "message.part.delta")
  const waiting = events.next()
  controller.abort()
  assert.equal((await waiting).done, true)
  assert.equal(requests, 1)
  assert.equal(cancelled, 1)
})

test("malformed and oversized native events fail with fixed errors and cancel the source", async () => {
  for (const text of ['data: PRIVATE_INVALID_JSON\n\n', `data: ${'x'.repeat(1_000_001)}`]) {
    let cancelled = false
    const client = createOpencodeClient({ baseUrl: "http://embedded.invalid", fetch: async () =>
      new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(text)) },
        cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } }) })
    await assert.rejects(openCodeEvents(client, "/workspace", new AbortController().signal).next(),
      { message: "Agent event stream unavailable" })
    assert.equal(cancelled, true)
  }
})
