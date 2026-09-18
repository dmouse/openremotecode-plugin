import assert from "node:assert/strict"
import test from "node:test"

import {
  generateConnectorIdentity,
  decryptRelayEnvelope,
  encryptRelayPayload,
} from "@openremotecode/protocol"

const NOW = 1_788_115_200_000
const TEST_EPOCH = "e".repeat(43)

test("HPKE Auth encrypts a relay payload for the intended recipient", async () => {
  const sender = await generateConnectorIdentity(NOW)
  const recipient = await generateConnectorIdentity(NOW)
  const payload = createPayload({ text: "private integration message" })

  const envelope = await encryptRelayPayload({
    sender: sender.identity,
    recipient: recipient.identity.publicIdentity,
    payload,
    epoch: TEST_EPOCH,
    sequence: 7,
    now: NOW,
  })

  assert.equal(envelope.senderKeyId, sender.identity.publicIdentity.keyId)
  assert.equal(envelope.recipientKeyId, recipient.identity.publicIdentity.keyId)
  assert.equal(JSON.stringify(envelope).includes(payload.body.text), false)
  assert.equal(JSON.stringify(envelope).includes(payload.operation), false)

  const decrypted = await decryptRelayEnvelope({
    recipient: recipient.identity,
    sender: sender.identity.publicIdentity,
    envelope,
    epoch: TEST_EPOCH,
    now: NOW,
  })
  assert.deepEqual(decrypted, payload)
})

test("authenticated outer metadata cannot be modified", async () => {
  const sender = await generateConnectorIdentity(NOW)
  const recipient = await generateConnectorIdentity(NOW)
  const envelope = await encryptRelayPayload({
    sender: sender.identity,
    recipient: recipient.identity.publicIdentity,
    payload: createPayload({ text: "tamper test" }),
    epoch: TEST_EPOCH,
    sequence: 1,
    now: NOW,
  })
  const modified = {
    ...envelope,
    messageId: crypto.randomUUID(),
  }

  await assert.rejects(
    decryptRelayEnvelope({
      recipient: recipient.identity,
      sender: sender.identity.publicIdentity,
      envelope: modified,
      epoch: TEST_EPOCH,
      now: NOW,
    }),
  )
})

test("a different authenticated sender cannot decrypt as the trusted sender", async () => {
  const sender = await generateConnectorIdentity(NOW)
  const attacker = await generateConnectorIdentity(NOW)
  const recipient = await generateConnectorIdentity(NOW)
  const envelope = await encryptRelayPayload({
    sender: sender.identity,
    recipient: recipient.identity.publicIdentity,
    payload: createPayload({ text: "sender authentication" }),
    epoch: TEST_EPOCH,
    sequence: 2,
    now: NOW,
  })
  const relabeled = {
    ...envelope,
    senderKeyId: attacker.identity.publicIdentity.keyId,
  }

  await assert.rejects(
    decryptRelayEnvelope({
      recipient: recipient.identity,
      sender: attacker.identity.publicIdentity,
      envelope: relabeled,
      epoch: TEST_EPOCH,
      now: NOW,
    }),
  )
})

test("expired envelopes are rejected before plaintext is returned", async () => {
  const sender = await generateConnectorIdentity(NOW)
  const recipient = await generateConnectorIdentity(NOW)
  const envelope = await encryptRelayPayload({
    sender: sender.identity,
    recipient: recipient.identity.publicIdentity,
    payload: createPayload({ text: "expired" }),
    epoch: TEST_EPOCH,
    sequence: 3,
    now: NOW,
    ttlMs: 1_000,
  })

  await assert.rejects(
    decryptRelayEnvelope({
      recipient: recipient.identity,
      sender: sender.identity.publicIdentity,
      envelope,
      epoch: TEST_EPOCH,
      now: NOW + 1_000,
    }),
    /expired/u,
  )
})

test("invalid inner operations fail schema validation before encryption", async () => {
  const sender = await generateConnectorIdentity(NOW)
  const recipient = await generateConnectorIdentity(NOW)

  await assert.rejects(
    encryptRelayPayload({
      sender: sender.identity,
      recipient: recipient.identity.publicIdentity,
      payload: {
        ...createPayload({}),
        operation: "shell execute",
      },
      epoch: TEST_EPOCH,
      sequence: 4,
      now: NOW,
    }),
  )
})

function createPayload(body) {
  return {
    protocolVersion: 2,
    kind: "request",
    requestId: crypto.randomUUID(),
    sentAt: NOW,
    operation: "session.list",
    body,
  }
}
