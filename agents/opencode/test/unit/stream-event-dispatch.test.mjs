import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import {
  decryptRelayEnvelope,
  encryptRelayPayload,
  generateConnectorIdentity,
  RELAY_PROTOCOL_VERSION,
} from "@openremotecode/protocol"
import { CommandDispatcher } from "../../dist/command-dispatcher.js"

const TEST_EPOCH = "e".repeat(43)
const PROJECT = "11111111-1111-4111-8111-111111111111"
const SUBSCRIPTION = "22222222-2222-4222-8222-222222222222"
const target = { version: 1, projectId: PROJECT, sessionId: "session", subscriptionId: SUBSCRIPTION }

function snapshot(text) {
  return {
    version: 1,
    chat: { id: "session", title: "Stream", updatedAt: 1000 },
    status: "busy",
    cursor: null,
    messages: [{ id: "message", role: "assistant", text, truncated: false }],
  }
}

/**
 * Drives the stream through CommandDispatcher rather than through ChatStreams directly.
 * The outgoing event payload is built inside attachRelay, so only a dispatcher-level test
 * covers it — ChatStreams tests supply their own emit callback and never touch it.
 *
 * Real timers deliberately: ChatStreams coalesces behind short timeouts and also arms a
 * ten-second subscription expiry, so a mocked clock either misses the update or expires
 * the subscription out from under it.
 */
async function setup(t) {
  const connector = await generateConnectorIdentity()
  const client = await generateConnectorIdentity()
  const state = { envelopes: [], changed: undefined, result: snapshot("hello") }
  const reader = {
    readChat: async () => state.result,
    watchChat: async (_target, signal, changed) => {
      state.changed = changed
      changed(false)
      await new Promise((resolve) => signal.addEventListener("abort", resolve))
    },
  }
  const dispatcher = new CommandDispatcher({
    connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity,
    sessions: { listSessions: async () => [] },
    stream: reader,
  })
  t.after(() => dispatcher.dispose())
  dispatcher.setEpoch(TEST_EPOCH)
  dispatcher.attachRelay((envelope) => { state.envelopes.push(envelope); return true })

  let sequence = 0
  const request = async (operation, body) => encryptRelayPayload({
    sender: client.identity,
    recipient: connector.identity.publicIdentity,
    payload: {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "request",
      requestId: crypto.randomUUID(),
      sentAt: Date.now(),
      operation,
      body,
    },
    epoch: TEST_EPOCH,
    sequence: sequence++,
  })
  const decode = (envelope) => decryptRelayEnvelope({
    recipient: client.identity,
    sender: connector.identity.publicIdentity,
    envelope,
    epoch: TEST_EPOCH,
  })
  const events = async () => {
    const payloads = await Promise.all(state.envelopes.map((envelope) => decode(envelope)))
    return payloads.filter((payload) => payload.kind === "event")
  }
  const waitForEvents = async (count) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await events()).length >= count) break
      await delay(25)
    }
    return events()
  }
  return { dispatcher, state, request, decode, events, waitForEvents }
}

test("a subscribed chat stream delivers an encrypted update to the client", async (t) => {
  const f = await setup(t)

  const subscribed = await f.dispatcher.handle(await f.request("chat.stream.subscribe", target))
  assert.ok(subscribed, "subscribe produced no response")
  assert.equal((await f.decode(subscribed)).operation, "chat.stream.subscribe")

  f.state.result = snapshot("streamed reply")
  f.state.changed?.(false)

  // The regression this guards: the event payload was built with a stale protocol version
  // literal, so schema validation threw before encryption and the update never reached the
  // phone even though OpenCode had already produced the answer locally.
  const events = await f.waitForEvents(1)
  assert.ok(events.length > 0, "no stream event reached the relay")
  const update = events.find((event) => event.operation === "chat.stream.updated")
  assert.ok(update, "no chat.stream.updated event was emitted")
  assert.equal(update.protocolVersion, RELAY_PROTOCOL_VERSION)
  assert.equal(update.requestId, SUBSCRIPTION)
  assert.equal(update.body.snapshot.messages[0].text, "streamed reply")
})

test("every dispatcher-built event carries the current protocol version", async (t) => {
  const f = await setup(t)
  await f.dispatcher.handle(await f.request("chat.stream.subscribe", target))

  for (const [index, text] of ["second", "third"].entries()) {
    f.state.result = snapshot(text)
    f.state.changed?.(false)
    await f.waitForEvents(index + 1)
  }

  const events = await f.events()
  assert.ok(events.length > 0, "no events were emitted")
  for (const event of events) {
    assert.equal(event.protocolVersion, RELAY_PROTOCOL_VERSION, `${event.operation} used a stale protocol version`)
    assert.equal(event.kind, "event")
    assert.match(event.operation, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u)
  }
})

test("a client that drops away does not end the subscription", async (t) => {
  const f = await setup(t)
  await f.dispatcher.handle(await f.request("chat.stream.subscribe", target))

  f.state.result = snapshot("while connected")
  f.state.changed?.(false)
  await f.waitForEvents(1)
  const delivered = (await f.events()).length

  // The client goes away: with no epoch the event cannot be encrypted. Reporting that as a
  // delivery failure would remove the subscription, and streaming would never resume —
  // the client would silently fall back to polling and only see completed responses.
  f.dispatcher.setEpoch(undefined)
  f.state.result = snapshot("while disconnected")
  f.state.changed?.(false)
  await delay(200)
  assert.equal((await f.events()).length, delivered, "an event was emitted with no client")

  // Reconnecting must resume streaming rather than require reopening the chat.
  f.dispatcher.setEpoch(TEST_EPOCH)
  f.state.result = snapshot("after reconnect")
  f.state.changed?.(false)
  const events = await f.waitForEvents(delivered + 1)
  assert.ok(events.length > delivered, "streaming did not resume after the client returned")
  const latest = events.filter((event) => event.operation === "chat.stream.updated").at(-1)
  assert.equal(latest.body.snapshot.messages[0].text, "after reconnect")
})
