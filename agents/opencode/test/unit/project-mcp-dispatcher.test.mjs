import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { setImmediate as immediate } from "node:timers/promises"
import test from "node:test"
import { CONNECTOR_CREDENTIAL_CAPABILITIES, decryptRelayEnvelope, encryptRelayPayload, generateConnectorIdentity,
  PROJECT_MCP_CAPABILITIES, projectMcpUpdatedEventSchema } from "@openremotecode/protocol"
import { CommandDispatcher } from "../../dist/command-dispatcher.js"
import { ChatAccessError } from "../../dist/chat-adapter.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/project-mcp-v1.json", import.meta.url), "utf8"))
const flush = async () => { for (let i = 0; i < 8; i++) await immediate() }
const TEST_EPOCH = "e".repeat(43)
async function waitFor(predicate) {
  const deadline = performance.now() + 2000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Synthetic test did not settle")
    await immediate()
  }
}
async function setup(t, enabled = true) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() })
  const connector = (await generateConnectorIdentity()).identity
  const client = (await generateConnectorIdentity()).identity
  const state = { calls: 0, result: fixture.snapshotResponse, read: undefined, events: [], send: true }
  const dispatcher = new CommandDispatcher({ connectorIdentity: connector, trustedClient: client.publicIdentity,
    sessions: { listSessions: async () => [] }, ...(enabled ? { mcp: { readProjectMcp: async (projectId, signal) => {
      state.calls++
      return state.read ? state.read(projectId, signal) : state.result
    } } } : {}) })
  t.after(() => dispatcher.dispose())
  dispatcher.setEpoch(TEST_EPOCH)
  const disconnect = dispatcher.attachRelay((envelope) => { state.events.push(envelope); return state.send })
  let sequence = 0
  const request = (operation, body, requestId = crypto.randomUUID(), sender = client, kind = "request") => encryptRelayPayload({
    sender, recipient: connector.publicIdentity, epoch: TEST_EPOCH, sequence: sequence++,
    payload: { protocolVersion: 2, kind, operation, body, requestId, sentAt: Date.now() },
  })
  const decode = (envelope) => decryptRelayEnvelope({ recipient: client, sender: connector.publicIdentity, envelope, epoch: TEST_EPOCH })
  return { connector, client, state, dispatcher, disconnect, request, decode,
    call: async (operation, body, requestId) => decode(await dispatcher.handle(await request(operation, body, requestId))),
    tick: async (ms) => { t.mock.timers.tick(ms); await flush() } }
}

test("encrypted snapshot and unsolicited full replacements have independent correlation and no plaintext metadata", async (t) => {
  const f = await setup(t)
  for (const capability of PROJECT_MCP_CAPABILITIES) assert.ok(f.dispatcher.capabilities.includes(capability))
  const snapshotId = crypto.randomUUID()
  const snapshot = await f.call("project.mcp.snapshot", fixture.snapshotRequest, snapshotId)
  assert.equal(snapshot.requestId, snapshotId)
  assert.deepEqual(snapshot.body, fixture.snapshotResponse)
  assert.equal(snapshot.kind, "response")
  const requestId = crypto.randomUUID()
  const reply = await f.call("project.mcp.subscribe", fixture.subscribeRequest, requestId)
  assert.equal(reply.requestId, requestId)
  assert.deepEqual(reply.body, { ...fixture.update, revision: 0 })
  f.state.result = { ...fixture.snapshotResponse, servers: [{ name: "synthetic-changed-private-name", status: "failed" }] }
  await f.tick(3000); await waitFor(() => f.state.events.length === 1)
  const event = projectMcpUpdatedEventSchema.parse(await f.decode(f.state.events[0]))
  assert.equal(event.requestId, fixture.subscribeRequest.subscriptionId)
  assert.deepEqual(event.body, { ...fixture.subscribeRequest, ...f.state.result, revision: 1 })
  const wire = JSON.stringify(f.state.events[0])
  for (const privateField of [event.operation, event.body.servers[0].name, event.body.projectId, event.body.subscriptionId]) {
    assert.equal(wire.includes(privateField), false)
  }
  const stranger = (await generateConnectorIdentity()).identity
  await assert.rejects(decryptRelayEnvelope({ recipient: stranger, sender: f.connector.publicIdentity, envelope: f.state.events[0], epoch: TEST_EPOCH }))
  const renewed = await f.call("project.mcp.subscribe", fixture.subscribeRequest, requestId)
  assert.equal(renewed.requestId, requestId)
  assert.equal(renewed.body.revision, 2, "A new encrypted renewal is a fresh read, not the mutation journal")
  const stopped = await f.call("project.mcp.unsubscribe", fixture.subscribeRequest)
  assert.deepEqual(stopped.body, { version: 1, unsubscribed: true })
  const calls = f.state.calls
  await f.tick(60_000)
  assert.equal(f.state.calls, calls)
})

test("hostile bodies, versions, event markers and arbitrary MCP actions never reach the reader", async (t) => {
  const f = await setup(t)
  for (const operation of ["project.mcp.snapshot", "project.mcp.subscribe", "project.mcp.unsubscribe"]) {
    const body = operation === "project.mcp.snapshot" ? fixture.snapshotRequest : fixture.subscribeRequest
    for (const override of [{ version: 2 }, { projectId: "/secret" }, { directory: "/secret" }, { url: "https://secret.invalid" },
      { config: {} }, { args: [] }, { raw: {} }]) {
      assert.equal((await f.call(operation, { ...body, ...override })).body.code, "invalid_request")
    }
  }
  for (const operation of ["project.mcp.updated", "mcp.status", "mcp.connect", "mcp.auth", "tool.execute", "project.mcp.execute"]) {
    assert.equal((await f.call(operation, fixture.snapshotRequest)).body.code, "unsupported_operation")
  }
  const event = await f.request("project.mcp.subscribe", fixture.subscribeRequest, crypto.randomUUID(), f.client, "event")
  assert.equal((await f.decode(await f.dispatcher.handle(event))).body.code, "invalid_request")
  assert.equal(f.state.calls, 0)
})

test("MCP capability advertisement is independent of chat and disabled readers fail closed", async (t) => {
  const f = await setup(t, false)
  assert.deepEqual(f.dispatcher.capabilities, ["session.list", ...CONNECTOR_CREDENTIAL_CAPABILITIES])
  for (const operation of PROJECT_MCP_CAPABILITIES) {
    assert.equal((await f.call(operation, fixture.subscribeRequest)).body.code, "unsupported_operation")
  }
  assert.equal(f.state.calls, 0)
})

test("untrusted, tampered, expired, wrong-recipient and replayed encrypted subscriptions fail closed", async (t) => {
  const f = await setup(t)
  const stranger = (await generateConnectorIdentity()).identity
  assert.equal(await f.dispatcher.handle(await f.request("project.mcp.subscribe", fixture.subscribeRequest, crypto.randomUUID(), stranger)), undefined)
  const frame = await f.request("project.mcp.subscribe", fixture.subscribeRequest)
  for (const override of [{ sequence: frame.sequence + 1 }, { messageId: crypto.randomUUID() },
    { recipientKeyId: stranger.publicIdentity.keyId }, { expiresAt: Date.now() - 1 },
    { epoch: "f".repeat(43) }]) {
    assert.equal(await f.dispatcher.handle({ ...frame, ...override }), undefined)
  }
  assert.equal(f.state.calls, 0)
  assert.ok(await f.dispatcher.handle(frame))
  assert.equal(await f.dispatcher.handle(frame), undefined)
  assert.equal(f.state.calls, 1)
})

test("authorization failures, mismatched projects and native errors produce only safe encrypted outcomes", async (t) => {
  const f = await setup(t)
  for (const code of ["context_expired", "access_denied"]) {
    f.state.read = async () => { throw new ChatAccessError(code) }
    const response = await f.call("project.mcp.snapshot", fixture.snapshotRequest)
    assert.deepEqual(response.body, { code, message: "OpenCode could not complete the request" })
  }
  f.state.read = async () => ({ ...fixture.snapshotResponse, projectId: crypto.randomUUID() })
  assert.equal((await f.call("project.mcp.snapshot", fixture.snapshotRequest)).body.code, "access_denied")
  f.state.read = async () => { throw new Error("synthetic-private-native-error") }
  assert.deepEqual((await f.call("project.mcp.snapshot", fixture.snapshotRequest)).body,
    { ...fixture.snapshotRequest, state: "unavailable", servers: [] })
  f.state.read = undefined
  await f.call("project.mcp.subscribe", fixture.subscribeRequest)
  const foreign = { ...fixture.subscribeRequest, projectId: crypto.randomUUID() }
  for (const operation of ["project.mcp.subscribe", "project.mcp.unsubscribe"]) {
    assert.equal((await f.call(operation, foreign)).body.code, "access_denied")
  }
})

test("a subscription stream can update before its encrypted subscribe response without resetting revisions", async (t) => {
  const f = await setup(t)
  const frame = await f.request("project.mcp.subscribe", fixture.subscribeRequest)
  let release, blocked = false
  const gate = new Promise((resolve) => { release = resolve })
  const encrypt = crypto.subtle.encrypt
  t.mock.method(crypto.subtle, "encrypt", async function (...args) {
    const payload = JSON.parse(new TextDecoder().decode(args[2]))
    if (payload.kind === "response" && payload.operation === "project.mcp.subscribe" && payload.body.revision === 0) {
      blocked = true; await gate
    }
    return encrypt.apply(this, args)
  })
  const pending = f.dispatcher.handle(frame)
  await waitFor(() => blocked)
  f.state.result = { ...fixture.snapshotResponse, servers: [] }
  await f.tick(3000); await waitFor(() => f.state.events.length === 1)
  assert.equal((await f.decode(f.state.events[0])).body.revision, 1)
  release()
  assert.equal((await f.decode(await pending)).body.revision, 0)
  assert.equal((await f.call("project.mcp.subscribe", fixture.subscribeRequest)).body.revision, 2)
})

test("relay replacement drops decrypting requests and pending snapshots/subscribes from the old generation", async (t) => {
  const f = await setup(t)
  const stale = f.dispatcher.handle(await f.request("project.mcp.subscribe", fixture.subscribeRequest))
  f.disconnect()
  let disconnect = f.dispatcher.attachRelay(() => true)
  assert.equal(await stale, undefined)
  assert.equal(f.state.calls, 0)
  for (const operation of ["project.mcp.snapshot", "project.mcp.subscribe"]) {
    let release, signal
    f.state.read = (_, readSignal) => { signal = readSignal; return new Promise((resolve) => { release = resolve }) }
    const frame = await f.request(operation, operation === "project.mcp.snapshot" ? fixture.snapshotRequest : fixture.subscribeRequest)
    const pending = f.dispatcher.handle(frame)
    await waitFor(() => release)
    disconnect()
    disconnect = f.dispatcher.attachRelay(() => true)
    assert.equal(await pending, undefined)
    assert.equal(signal.aborted, true)
    release(fixture.snapshotResponse)
    await flush()
  }
  f.state.read = undefined
  assert.equal((await f.call("project.mcp.subscribe", fixture.subscribeRequest)).body.revision, 0)
  f.disconnect() // A stale cleanup callback must not dispose the new connection.
  assert.equal((await f.call("project.mcp.subscribe", fixture.subscribeRequest)).body.revision, 1)
})

test("events already encrypting cannot escape after unsubscribe or migrate to a new socket generation", async (t) => {
  const f = await setup(t)
  const encrypt = crypto.subtle.encrypt
  let release, blocked = false, completed = 0
  let gate = new Promise((resolve) => { release = resolve })
  t.mock.method(crypto.subtle, "encrypt", async function (...args) {
    const payload = JSON.parse(new TextDecoder().decode(args[2]))
    if (payload.kind === "event") { blocked = true; await gate }
    const result = await encrypt.apply(this, args)
    if (payload.kind === "event") completed++
    return result
  })
  for (const mode of ["unsubscribe", "reconnect"]) {
    f.state.result = fixture.snapshotResponse
    await f.call("project.mcp.subscribe", fixture.subscribeRequest)
    f.state.result = { ...fixture.snapshotResponse, servers: [] }
    await f.tick(3000); await waitFor(() => blocked)
    const nextEvents = []
    if (mode === "unsubscribe") await f.call("project.mcp.unsubscribe", fixture.subscribeRequest)
    else { f.disconnect(); f.dispatcher.attachRelay((event) => { nextEvents.push(event); return true }) }
    release(); await waitFor(() => completed === (mode === "unsubscribe" ? 1 : 2)); await flush()
    assert.equal(f.state.events.length, 0)
    assert.equal(nextEvents.length, 0)
    blocked = false; gate = new Promise((resolve) => { release = resolve })
  }
})

test("client disappearance expires its encrypted subscription while the connector remains attached", async (t) => {
  const f = await setup(t)
  await f.call("project.mcp.subscribe", fixture.subscribeRequest)
  await f.tick(59_999)
  const calls = f.state.calls
  await f.tick(1)
  f.state.result = { ...fixture.snapshotResponse, servers: [] }
  await f.tick(60_000)
  assert.equal(f.state.calls, calls)
  assert.equal(f.state.events.length, 0)
  assert.deepEqual((await f.call("project.mcp.snapshot", fixture.snapshotRequest)).body, f.state.result)
})

test("new relay attachments cannot bypass the shared cap on underlying reads ignoring cancellation", async (t) => {
  const f = await setup(t)
  const underlying = []
  f.state.read = (_, signal) => new Promise((resolve) => { underlying.push({ resolve, signal }) })
  t.after(() => { for (const operation of underlying) operation.resolve(fixture.snapshotResponse) })
  for (let attempt = 0; attempt < 4; attempt++) {
    const operation = attempt % 2 ? "project.mcp.subscribe" : "project.mcp.snapshot"
    const body = attempt % 2 ? fixture.subscribeRequest : fixture.snapshotRequest
    const pending = f.dispatcher.handle(await f.request(operation, body))
    await waitFor(() => underlying.length === attempt + 1)
    f.dispatcher.attachRelay(() => true)
    assert.equal(await pending, undefined)
    assert.equal(underlying[attempt].signal.aborted, true)
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    f.dispatcher.attachRelay(() => true)
    const subscribed = await f.call("project.mcp.subscribe", fixture.subscribeRequest)
    assert.deepEqual(subscribed.body, { ...fixture.subscribeRequest, state: "unavailable", servers: [], revision: 0 })
    assert.deepEqual((await f.call("project.mcp.snapshot", fixture.snapshotRequest)).body,
      { ...fixture.snapshotRequest, state: "unavailable", servers: [] })
    await f.tick(3000)
    assert.equal(f.state.calls, 4)
    assert.equal(underlying.length, 4)
  }
  f.dispatcher.attachRelay(() => true)
  underlying[0].resolve(fixture.snapshotResponse)
  await flush()
  f.state.read = undefined
  assert.deepEqual((await f.call("project.mcp.snapshot", fixture.snapshotRequest)).body, fixture.snapshotResponse)
  assert.equal(f.state.calls, 5)
  assert.equal(f.state.events.length, 0)
})
