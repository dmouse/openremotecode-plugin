import assert from "node:assert/strict"
import test from "node:test"

import {
  decryptRelayEnvelope,
  derivePairingSafetyCode,
  encryptRelayPayload,
  generateConnectorIdentity,
  generateNonExportableConnectorIdentity,
  signIdentityChallenge,
  verifyIdentityProof,
} from "../dist/index.js"

const CHALLENGE = "8dM-8L37KqTpsWp5jzpp27xUqE5iSILAXABZlQeUQ08"

test("non-exportable identities retain HPKE Auth interoperability", async () => {
  const sender = await generateNonExportableConnectorIdentity()
  const recipient = await generateNonExportableConnectorIdentity()

  await assert.rejects(crypto.subtle.exportKey("jwk", sender.privateKey))
  await assert.rejects(crypto.subtle.exportKey("jwk", sender.proofPrivateKey))

  const envelope = await encryptRelayPayload({
    sender,
    recipient: recipient.publicIdentity,
    payload: {
      protocolVersion: 2,
      kind: "request",
      requestId: crypto.randomUUID(),
      sentAt: 1_788_115_200_000,
      operation: "session.list",
      body: {},
    },
    epoch: "e".repeat(43),
    sequence: 0,
    now: 1_788_115_200_000,
  })
  const payload = await decryptRelayEnvelope({
    recipient,
    sender: sender.publicIdentity,
    envelope,
    epoch: "e".repeat(43),
    now: 1_788_115_200_000,
  })
  assert.equal(payload.operation, "session.list")
})

test("identity proof binds the challenge and public identity", async () => {
  const connector = await generateConnectorIdentity()
  const attacker = await generateConnectorIdentity()
  const proof = await signIdentityChallenge(connector.identity, CHALLENGE)

  assert.equal(
    await verifyIdentityProof(connector.identity.publicIdentity, proof),
    true,
  )
  assert.equal(
    await verifyIdentityProof(attacker.identity.publicIdentity, proof),
    false,
  )
})

test("pairing safety code is deterministic and role ordered", async () => {
  const connector = await generateConnectorIdentity()
  const device = await generateNonExportableConnectorIdentity()
  const transcript = {
    version: 1,
    serviceId: "local-development",
    pairingId: "par_0123456789abcdefghij",
    connectorIdentity: connector.identity.publicIdentity,
    deviceIdentity: device.publicIdentity,
  }
  const first = await derivePairingSafetyCode(transcript)
  const second = await derivePairingSafetyCode(transcript)
  const swapped = await derivePairingSafetyCode({
    ...transcript,
    connectorIdentity: device.publicIdentity,
    deviceIdentity: connector.identity.publicIdentity,
  })

  assert.match(first, /^(?:[0-9A-F]{4} ){5}[0-9A-F]{4}$/u)
  assert.equal(first, second)
  assert.notEqual(first, swapped)
})
