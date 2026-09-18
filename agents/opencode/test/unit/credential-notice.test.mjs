import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import {
  CONNECTOR_CREDENTIAL_CAPABILITIES,
  CONNECTOR_CREDENTIAL_UPDATED_OPERATION,
  connectorCredentialUpdatedEventSchema,
  decryptRelayEnvelope,
  generateConnectorIdentity,
} from "@openremotecode/protocol"
import { CommandDispatcher } from "../../dist/command-dispatcher.js"

const EPOCH = "e".repeat(43)
const NEXT_EPOCH = "f".repeat(43)
// Real encryption runs between reporting and sending, so settle on the observed effect
// rather than on a fixed number of microtask turns.
const settled = async (sent, count) => {
  for (let attempt = 0; attempt < 40 && sent.length < count; attempt++) await delay(25)
  return sent.length
}
const quiet = () => delay(150)

async function setup(t) {
  const connector = await generateConnectorIdentity()
  const client = await generateConnectorIdentity()
  const sent = []
  const dispatcher = new CommandDispatcher({
    connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity,
    sessions: { listSessions: async () => [] },
  })
  t.after(() => dispatcher.dispose())
  const decode = async (envelope, epoch = EPOCH) => decryptRelayEnvelope({
    recipient: client.identity,
    sender: connector.identity.publicIdentity,
    envelope,
    epoch,
  })
  const notices = async (epoch = EPOCH) => {
    const payloads = await Promise.all(sent.map((envelope) => decode(envelope, epoch)))
    return payloads.filter((payload) => payload.operation === CONNECTOR_CREDENTIAL_UPDATED_OPERATION)
  }
  return { dispatcher, sent, notices, attach: () => dispatcher.attachRelay((envelope) => { sent.push(envelope); return true }) }
}

test("the capability is advertised even when no chat adapters are configured", async (t) => {
  const f = await setup(t)
  for (const capability of CONNECTOR_CREDENTIAL_CAPABILITIES) {
    assert.ok(f.dispatcher.capabilities.includes(capability))
  }
})

test("a renewal reported with no client attached is delivered when one connects", async (t) => {
  const f = await setup(t)
  f.attach()

  // Renewal runs when the plugin connects, which is usually before any phone is attached.
  f.dispatcher.reportCredentialRenewal("renewed")
  await quiet()
  assert.deepEqual(f.sent, [], "a notice was emitted with no connected client")

  f.dispatcher.setEpoch(EPOCH)
  await settled(f.sent, 1)
  const notices = await f.notices()
  assert.equal(notices.length, 1, "the buffered notice was not delivered on connect")
  const event = connectorCredentialUpdatedEventSchema.parse(notices[0])
  assert.equal(event.body.outcome, "renewed")
  assert.match(event.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
})

test("a delivered notice is not repeated when the client reconnects", async (t) => {
  const f = await setup(t)
  f.attach()
  f.dispatcher.setEpoch(EPOCH)
  f.dispatcher.reportCredentialRenewal("renewed")
  await settled(f.sent, 1)
  assert.equal((await f.notices()).length, 1)

  // A reconnect establishes a new epoch; the notice is spent and must not reappear.
  f.dispatcher.setEpoch(undefined)
  f.dispatcher.setEpoch(NEXT_EPOCH)
  await quiet()
  assert.equal(f.sent.length, 1, "a delivered notice was re-sent on reconnect")
})

test("an undelivered notice is replaced by a newer outcome rather than queued twice", async (t) => {
  const f = await setup(t)
  f.attach()

  f.dispatcher.reportCredentialRenewal("failed")
  f.dispatcher.reportCredentialRenewal("failed")
  f.dispatcher.reportCredentialRenewal("renewed")
  await quiet()

  f.dispatcher.setEpoch(EPOCH)
  await settled(f.sent, 1)
  const notices = await f.notices()
  assert.equal(notices.length, 1, "queued notices stacked up while offline")
  assert.equal(notices[0].body.outcome, "renewed", "the client was told a stale outcome")
})

test("a failure is reported to the client, not only to the local log", async (t) => {
  const f = await setup(t)
  f.attach()
  f.dispatcher.setEpoch(EPOCH)
  f.dispatcher.reportCredentialRenewal("failed")
  await settled(f.sent, 1)

  const notices = await f.notices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].body.outcome, "failed")
  // Nothing about the credential itself may ride along.
  assert.deepEqual(Object.keys(notices[0].body).sort(), ["occurredAt", "outcome", "version"])
})

test("a notice survives a relay rebind and is delivered on the next attachment", async (t) => {
  const f = await setup(t)
  f.dispatcher.setEpoch(EPOCH)
  f.dispatcher.reportCredentialRenewal("renewed")
  await quiet()
  assert.deepEqual(f.sent, [], "a notice was emitted with no relay bound")

  f.attach()
  await settled(f.sent, 1)
  assert.equal((await f.notices()).length, 1, "the notice was lost across the rebind")
})
