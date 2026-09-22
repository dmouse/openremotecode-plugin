import assert from "node:assert/strict"
import test from "node:test"

import { generateConnectorIdentity } from "@openremotecode/protocol"
import { RelayConnection } from "../../dist/relay-connection.js"

test("authenticated reconnect acquires a new single-use ticket", async () => {
  const originalWebSocket = globalThis.WebSocket
  const sockets = []
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = FakeWebSocket.CONNECTING
    sent = []

    constructor(url, protocols) {
      super()
      this.url = String(url)
      this.protocols = protocols
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.dispatchEvent(new Event("open"))
      })
    }

    send(value) { this.sent.push(value) }
    receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }
  globalThis.WebSocket = FakeWebSocket

  const connector = await generateConnectorIdentity()
  let tickets = 0
  const relay = new RelayConnection({
    admissionProvider: async () => {
      tickets += 1
      return {
        url: new URL("wss://relay.example.test/v1/relay"),
        protocols: ["opencode-remote.v1", `ticket.ort_${String(tickets).padStart(43, "a")}`],
        expiresAt: Date.now() + 30_000,
      }
    },
    hello: {
      protocolVersion: 2,
      type: "connector.hello",
      pluginVersion: "test",
      identity: connector.identity.publicIdentity,
      capabilities: ["session.list"],
    },
    log: async () => {},
  })

  try {
    relay.start()
    await waitFor(() => sockets.length === 1)
    await waitFor(() => sockets[0].sent.length === 1)
    sockets[0].receive({
      protocolVersion: 2,
      type: "relay.ready",
      role: "connector",
      keyId: connector.identity.publicIdentity.keyId,
    })
    sockets[0].close()
    await waitFor(() => sockets.length === 2, 1_000)

    assert.equal(tickets, 2)
    assert.notDeepEqual(sockets[0].protocols, sockets[1].protocols)
    assert.equal(sockets[0].url, "wss://relay.example.test/v1/relay")
    assert.equal(JSON.parse(sockets[0].sent[0]).identity.keyId, connector.identity.publicIdentity.keyId)
  } finally {
    await relay.stop()
    globalThis.WebSocket = originalWebSocket
  }
})

test("a connection that is evicted right after admission does not reset the reconnect backoff", async () => {
  const originalWebSocket = globalThis.WebSocket
  const connectedAt = []
  class EvictedWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = EvictedWebSocket.CONNECTING

    constructor() {
      super()
      connectedAt.push(Date.now())
      queueMicrotask(() => {
        this.readyState = EvictedWebSocket.OPEN
        this.dispatchEvent(new Event("open"))
      })
    }

    // The relay admits the connector, then evicts it because another instance with the same
    // identity connected: the shape of two OpenCode directories sharing one identity.
    send() {
      if (this.readyState !== EvictedWebSocket.OPEN) return
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          protocolVersion: 2, type: "relay.ready", role: "connector", keyId: connectorKeyId,
        }) }))
        this.close()
      })
    }
    close() {
      if (this.readyState === EvictedWebSocket.CLOSED) return
      this.readyState = EvictedWebSocket.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }
  globalThis.WebSocket = EvictedWebSocket

  const connector = await generateConnectorIdentity()
  const connectorKeyId = connector.identity.publicIdentity.keyId
  const relay = new RelayConnection({
    admissionProvider: async () => ({
      url: new URL("wss://relay.example.test/v1/relay"),
      protocols: ["opencode-remote.v1", `ticket.ort_${"a".repeat(43)}`],
      expiresAt: Date.now() + 30_000,
    }),
    hello: {
      protocolVersion: 2,
      type: "connector.hello",
      pluginVersion: "test",
      identity: connector.identity.publicIdentity,
      capabilities: ["session.list"],
    },
    log: async () => {},
  })

  try {
    relay.start()
    await waitFor(() => connectedAt.length === 4, 4_000)
    const gaps = connectedAt.slice(1).map((time, index) => time - connectedAt[index])
    // Resetting the backoff on every admission would keep every gap at the 250ms base delay
    // (at most ~312ms with jitter), and two evicting instances would retry at ~4Hz forever.
    assert.ok(gaps[2] >= 500, `reconnect delay must keep growing across quick evictions, got ${JSON.stringify(gaps)}`)
    assert.ok(gaps[2] > gaps[0], `reconnect delay must keep growing across quick evictions, got ${JSON.stringify(gaps)}`)
  } finally {
    await relay.stop()
    globalThis.WebSocket = originalWebSocket
  }
})

async function waitFor(predicate, timeout = 500) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for relay state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function senderFixture(t, authenticated = false, options = {}) {
  const originalWebSocket = globalThis.WebSocket, sockets = [], senders = []
  const state = { disconnected: 0, handle: async () => undefined }
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = 0
    bufferedAmount = 0
    sent = []
    constructor() {
      super(); sockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")) })
    }
    send(value) { this.sent.push(value) }
    receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
    close(code) {
      // Real WebSocket clients only accept 1000 or 3000-4999; anything else throws
      // InvalidAccessError, so a fake that swallows every code hides a broken close path.
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(`invalid code ${String(code)}`, "InvalidAccessError")
      }
      if (this.readyState === 3) return
      this.closeCode = code; this.readyState = 3; this.dispatchEvent(new Event("close"))
    }
  }
  globalThis.WebSocket = FakeWebSocket
  const connector = await generateConnectorIdentity()
  const ready = { protocolVersion: 2, type: "relay.ready", role: "connector", keyId: connector.identity.publicIdentity.keyId }
  const relay = new RelayConnection({
    ...(authenticated ? { admissionProvider: async () => ({ url: new URL("wss://relay.example.test/v1/relay"),
      protocols: [], expiresAt: Date.now() + 30_000 }) } : { url: new URL("ws://127.0.0.1:1234") }),
    hello: { protocolVersion: 2, type: "connector.hello", pluginVersion: "test", identity: connector.identity.publicIdentity,
      capabilities: ["project.mcp.snapshot", "project.mcp.subscribe", "project.mcp.unsubscribe", "project.mcp.updated"] },
    log: async () => {},
    handleMessage: (message) => state.handle(message),
    onReady: (send) => { senders.push(send); return () => { state.disconnected++ } },
    ...(options.onPresence ? { onPresence: options.onPresence } : {}),
  })
  t.after(async () => { await relay.stop(); globalThis.WebSocket = originalWebSocket })
  relay.start(); await waitFor(() => sockets[0]?.sent.length === 1)
  return { relay, sockets, senders, state, ready }
}

test("unsolicited senders bind to admitted socket generations, disconnect cleanly, and never move old replies", async (t) => {
  const f = await senderFixture(t, true)
  assert.equal(f.senders.length, 0, "No event sender before relay admission")
  f.sockets[0].receive(f.ready)
  assert.equal(f.senders[0]({ opaque: "first" }), true)
  let release
  f.state.handle = () => new Promise((resolve) => { release = resolve })
  f.sockets[0].receive({ request: true })
  await waitFor(() => release)
  f.sockets[0].close(1000)
  assert.equal(f.state.disconnected, 1)
  assert.equal(f.senders[0]({ opaque: "stale" }), false)
  await waitFor(() => f.sockets[1]?.sent.length === 1, 1000)
  assert.equal(f.senders.length, 1)
  f.sockets[1].receive(f.ready)
  release({ opaque: "old-reply" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.sockets[1].sent.length, 1)
  assert.equal(f.senders[0]({ opaque: "stale" }), false)
  assert.equal(f.senders[1]({ opaque: "new" }), true)
  await f.relay.stop()
  assert.equal(f.state.disconnected, 2)
  assert.equal(f.senders[1]({ opaque: "disposed" }), false)
})

test("outgoing saturation disconnects instead of buffering unbounded unsolicited events or replies", async (t) => {
  const f = await senderFixture(t, true)
  f.sockets[0].receive(f.ready)
  f.sockets[0].bufferedAmount = 1_999_999
  assert.equal(f.senders[0]({ opaque: "event" }), false)
  assert.equal(f.sockets[0].closeCode, 4013)
  assert.equal(f.sockets[0].sent.length, 1)
  assert.equal(f.state.disconnected, 1)
  await waitFor(() => f.sockets[1]?.sent.length === 1, 1000)
  f.sockets[1].receive(f.ready)
  f.state.handle = async () => ({ opaque: "reply" })
  f.sockets[1].bufferedAmount = 1_999_999
  f.sockets[1].receive({ request: true })
  await waitFor(() => f.sockets[1].closeCode === 4013)
  assert.equal(f.state.disconnected, 2)
  assert.equal(f.sockets[1].sent.length, 1)
})

test("a single oversize outgoing frame closes before send even with an empty socket buffer", async (t) => {
  const f = await senderFixture(t, true)
  f.sockets[0].receive(f.ready)
  assert.equal(f.senders[0]({ opaque: "x".repeat(2_000_000) }), false)
  assert.equal(f.sockets[0].sent.length, 1)
  assert.equal(f.state.disconnected, 1)
  assert.equal(f.sockets[0].closeCode, 4013)
})

test("client presence frames update onPresence and never reach the message handler", async (t) => {
  const presence = []
  const f = await senderFixture(t, true, { onPresence: (connected) => presence.push(connected) })
  f.sockets[0].receive(f.ready)
  f.state.handle = () => { throw new Error("presence frames must not reach the dispatcher") }

  const client = await generateConnectorIdentity()
  f.sockets[0].receive({ protocolVersion: 2, type: "client.hello", identity: client.identity.publicIdentity, nonce: "n".repeat(22) })
  await waitFor(() => presence.length === 1)
  assert.deepEqual(presence, [true])

  f.sockets[0].receive({ protocolVersion: 2, type: "client.offline", keyId: client.identity.publicIdentity.keyId })
  await waitFor(() => presence.length === 2)
  assert.deepEqual(presence, [true, false])
})

test("losing admission reports the client as no longer connected", async (t) => {
  const presence = []
  const f = await senderFixture(t, true, { onPresence: (connected) => presence.push(connected) })
  f.sockets[0].receive(f.ready)
  const client = await generateConnectorIdentity()
  f.sockets[0].receive({ protocolVersion: 2, type: "client.hello", identity: client.identity.publicIdentity, nonce: "n".repeat(22) })
  await waitFor(() => presence.length === 1)

  f.sockets[0].close(1000)
  await waitFor(() => presence.length === 2)
  assert.deepEqual(presence, [true, false])
})

test("a lease nearing expiry is renewed on a second connection that hands off without reconnecting", async (t) => {
  const f = await senderFixture(t, true)
  f.sockets[0].receive({ ...f.ready, authorizationExpiresAt: new Date(Date.now() + 2_000).toISOString() })
  assert.equal(f.senders[0]({ opaque: "before renewal" }), true)

  // The renewal margin (45s) exceeds this lease's remaining lifetime, so the renewal delay
  // floors at its minimum and a second connection opens well ahead of the 2s expiry above.
  await waitFor(() => f.sockets.length === 2, 3_000)
  assert.equal(f.sockets[0].readyState, 1, "the live connection must stay open while renewal is in flight")
  assert.equal(f.senders.length, 1, "no new sender until the renewal actually completes")

  f.sockets[1].receive({ ...f.ready, authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString() })
  await waitFor(() => f.senders.length === 2)

  assert.equal(f.sockets[0].readyState, 3, "the superseded connection is closed once the renewal takes over")
  assert.equal(f.state.disconnected, 1, "the old onReady subscription is torn down exactly once")
  assert.equal(f.senders[0]({ opaque: "stale" }), false)
  assert.equal(f.senders[1]({ opaque: "fresh" }), true)

  // The superseded connection's own close must not be treated as an unexpected drop: it must
  // not schedule a reactive reconnect (a third connection appearing here would mean it did).
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(f.sockets.length, 2)
})

test("a renewal connection that fails before completing leaves the live connection untouched", async (t) => {
  const f = await senderFixture(t, true)
  f.sockets[0].receive({ ...f.ready, authorizationExpiresAt: new Date(Date.now() + 2_000).toISOString() })
  assert.equal(f.senders[0]({ opaque: "before renewal" }), true)

  await waitFor(() => f.sockets.length === 2, 3_000)
  f.sockets[1].close(1000)

  // The failed renewal attempt is abandoned rather than retried immediately; the live
  // connection and its sender are unaffected.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(f.sockets.length, 2)
  assert.equal(f.sockets[0].readyState, 1)
  assert.equal(f.state.disconnected, 0)
  assert.equal(f.senders.length, 1)
  assert.equal(f.senders[0]({ opaque: "still live" }), true)
})
